-- =============================================================================
-- Migration: Sales Reports (FlowSales AI — laporan harian sales)
-- Model hybrid: laporan diinput manual oleh sales; bila data sales_orders
-- tersedia untuk sales+tanggal yang sama, aplikasi menampilkan perbandingan.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- sales_reports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_reports (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  salesperson_id         UUID          NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  report_date            DATE          NOT NULL,
  area                   VARCHAR(100),
  target_oa              INTEGER       NOT NULL DEFAULT 0 CHECK (target_oa >= 0),
  achieved_oa            INTEGER       NOT NULL DEFAULT 0 CHECK (achieved_oa >= 0),
  target_revenue         NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (target_revenue >= 0),
  achieved_revenue       NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (achieved_revenue >= 0),
  remaining_working_days INTEGER       NOT NULL DEFAULT 0 CHECK (remaining_working_days >= 0),
  discount_amount        NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total_value            NUMERIC(15,2) NOT NULL DEFAULT 0,
  grand_total            NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes                  TEXT,
  ai_summary             TEXT,
  created_by             UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, salesperson_id, report_date)
);

CREATE INDEX idx_sales_reports_company_id     ON public.sales_reports (company_id);
CREATE INDEX idx_sales_reports_salesperson_id ON public.sales_reports (salesperson_id);
CREATE INDEX idx_sales_reports_report_date    ON public.sales_reports (company_id, report_date);

CREATE TRIGGER trg_sales_reports_updated_at
  BEFORE UPDATE ON public.sales_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE  public.sales_reports IS 'Laporan harian sales: target vs pencapaian OA & omzet';
COMMENT ON COLUMN public.sales_reports.target_oa   IS 'Target outlet aktif (OA) hari itu';
COMMENT ON COLUMN public.sales_reports.total_value IS 'Jumlah nilai seluruh item terjual';
COMMENT ON COLUMN public.sales_reports.grand_total IS 'total_value dikurangi discount_amount';

-- ---------------------------------------------------------------------------
-- sales_report_items
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_report_items (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_report_id       UUID          NOT NULL REFERENCES public.sales_reports (id) ON DELETE CASCADE,
  product_id            UUID          REFERENCES public.products (id) ON DELETE SET NULL,
  product_name_snapshot VARCHAR(255)  NOT NULL,
  quantity              NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit                  VARCHAR(50)   NOT NULL DEFAULT 'pcs',
  value                 NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (value >= 0)
);

CREATE INDEX idx_sales_report_items_report_id ON public.sales_report_items (sales_report_id);

COMMENT ON COLUMN public.sales_report_items.product_name_snapshot IS 'Nama produk saat laporan dibuat; product_id boleh NULL untuk produk di luar master';

-- ---------------------------------------------------------------------------
-- Permissions (module reports sudah ada; tambah aksi create/update)
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('reports.create', 'reports', 'create', 'Create daily sales reports'),
  ('reports.update', 'reports', 'update', 'Update daily sales reports')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name IN ('owner','manager','admin','sales') AND r.is_system_role = TRUE
  AND p.name IN ('reports.create','reports.update')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row Level Security (pola sama dengan sales_orders)
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_reports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_report_items ENABLE ROW LEVEL SECURITY;

-- Sales hanya melihat laporannya sendiri; owner/manager/admin/finance melihat semua
CREATE POLICY "sales_reports_select" ON public.sales_reports
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('reports.manage')
      OR salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','admin','finance','super_admin'])
    )
  );

CREATE POLICY "sales_reports_insert" ON public.sales_reports
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('reports.create')
    AND (
      salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
    )
  );

CREATE POLICY "sales_reports_update" ON public.sales_reports
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('reports.manage')
      OR (salesperson_id = auth.uid() AND public.user_has_permission('reports.update'))
    )
  );

CREATE POLICY "sales_reports_delete" ON public.sales_reports
  FOR DELETE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('reports.manage')
  );

-- Items mengikuti akses parent report
CREATE POLICY "sales_report_items_select" ON public.sales_report_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.sales_reports sr
      WHERE sr.id = sales_report_id
        AND sr.company_id = public.get_user_company_id()
        AND (
          public.user_has_permission('reports.manage')
          OR sr.salesperson_id = auth.uid()
          OR public.user_has_role(ARRAY['owner','manager','admin','finance','super_admin'])
        )
    )
  );

CREATE POLICY "sales_report_items_insert" ON public.sales_report_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales_reports sr
      WHERE sr.id = sales_report_id
        AND sr.company_id = public.get_user_company_id()
        AND (
          public.user_has_permission('reports.manage')
          OR sr.salesperson_id = auth.uid()
          OR public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
        )
    )
  );

CREATE POLICY "sales_report_items_update" ON public.sales_report_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.sales_reports sr
      WHERE sr.id = sales_report_id
        AND sr.company_id = public.get_user_company_id()
        AND (
          public.user_has_permission('reports.manage')
          OR sr.salesperson_id = auth.uid()
        )
    )
  );

CREATE POLICY "sales_report_items_delete" ON public.sales_report_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.sales_reports sr
      WHERE sr.id = sales_report_id
        AND sr.company_id = public.get_user_company_id()
        AND (
          public.user_has_permission('reports.manage')
          OR sr.salesperson_id = auth.uid()
        )
    )
  );
