-- =============================================================================
-- Document line order determinism -- sales_order_items dan delivery_items TIDAK
-- punya kolom apa pun yang menangkap urutan baris asli (id UUID acak, tidak ada
-- created_at/line_number). Query yang membaca baris ini lewat embed PostgREST
-- (getConfirmedOrder/getDelivery, lib/delivery/repository.ts) TIDAK memakai
-- ORDER BY eksplisit -- Postgres TIDAK menjamin urutan baris tanpa ORDER BY;
-- kebetulan cocok dengan urutan insert pada tabel kecil/seq scan, tapi tidak
-- dijamin begitu planner memilih index scan (idx_order_items_order_id ada)
-- atau tuple berpindah fisik akibat UPDATE -- inilah akar nondeterminisme
-- urutan produk pada dokumen (PO/Delivery Note/Invoice) Document Engine.
--
-- Fix: kolom line_no BIGSERIAL pada kedua tabel -- nilai increment monoton per
-- baris pada saat INSERT (nextval dipanggil per baris, apa pun jalurnya:
-- RPC atomic INSERT...SELECT, legacy import commit, atau insert langsung dari
-- test), sehingga urutan asli selalu bisa direkonstruksi lewat ORDER BY line_no
-- tanpa bergantung pada urutan fisik/scan plan. Kode pemanggil (repository.ts)
-- diupdate terpisah untuk memakai ORDER BY ini.
-- =============================================================================

ALTER TABLE public.sales_order_items ADD COLUMN line_no BIGSERIAL;
ALTER TABLE public.delivery_items ADD COLUMN line_no BIGSERIAL;

CREATE INDEX idx_sales_order_items_order_line ON public.sales_order_items (order_id, line_no);
CREATE INDEX idx_delivery_items_delivery_line ON public.delivery_items (delivery_id, line_no);
