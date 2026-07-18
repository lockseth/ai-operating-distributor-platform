-- =============================================================================
-- Legacy Data Onboarding & Import Foundation — schema (LANGKAH 2-4).
--
-- Locked principle: klien tidak wajib re-entry data existing. Import bersifat
-- tenant-scoped, staged (dry-run/preview sebelum commit), dedup-aware,
-- idempotent by legacy_id, audited, dan bisa di-rollback secara aman. Import
-- TIDAK PERNAH memicu workflow operasional baru (dispatch/delivery/alert),
-- tidak mengirim owner_alerts, dan tidak dihitung sebagai achievement periode
-- berjalan (lihat commit_import_batch di migration berikutnya).
--
-- Audit menemukan modul import_templates/import_jobs (migration
-- 20260626000006) sudah ada tapi sempit: entity_type union hardcoded 3 nilai,
-- tidak ada staging per-baris, rollback tidak diimplementasi, tidak ada file
-- storage. Modul itu dibiarkan apa adanya (tidak disentuh) untuk use-case-nya
-- saat ini -- foundation baru ini (import_batches/import_batch_rows) dibangun
-- terpisah dan generik untuk 5 domain MVP: CUSTOMER_PIC, PRODUCT_PRICE,
-- OPEN_AR, OPEN_ORDER, HISTORICAL_ORDER.
--
-- invoices/payments/AR/receivables TIDAK ADA schema native sama sekali di
-- codebase ini (dikonfirmasi via audit) -- legacy_ar_invoices di bawah adalah
-- baseline AR-lama MINIMAL (bukan invoicing engine, bukan modul collection),
-- persis field yang diminta domain OPEN_AR, ditandai historical, tanpa
-- workflow apa pun menempel padanya.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Legacy tracking columns (additive) -- setiap top-level imported entity bisa
-- dilacak lewat company_id + source_system + legacy_id + import_batch_id.
-- Anak-baris (sales_order_items) TIDAK diberi kolom ini sendiri -- id-nya
-- melekat pada parent sales_orders.
-- ---------------------------------------------------------------------------

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS legacy_source_system VARCHAR(100),
  ADD COLUMN IF NOT EXISTS legacy_id             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS import_batch_id       UUID,
  ADD COLUMN IF NOT EXISTS imported_at           TIMESTAMPTZ;

ALTER TABLE public.customer_pics
  ADD COLUMN IF NOT EXISTS legacy_source_system VARCHAR(100),
  ADD COLUMN IF NOT EXISTS legacy_id             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS import_batch_id       UUID,
  ADD COLUMN IF NOT EXISTS imported_at           TIMESTAMPTZ;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS legacy_source_system VARCHAR(100),
  ADD COLUMN IF NOT EXISTS legacy_id             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS import_batch_id       UUID,
  ADD COLUMN IF NOT EXISTS imported_at           TIMESTAMPTZ;

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS legacy_source_system VARCHAR(100),
  ADD COLUMN IF NOT EXISTS legacy_id             VARCHAR(255),
  ADD COLUMN IF NOT EXISTS import_batch_id       UUID,
  ADD COLUMN IF NOT EXISTS imported_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_historical         BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.sales_orders.is_historical IS
  'TRUE untuk order hasil Legacy Import (OPEN_ORDER/HISTORICAL_ORDER) -- tidak pernah dihitung sebagai achievement periode berjalan, tidak memicu dispatch/delivery baru.';

-- Field legacy-only pada line item: sisa quantity yang belum terkirim per
-- snapshot sistem lama (informational baseline, BUKAN bagian dari invariant
-- delivery_items yang live -- tidak ada delivery/dispatch yang dibuat untuk
-- baris ini).
ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS legacy_outstanding_quantity NUMERIC(15,3);

COMMENT ON COLUMN public.sales_order_items.legacy_outstanding_quantity IS
  'Hanya diisi untuk baris hasil Legacy Import domain OPEN_ORDER -- snapshot quantity belum terkirim dari sistem lama. Tidak terhubung ke invariant delivery_items (tidak ada delivery yang dibuat untuk data historis).';

