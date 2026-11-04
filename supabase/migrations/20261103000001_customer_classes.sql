-- =============================================================================
-- K-1 Klasifikasi Customer (tempo default per klasifikasi).
-- Rancangan: docs/product/customer-classification/AODP_CUSTOMER_CLASSIFICATION_DESIGN.md
--
-- customer_classes: klasifikasi per company (Besar/Grosir/Eceran, dst) membawa
-- tempo bayar default dan (disiapkan untuk irisan K-2) ambang persetujuan Owner.
-- customers.class_id nullable -> customer lama tidak berubah perilakunya.
--
-- Penulisan HANYA lewat server action (service_role, permission dicek di app).
-- Trigger menolak perubahan customers.class_id oleh user login langsung (sales
-- punya hak update toko miliknya via RLS -- klasifikasi menentukan tempo/harga,
-- tidak boleh bisa diubah sales).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.customer_classes (
  id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name                        VARCHAR(100)  NOT NULL,
  default_payment_terms_days  INTEGER       NULL CHECK (default_payment_terms_days IS NULL OR default_payment_terms_days >= 1),
  approval_threshold_amount   NUMERIC(15,2) NULL CHECK (approval_threshold_amount IS NULL OR approval_threshold_amount >= 0),
  is_active                   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_by                  UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_classes_company_name
  ON public.customer_classes (company_id, lower(name));

CREATE TRIGGER trg_customer_classes_updated_at
  BEFORE UPDATE ON public.customer_classes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.customer_classes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_classes_select" ON public.customer_classes
  FOR SELECT USING (company_id = public.get_user_company_id());
-- Tanpa policy INSERT/UPDATE/DELETE: hanya service_role (server action) yang menulis.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS class_id UUID NULL REFERENCES public.customer_classes (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_customers_class_id ON public.customers (class_id);

CREATE OR REPLACE FUNCTION public.guard_customer_class_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- auth.uid() NULL = service_role / koneksi server; user login langsung tidak boleh.
  IF auth.uid() IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND NEW.class_id IS NOT NULL THEN
      RAISE EXCEPTION 'CUSTOMER_CLASS_FORBIDDEN' USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND NEW.class_id IS DISTINCT FROM OLD.class_id THEN
      RAISE EXCEPTION 'CUSTOMER_CLASS_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_customers_guard_class
  BEFORE INSERT OR UPDATE OF class_id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_class_change();
