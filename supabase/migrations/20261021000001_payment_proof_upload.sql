-- =============================================================================
-- Upload Bukti Pembayaran Sungguhan -- menggantikan tempelan link manual di
-- payment_proofs.object_reference (Gate 2D lama, migration 20260829000001).
--
-- TIDAK ADA perubahan RPC/tabel -- object_reference sudah TEXT bebas, cukup
-- diisi PATH STORAGE alih-alih teks ketikan manual. Bucket ini pola persis
-- store-photos (migration 20261004000001): private, RLS tenant-scoped lewat
-- (storage.foldername(name))[1] = company_id, tidak ada UPDATE/DELETE policy
-- (bukti bersifat evidence, immutable setelah diupload).
--
-- Beda dari store-photos: tambah application/pdf (struk transfer bank sering
-- berupa PDF, bukan cuma foto).
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('payment-proofs', 'payment-proofs', FALSE, 8388608,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "payment_proofs_insert_own_company" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'payment-proofs'
    AND (storage.foldername(name))[1] = public.get_user_company_id()::TEXT
  );

CREATE POLICY "payment_proofs_select_own_company" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'payment-proofs'
    AND (storage.foldername(name))[1] = public.get_user_company_id()::TEXT
  );