-- Dedup key: legacy_id unik per company+source_system+entity, tapi hanya
-- ketika legacy_id diisi (kebanyakan baris non-import tidak punya legacy_id).
CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_legacy
  ON public.customers (company_id, legacy_source_system, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_pics_legacy
  ON public.customer_pics (company_id, legacy_source_system, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_products_legacy
  ON public.products (company_id, legacy_source_system, legacy_id)
  WHERE legacy_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_orders_legacy
  ON public.sales_orders (company_id, legacy_source_system, legacy_id)
  WHERE legacy_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- import_batches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_batches (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  import_type         VARCHAR(30)   NOT NULL CHECK (import_type IN (
                        'CUSTOMER_PIC', 'PRODUCT_PRICE', 'OPEN_AR', 'OPEN_ORDER', 'HISTORICAL_ORDER'
                      )),
  source_system       VARCHAR(100)  NOT NULL,
  original_filename    VARCHAR(500)  NOT NULL,
  file_hash            VARCHAR(64)   NOT NULL, -- sha256 hex dari isi file, untuk deteksi file sama
  status               VARCHAR(20)   NOT NULL DEFAULT 'UPLOADED' CHECK (status IN (
                        'UPLOADED', 'MAPPED', 'VALIDATED', 'READY_TO_COMMIT',
                        'COMMITTED', 'FAILED', 'ROLLED_BACK'
                      )),
  column_mappings      JSONB         NOT NULL DEFAULT '[]',
  total_rows           INTEGER       NOT NULL DEFAULT 0,
  valid_rows           INTEGER       NOT NULL DEFAULT 0,
  warning_rows         INTEGER       NOT NULL DEFAULT 0,
  error_rows           INTEGER       NOT NULL DEFAULT 0,
  duplicate_rows       INTEGER       NOT NULL DEFAULT 0,
  reconciliation        JSONB         NOT NULL DEFAULT '{}', -- {sourceTotal, importTotal, difference, toleranceUsed}
  commit_result         JSONB         NOT NULL DEFAULT '{}', -- {createdCount, updatedCount, skippedCount, failedRow?}
  failure_reason        TEXT,
  rollback_reason        TEXT,
  created_by            UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  mapped_at              TIMESTAMPTZ,
  validated_at            TIMESTAMPTZ,
  committed_at            TIMESTAMPTZ,
  rolled_back_at          TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_batches_company_id ON public.import_batches (company_id, created_at DESC);
CREATE INDEX idx_import_batches_status     ON public.import_batches (company_id, status);
CREATE INDEX idx_import_batches_file_hash  ON public.import_batches (company_id, import_type, file_hash);

CREATE TRIGGER trg_import_batches_updated_at
  BEFORE UPDATE ON public.import_batches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.import_batches IS
  'Satu baris = satu upaya import (satu file). Status flow: UPLOADED -> MAPPED -> VALIDATED -> READY_TO_COMMIT -> COMMITTED|FAILED|ROLLED_BACK.';
COMMENT ON COLUMN public.import_batches.file_hash IS
  'sha256(file content) -- dipakai app-level untuk peringatan "file yang sama sudah pernah di-commit", bukan hard-block (retry batch FAILED/ROLLED_BACK dengan file sama harus tetap bisa).';

-- ---------------------------------------------------------------------------
-- import_batch_rows (staging)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_batch_rows (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id               UUID         NOT NULL REFERENCES public.import_batches (id) ON DELETE CASCADE,
  company_id             UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE, -- denormalized untuk RLS langsung
  row_number              INTEGER      NOT NULL,
  raw_data                JSONB        NOT NULL,
  normalized_data          JSONB        NOT NULL DEFAULT '{}',
  validation_status         VARCHAR(20)  NOT NULL DEFAULT 'ERROR' CHECK (validation_status IN (
                            'VALID', 'WARNING', 'DUPLICATE', 'ERROR'
                          )),
  errors                    JSONB        NOT NULL DEFAULT '[]', -- [{field, message}]
  warnings                  JSONB        NOT NULL DEFAULT '[]',
  detected_existing_id       UUID,
  proposed_action            VARCHAR(20)  NOT NULL DEFAULT 'NEEDS_REVIEW' CHECK (proposed_action IN (
                            'CREATE', 'UPDATE', 'SKIP_DUPLICATE', 'NEEDS_REVIEW'
                          )),
  row_hash                   VARCHAR(64)  NOT NULL,
  committed_entity_id         UUID,
  committed_entity_table       VARCHAR(50),
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, row_number)
);

CREATE INDEX idx_import_batch_rows_batch_id ON public.import_batch_rows (batch_id, row_number);
CREATE INDEX idx_import_batch_rows_company  ON public.import_batch_rows (company_id);
CREATE INDEX idx_import_batch_rows_status   ON public.import_batch_rows (batch_id, validation_status);

COMMENT ON TABLE public.import_batch_rows IS
  'Staging per-baris -- disimpan SEBELUM commit supaya preview/validasi/reconciliation bisa dilakukan tanpa menyentuh tabel live.';

-- ---------------------------------------------------------------------------
-- legacy_ar_invoices -- baseline AR-lama minimal (LANGKAH 2 domain C).
-- Bukan invoicing engine: tidak ada dunning/reminder/collection workflow,
-- hanya baris opening-balance per invoice legacy, dengan riwayat pembayaran
-- teragregasi (amount_paid), bukan ledger pembayaran per transaksi.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.legacy_ar_invoices (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id            UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  legacy_invoice_number   VARCHAR(100)  NOT NULL,
  invoice_date            DATE          NOT NULL,
  due_date                 DATE,
  original_amount          NUMERIC(15,2) NOT NULL CHECK (original_amount >= 0),
  amount_paid               NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  outstanding_balance        NUMERIC(15,2) NOT NULL CHECK (outstanding_balance >= 0),
  payment_terms              VARCHAR(100),
  assigned_sales_id           UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  is_historical                BOOLEAN       NOT NULL DEFAULT TRUE,
  legacy_source_system         VARCHAR(100)  NOT NULL,
  legacy_id                     VARCHAR(255)  NOT NULL,
  import_batch_id                UUID          REFERENCES public.import_batches (id) ON DELETE SET NULL,
  imported_at                     TIMESTAMPTZ,
  created_by                      UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ar_balance CHECK (outstanding_balance = original_amount - amount_paid),
  UNIQUE (company_id, legacy_source_system, legacy_id)
);

CREATE INDEX idx_legacy_ar_invoices_company_id  ON public.legacy_ar_invoices (company_id);
CREATE INDEX idx_legacy_ar_invoices_customer_id ON public.legacy_ar_invoices (customer_id);
CREATE INDEX idx_legacy_ar_invoices_batch_id    ON public.legacy_ar_invoices (import_batch_id);

CREATE TRIGGER trg_legacy_ar_invoices_updated_at
  BEFORE UPDATE ON public.legacy_ar_invoices
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.legacy_ar_invoices IS
  'Baseline AR-lama hasil Legacy Import -- BUKAN modul invoicing/collection penuh (belum ada di AODP). Hanya field yang diminta domain OPEN_AR. is_historical selalu TRUE, tidak pernah memicu owner_alerts/dispatch.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.import_batches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batch_rows   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legacy_ar_invoices  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_batches_select" ON public.import_batches
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- INSERT/UPDATE dilakukan oleh server action lewat admin client (service_role)
-- setelah permission check di app layer -- tidak ada policy authenticated
-- INSERT/UPDATE di sini (mirror pola owner_alerts: outbox/batch-state hanya
-- ditulis server-side, tidak langsung oleh client).

CREATE POLICY "import_batch_rows_select" ON public.import_batch_rows
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "legacy_ar_invoices_select" ON public.legacy_ar_invoices
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- Permissions baru -- Salesman TIDAK PERNAH mendapat permission import.* apa
-- pun (BATASAN: "Salesman tidak boleh menjalankan bulk import").
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('imports.view',     'imports', 'view',     'Lihat daftar dan detail import batch'),
  ('imports.execute',  'imports', 'execute',  'Upload file, mapping kolom, validasi (dry-run/preview)'),
  ('imports.commit',   'imports', 'commit',   'Commit import batch ke data live'),
  ('imports.rollback', 'imports', 'rollback', 'Rollback import batch yang sudah di-commit')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner','manager','admin','super_admin')
  AND p.name IN ('imports.view','imports.execute','imports.commit','imports.rollback')
ON CONFLICT DO NOTHING;
