-- ---------------------------------------------------------------------------
-- Add province to customers table (mirrors 20260626000010_customers_city_notes.sql)
-- Needed for real ERP customer imports that carry Provinsi alongside Kota.
-- ---------------------------------------------------------------------------

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS province VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_customers_province ON public.customers (company_id, province);

COMMENT ON COLUMN public.customers.province IS 'Provinsi pelanggan/reseller';
