-- =============================================================================
-- Gate P4.04 -- Delivery status override audit visibility.
--
-- Temuan (role-play UAT lokal, TRACKER.md 2026-08-16): tombol status generik
-- ("Proses"/"Kirim"/"Tandai Terkirim" di orders/[id]/page.tsx, dipanggil
-- lewat update_sales_order_status_atomic) SAMA SEKALI tidak terhubung ke
-- tabel deliveries -- siapa pun dengan permission orders.update bisa
-- menandai order 'delivering'/'delivered' tanpa bukti pengiriman
-- (foto/GPS/driver) apa pun, tanpa ada jejak yang membedakannya dari jalur
-- Delivery Verification asli (create_delivery_atomic -> dispatch_delivery_
-- atomic -> finalize_delivery_item_quantities -> sync_sales_order_delivery_
-- status).
--
-- Jalur ini SENGAJA ADA sebagai "override manusia yang valid" (komentar
-- migration 20260717000001, sync_sales_order_delivery_status) -- gate ini
-- TIDAK memblokir jalur itu (perilaku existing dipertahankan penuh, siapa
-- pun yang tadinya bisa pakai tombol ini tetap bisa). Yang ditutup murni gap
-- observability yang eksplisit dicatat sebagai kurang: audit_logs sekarang
-- merekam delivery_verified/manual_override untuk transisi delivering/
-- delivered, supaya override yang tidak didukung bukti pengiriman terlihat
-- jelas dibedakan dari yang didukung -- tanpa mengubah siapa yang boleh
-- melakukannya (keputusan restriksi role/blocking penuh adalah keputusan
-- bisnis terpisah, diajukan ke Founder, bukan diputuskan sepihak di sini).
--
-- delivery_verified dihitung dengan logic identik sync_sales_order_delivery_
-- status (20260717000001) supaya konsisten dengan definisi "delivered" yang
-- sudah locked:
--   - delivering: minimal ada 1 baris deliveries utk order ini berstatus
--     dispatched/arrived/fully_received/partially_received/verified (artinya
--     sesuatu benar-benar sudah digerakkan lewat Delivery Verification).
--   - delivered: SETIAP sales_order_items sudah tertutup penuh oleh SUM
--     received_quantity lintas seluruh delivery attempt (sama persis kondisi
--     v_fully_covered di sync_sales_order_delivery_status).
-- Status lain (processing/cancelled) tidak disentuh -- delivery_verified
-- tidak relevan untuk itu.
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
  v_actor_allowed    BOOLEAN;
  v_old_status       TEXT;
  v_delivery_verified BOOLEAN;
  v_audit_extra      JSONB := '{}'::jsonb;
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

  IF v_old_status = 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'pending_owner_approval_locked'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoiced_locked'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = 'paid' THEN
    RETURN QUERY SELECT 'paid_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard G (Gate 3E-D4-C4): tidak ada aktor -- termasuk owner -- yang bisa
  -- membuat order confirmed lewat generic status mutation ini (Bypass 2,
  -- lihat header migration 20260926000001). Confirmation SELALU lewat
  -- confirm_sales_order_atomic, satu-satunya RPC yang memvalidasi special-
  -- price approval boundary.
  IF p_new_status = 'confirmed' THEN
    RETURN QUERY SELECT 'confirmation_workflow_required'::TEXT;
    RETURN;
  END IF;

  IF p_new_status = 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'special_price_approval_workflow_required'::TEXT;
    RETURN;
  END IF;

  IF p_new_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoice_issuance_required'::TEXT;
    RETURN;
  END IF;

  IF p_new_status = 'paid' THEN
    RETURN QUERY SELECT 'payment_workflow_required'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = p_new_status THEN
    RETURN QUERY SELECT 'unchanged'::TEXT;
    RETURN;
  END IF;

  -- Gate P4.04: hitung delivery_verified untuk delivering/delivered SEBELUM
  -- UPDATE (murni observability, tidak pernah menolak/RETURN di sini).
  IF p_new_status = 'delivering' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.sales_order_id = p_order_id
        AND d.status IN ('dispatched', 'arrived', 'fully_received', 'partially_received', 'verified')
    ) INTO v_delivery_verified;
    v_audit_extra := jsonb_build_object(
      'delivery_verified', v_delivery_verified,
      'manual_override', NOT v_delivery_verified
    );
  ELSIF p_new_status = 'delivered' THEN
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.sales_order_items soi
      WHERE soi.order_id = p_order_id
        AND soi.quantity > COALESCE((
          SELECT SUM(di.received_quantity)
          FROM public.delivery_items di
          JOIN public.deliveries d ON d.id = di.delivery_id
          WHERE di.sales_order_item_id = soi.id
        ), 0)
    ) INTO v_delivery_verified;
    v_audit_extra := jsonb_build_object(
      'delivery_verified', v_delivery_verified,
      'manual_override', NOT v_delivery_verified
    );
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
    jsonb_build_object('status', p_new_status) || v_audit_extra,
    NULL, 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT) IS
  'Gate P4.04 menambah observability: transisi ke delivering/delivered sekarang merekam delivery_verified/manual_override di audit_logs.new_data (logic identik sync_sales_order_delivery_status 20260717000001) -- TIDAK memblokir jalur override manusia yang sudah disengaja ada sejak awal, murni membuatnya terlihat jelas dibedakan dari jalur Delivery Verification asli. Guard confirmed/pending_owner_approval/invoiced/paid (Gate 3E-D4-C4/20260824000001/20260825000001/20260923000001) tidak berubah.';

REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;
