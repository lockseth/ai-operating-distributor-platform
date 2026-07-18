-- =============================================================================
-- Order Channel Scope Correction
--
-- Arsitektur final: Telegram adalah SATU-SATUNYA channel input order ke
-- sistem. Toko boleh menyampaikan pesanan ke Salesman lewat WhatsApp/telepon,
-- tapi Salesman-lah yang memasukkan order tsb ke AODP melalui Telegram — ini
-- bukan channel inbound customer/WhatsApp/telephony langsung ke sistem.
--
-- 1. Sempitkan sales_orders.source_channel: hapus nilai placeholder
--    'whatsapp' yang tersisa dari desain awal sebelum koreksi ini — tidak
--    pernah ada baris yang memakainya (tidak ada integrasi WhatsApp inbound
--    yang pernah dibangun), jadi aman disempitkan tanpa migrasi data.
-- 2. Tambah sales_orders.order_source: klasifikasi BAGAIMANA toko
--    menyampaikan pesanan kepada Salesman (bukan channel sistem — source_
--    channel tetap 'telegram'/'manual'). Nilai: FIELD_VISIT,
--    CUSTOMER_WHATSAPP, CUSTOMER_PHONE, REPEAT_ORDER, OTHER.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sales_orders WHERE source_channel = 'whatsapp'
  ) THEN
    RAISE EXCEPTION
      'Cannot narrow source_channel: rows with source_channel=whatsapp exist. Review manually.';
  END IF;
END;
$$;

ALTER TABLE public.sales_orders
  DROP CONSTRAINT IF EXISTS sales_orders_source_channel_check;

ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_source_channel_check
  CHECK (source_channel IN ('manual', 'telegram'));

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS order_source VARCHAR(30) NOT NULL DEFAULT 'OTHER'
    CHECK (order_source IN (
      'FIELD_VISIT',
      'CUSTOMER_WHATSAPP',
      'CUSTOMER_PHONE',
      'REPEAT_ORDER',
      'OTHER'
    ));

COMMENT ON COLUMN public.sales_orders.order_source IS
  'Bagaimana toko menyampaikan pesanan KEPADA SALESMAN (bukan channel input sistem — itu tetap source_channel). Order tetap masuk sistem hanya lewat Telegram Salesman.';
