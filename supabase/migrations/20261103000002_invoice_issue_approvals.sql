-- =============================================================================
-- K-2 Persetujuan Owner untuk invoice bernilai besar.
-- Rancangan: docs/product/customer-classification/AODP_CUSTOMER_CLASSIFICATION_DESIGN.md
--
-- Bila klasifikasi customer punya approval_threshold_amount dan nilai invoice
-- melebihi ambang itu, invoice hanya bisa terbit setelah ada persetujuan Owner
-- (invoice_issue_approvals.status = 'approved' untuk order tsb). Ambang NULL =
-- tidak ada persetujuan (perilaku lama). Penegakan di DB (trigger BEFORE INSERT
-- invoices) supaya tidak bisa dilewati; issue_invoice_atomic TIDAK diubah.
-- Penulisan tabel hanya lewat server action (service_role).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.invoice_issue_approvals (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id   UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  amount           NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  threshold_amount NUMERIC(15,2) NOT NULL CHECK (threshold_amount >= 0),
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by     UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  requested_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  decided_by       UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ   NULL,
  decision_note    TEXT          NULL,
  CONSTRAINT invoice_issue_approvals_decided_chk
    CHECK ((status = 'pending' AND decided_at IS NULL) OR (status <> 'pending' AND decided_at IS NOT NULL))
);

-- Satu permintaan berjalan (pending) per order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_issue_approvals_pending
  ON public.invoice_issue_approvals (sales_order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_invoice_issue_approvals_company_status
  ON public.invoice_issue_approvals (company_id, status, requested_at DESC);

ALTER TABLE public.invoice_issue_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_issue_approvals_select" ON public.invoice_issue_approvals
  FOR SELECT USING (company_id = public.get_user_company_id());
-- Tanpa policy tulis: hanya service_role (server action).

CREATE OR REPLACE FUNCTION public.enforce_invoice_issue_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_threshold NUMERIC(15,2);
BEGIN
  SELECT cc.approval_threshold_amount INTO v_threshold
  FROM public.customers c
  JOIN public.customer_classes cc ON cc.id = c.class_id AND cc.company_id = c.company_id
  WHERE c.id = NEW.customer_id AND c.company_id = NEW.company_id;

  IF v_threshold IS NULL OR NEW.total_amount <= v_threshold THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.invoice_issue_approvals a
    WHERE a.company_id = NEW.company_id
      AND a.sales_order_id = NEW.sales_order_id
      AND a.status = 'approved'
  ) THEN
    RAISE EXCEPTION 'INVOICE_APPROVAL_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoices_enforce_approval
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_issue_approval();
