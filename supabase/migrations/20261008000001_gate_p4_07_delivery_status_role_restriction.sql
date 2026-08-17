-- =============================================================================
-- Gate P4.07 -- Batasi override manual status delivering/delivered ke role
-- supervisor (owner/manager/admin/super_admin).
--
-- Keputusan Founder 2026-08-17 (bundel 5 keputusan bisnis, TRACKER.md):
-- tombol status generik "Kirim"/"Tandai Terkirim" -- yang sejak Gate P4.04
-- (20261007000001) sudah punya audit visibility (delivery_verified/
-- manual_override) tapi TETAP bisa dipakai siapa pun ber-permission
-- orders.update (termasuk sales/driver) -- sekarang dibatasi HANYA
-- owner/manager/admin/super_admin. Sales/driver wajib lewat Delivery
-- Verification asli (create_delivery_atomic -> dispatch_delivery_atomic ->
-- finalize_delivery_item_quantities -> sync_sales_order_delivery_status,
-- jalur otomatis yang TIDAK disentuh gate ini sama sekali -- fungsi itu
-- dipanggil dari lib/delivery/workflow.ts, bukan lewat RPC ini).
--
-- Scope: HANYA p_new_status IN ('delivering','delivered'). 'processing' dan
-- 'cancelled' tidak disentuh -- Founder hanya minta pembatasan utk 2 status
-- itu (representasi "barang benar-benar bergerak/sampai"), bukan seluruh
-- lifecycle order.
--
-- Guard baru ditempatkan SEBELUM komputasi delivery_verified (Gate P4.04) --
-- kalau role ditolak, tidak ada audit_logs row baru sama sekali (ditolak
-- bersih, sama pola dengan guard existing paid_locked/invoiced_locked dst).
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
  v_actor_allowed       BOOLEAN;
  v_actor_is_supervisor BOOLEAN;
  v_old_status          TEXT;
  v_delivery_verified   BOOLEAN;
  v_audit_extra         JSONB := '{}'::jsonb;
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

  -- Gate P4.07: delivering/delivered lewat jalur manual ini HANYA boleh
  -- role supervisor. Sales/driver wajib lewat Delivery Verification asli
  -- (sync_sales_order_delivery_status, jalur terpisah tidak disentuh gate
  -- ini). Dicek SEBELUM unchanged-check supaya konsisten menolak walau
  -- status sebenarnya sama (tidak membocorkan status lewat perbedaan
  -- outcome unchanged vs role-blocked).
  IF p_new_status IN ('delivering', 'delivered') THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.user_id = p_actor_id
        AND ur.company_id = p_company_id
        AND r.name IN ('owner', 'manager', 'admin', 'super_admin')
    ) INTO v_actor_is_supervisor;

    IF NOT v_actor_is_supervisor THEN
      RETURN QUERY SELECT 'delivery_override_role_required'::TEXT;
      RETURN;
    END IF;
  END IF;

  IF v_old_status = p_new_status THEN
    RETURN QUERY SELECT 'unchanged'::TEXT;
    RETURN;
  END IF;

  -- Gate P4.04: hitung delivery_verified untuk delivering/delivered SEBELUM
  -- UPDATE (murni observability, tidak pernah menolak/RETURN di sini --
  -- penolakan role sudah selesai di guard di atas).
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
  'Gate P4.07 menambah guard role: p_new_status IN (delivering,delivered) hanya diizinkan utk owner/manager/admin/super_admin (delivery_override_role_required kalau bukan) -- sales/driver wajib lewat Delivery Verification asli (sync_sales_order_delivery_status, jalur terpisah). Gate P4.04 (audit delivery_verified/manual_override), Gate 3E-D4-C4 (confirmed guard), dan guard paid/invoiced/pending_owner_approval (20260824000001/20260825000001/20260923000001) tidak berubah.';

REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;
