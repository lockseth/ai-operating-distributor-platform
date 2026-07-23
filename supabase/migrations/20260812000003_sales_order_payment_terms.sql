-- =============================================================================
-- Sales Order Payment Terms (Termin Pembayaran) -- canonical source untuk
-- panel "KETENTUAN PEMBAYARAN" pada Document Engine (PO/Invoice).
--
-- ADDITIVE ONLY -- tidak mengubah migration/kolom/constraint yang sudah ada.
--
-- Aturan bisnis (LOCKED per instruksi Founder 2026-07-23):
--   - payment_terms_days NULL diperbolehkan untuk order historis/lama yang
--     belum pernah melalui alur input termin ini.
--   - Bila diisi, WAJIB > 0 (bukan 0, bukan negatif) -- ditegakkan CHECK
--     constraint di database, bukan hanya validasi aplikasi.
--   - Diisi eksplisit saat order dibuat/dikonfirmasi (alur input terpisah,
--     DI LUAR scope migration ini -- lihat Document Engine issuance gate).
--   - Setelah order confirmed, perubahan nilai ini harus lewat workflow
--     revisi/audit terpisah -- migration ini HANYA menambah kolom, tidak
--     menambah trigger immutability (belum ada spesifikasi revisi resmi).
--   - Document Engine (lib/document-engine) WAJIB menolak issuance PO/Invoice
--     dengan PAYMENT_TERMS_INCOMPLETE bila kolom ini NULL -- ditegakkan di
--     application layer (repository-adapter.ts), BUKAN di migration ini.
-- =============================================================================

ALTER TABLE public.sales_orders
  ADD COLUMN payment_terms_days INTEGER NULL;

ALTER TABLE public.sales_orders
  ADD CONSTRAINT chk_sales_orders_payment_terms_days_positive
  CHECK (payment_terms_days IS NULL OR payment_terms_days > 0);

COMMENT ON COLUMN public.sales_orders.payment_terms_days IS
  'Termin pembayaran dalam hari. NULL untuk order historis. Bila diisi wajib > 0. Diisi eksplisit saat order dibuat/dikonfirmasi -- Document Engine menolak issuance PO/Invoice (PAYMENT_TERMS_INCOMPLETE) bila NULL.';
