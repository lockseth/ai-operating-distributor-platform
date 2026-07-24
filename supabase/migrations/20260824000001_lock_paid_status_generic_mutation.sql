-- =============================================================================
-- Payment Status Integrity Containment — kunci `paid` dari generic order
-- status mutation.
--
-- Ditemukan pada Payment Proof Discovery Gate: update_sales_order_status_atomic
-- (migration 20260822000001) menerima p_new_status APA PUN asalkan berbeda
-- dari status lama, tanpa validasi state-machine apa pun. Karena role `sales`
-- sudah diberi permission orders.update secara default
-- (20260707000001_seed_system_role_permissions.sql:33), siapa pun dengan
-- permission ini bisa menandai order `paid` lewat satu klik UI ("Tandai
-- Lunas") tanpa payment fact apa pun (nominal, metode, referensi, bukti) --
-- dan angka itu langsung dijumlah di Finance Dashboard sebagai "Pembayaran
-- Diterima".
--
-- Fix (containment kecil, BUKAN payment module): RPC generic ini sekarang
-- menolak dua arah secara eksplisit, DI DATABASE (bukan hanya UI/action):
--   A. p_new_status = 'paid'    -> ditolak, outcome 'payment_workflow_required'
--      (tidak ada aktor -- termasuk owner -- yang bisa membuat order paid
--      lewat mutation status generik).
--   B. status existing = 'paid' -> ditolak, outcome 'paid_locked'
--      (order yang sudah paid dibekukan dari RPC ini sepenuhnya, termasuk
--      upaya "koreksi" paid -> status lain -- mencegah RPC generik dipakai
--      sebagai jalur reversal tidak resmi yang menimpa histori).
-- Keduanya di-return SEBELUM UPDATE/INSERT audit_logs apa pun dieksekusi --
-- rejected mutation TIDAK mengubah sales_orders maupun menulis audit sukses
-- baru (konsisten dengan pola forbidden/not_found/unchanged yang sudah ada).
--
-- Existing row berstatus 'paid' TIDAK disentuh oleh migration ini -- data
-- legacy/unverified dipertahankan apa adanya menunggu payment workflow
-- terverifikasi pada gate mendatang. Tidak ada backfill/data migration di
-- sini.
--
-- Signature, return type, SECURITY DEFINER, search_path, dan validasi
-- actor/permission/company boundary TIDAK berubah -- murni tambahan guard.
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

  -- Guard B: order yang sudah paid dibekukan dari generic mutation ini --
  -- tidak ada jalur "koreksi" paid -> status lain lewat RPC generik. Payment
  -- correction hanya lewat payment workflow terverifikasi (gate mendatang).
  IF v_old_status = 'paid' THEN
    RETURN QUERY SELECT 'paid_locked'::TEXT;
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
