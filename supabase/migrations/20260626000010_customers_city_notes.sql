-- ---------------------------------------------------------------------------
-- Add city + notes + avg_order_interval_days to customers table
-- ---------------------------------------------------------------------------

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS city                   VARCHAR(100),
  ADD COLUMN IF NOT EXISTS notes                  TEXT,
  ADD COLUMN IF NOT EXISTS avg_order_interval_days INTEGER;

CREATE INDEX IF NOT EXISTS idx_customers_city ON public.customers (company_id, city);

COMMENT ON COLUMN public.customers.city                    IS 'Kota pelanggan/reseller';
COMMENT ON COLUMN public.customers.notes                   IS 'Catatan internal tentang pelanggan';
COMMENT ON COLUMN public.customers.avg_order_interval_days IS 'Rata-rata interval order dalam hari (auto-computed or manual)';
