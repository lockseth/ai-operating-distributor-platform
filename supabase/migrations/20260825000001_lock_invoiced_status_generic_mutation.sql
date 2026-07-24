-- =============================================================================
-- Invoiced Status Integrity Containment — kunci `invoiced` dari generic order
-- status mutation. Pola identik dengan Payment Status Integrity Containment
-- (migration 20260824000001) untuk `paid` — containment kecil, BUKAN
-- pembangunan Document Engine/receivable ledger.
--
-- Ditemukan pada Collection Receivable-Invoice-Payment Boundary Discovery
-- Gate: update_sales_order_status_atomic menerima p_new_status APA PUN
-- (termasuk 'invoiced') asalkan berbeda dari status lama, TANPA validasi
-- apa pun terhadap issued_documents. issueInvoiceDocument()/
-- record_issued_document() (lib/document-engine, migration 20260812000002)
-- adalah satu-satunya jalur invoice canonical yang immutable dan tenant-safe
-- -- tapi TIDAK PERNAH dipanggil dari kode produksi manapun (nol server
-- action/route/Telegram handler). Akibatnya siapa pun dengan permission
-- orders.update (termasuk role `sales`) bisa menandai order `invoiced` lewat
-- satu klik UI ("Tagih") tanpa dokumen invoice apa pun -- dan angka itu
-- langsung dijumlah di Finance Dashboard sebagai "Piutang Invoice". Ini
-- persis kelas masalah yang sama dengan `paid` sebelum containment
-- 20260824000001.
--
-- Fix (containment kecil): RPC generic ini sekarang JUGA menolak dua arah
-- untuk `invoiced`, DI DATABASE (bukan hanya UI/action), simetris dengan
-- guard `paid` yang sudah ada:
--   C. p_new_status = 'invoiced'   -> ditolak, outcome 'invoice_issuance_required'
--      (tidak ada aktor -- termasuk owner -- yang bisa membuat order
--      invoiced lewat mutation status generik; invoice wajib lewat jalur
--      issuance canonical -- issueInvoiceDocument()/issued_documents --
--      pada gate mendatang, bukan klik status).
--   D. status existing = 'invoiced' -> ditolak, outcome 'invoiced_locked'
--      (order yang sudah invoiced dibekukan dari RPC ini sepenuhnya,
--      termasuk upaya mengubahnya ke status lain -- mencegah RPC generik
--      dipakai sebagai jalur reversal tidak resmi yang menimpa histori).
-- Guard C/D dicek SEBELUM guard paid (A/B) dari sisi urutan status lama
-- (existing invoiced dicek sebelum p_new_status='paid' supaya percobaan
-- invoiced -> paid ditolak sebagai 'invoiced_locked', bukan tercampur
-- dengan semantik payment_workflow_required) -- lihat urutan IF di bawah.
-- Keduanya di-return SEBELUM UPDATE/INSERT audit_logs apa pun dieksekusi --
-- rejected mutation TIDAK mengubah sales_orders maupun menulis audit sukses
-- baru (konsisten dengan pola forbidden/not_found/unchanged/paid_locked/
-- payment_workflow_required yang sudah ada).
--
-- Existing row berstatus 'invoiced' TIDAK disentuh oleh migration ini --
-- data legacy/unverified dipertahankan apa adanya, TIDAK di-backfill jadi
-- invoice canonical, TIDAK dihapus, TIDAK diubah statusnya. Tidak ada kolom
-- atau tabel baru untuk flag ini -- klasifikasi legacy/unverified cukup
-- lewat semantics/comment/test, sesuai instruksi gate.
--
-- Jalur auto-derived delivery status (sync_sales_order_delivery_status(),
-- migration 20260717000001) TIDAK disentuh -- fungsi itu hanya pernah
-- menyentuh status 'confirmed'/'delivering' -> 'delivering'/'delivered',
-- tidak pernah 'invoiced', sehingga tidak ada konflik dengan guard di bawah.
--
-- Signature, return type, SECURITY DEFINER, search_path, validasi
-- actor/permission/company boundary, dan guard paid (A/B) existing TIDAK
-- berubah -- murni tambahan guard C/D.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_sales_order_status_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_new_status TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_old_status TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND p.name = 'orders.update'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT status INTO v_old_status
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_old_status IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  -- Guard D: order yang sudah invoiced dibekukan dari generic mutation ini
  -- -- tidak ada jalur "koreksi"/reversal invoiced -> status lain (termasuk
  -- -> paid) lewat RPC generik. Koreksi invoice hanya lewat jalur issuance
  -- canonical (issued_documents) pada gate mendatang.
  IF v_old_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoiced_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard B: order yang sudah paid dibekukan dari generic mutation ini --
  -- tidak ada jalur "koreksi" paid -> status lain lewat RPC generik. Payment
  -- correction hanya lewat payment workflow terverifikasi (gate mendatang).
  IF v_old_status = 'paid' THEN
    RETURN QUERY SELECT 'paid_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard C: tidak ada aktor -- termasuk owner -- yang bisa membuat order
  -- invoiced lewat generic status mutation. Status invoiced hanya boleh
  -- berasal dari jalur issuance canonical (issueInvoiceDocument() /
  -- issued_documents) pada gate mendatang, bukan klik status generik.
  IF p_new_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoice_issuance_required'::TEXT;
    RETURN;
  END IF;

  -- Guard A: tidak ada aktor -- termasuk owner -- yang bisa membuat order
  -- paid lewat generic status mutation. Status paid hanya boleh berasal dari
  -- payment fact yang sah pada payment workflow mendatang.
  IF p_new_status = 'paid' THEN
    RETURN QUERY SELECT 'payment_workflow_required'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = p_new_status THEN
    RETURN QUERY SELECT 'unchanged'::TEXT;
    RETURN;
  END IF;

  UPDATE public.sales_orders
  SET status = p_new_status,
      delivered_at = CASE WHEN p_new_status = 'delivered' THEN NOW() ELSE delivered_at END
  WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.status_update', 'sales_orders', p_order_id,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', p_new_status),
    NULL, 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;
