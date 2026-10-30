-- =============================================================================
-- Bucket bukti pengiriman (foto + tanda tangan) untuk verifikasi pengiriman web
-- (tanpa Telegram). Rancangan: docs/product/delivery-verification/
-- AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md (S2).
--
-- Pola sama bucket payment-proofs (20261021000001): privat, path diawali
-- company_id, upload lewat server action (admin client). Bukti IMMUTABLE: tidak
-- ada policy UPDATE/DELETE untuk pengguna biasa.
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('delivery-evidence', 'delivery-evidence', FALSE, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "delivery_evidence_insert_own_company" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'delivery-evidence'
    AND (storage.foldername(name))[1] = public.get_user_company_id()::TEXT
  );

CREATE POLICY "delivery_evidence_select_own_company" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'delivery-evidence'
    AND (storage.foldername(name))[1] = public.get_user_company_id()::TEXT
  );
