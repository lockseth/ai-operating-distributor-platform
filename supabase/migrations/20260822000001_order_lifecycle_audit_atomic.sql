-- =============================================================================
-- Gate 1D-B (K2) — Order lifecycle: audit atomik + retrofit kanonis.
--
-- Discovery (lihat laporan K2):
--   1. order_cancellation_disputes RPC (create/resolve, 20260725000001 +
--      20260726000001) SUDAH atomik -- hanya perlu retrofit kolom kanonis
--      (pola identik K1/20260821000001).
--   2. apps/web/src/lib/orders/actions.ts (order dari Web UI) menulis mutasi
--      via .from().insert()/.update() LANGSUNG, audit lewat logAuditEvent()
--      best-effort (menelan error via .catch(() => {})) -- TIDAK atomik.
--   3. apps/web/src/lib/sales-orders/repository.ts (Telegram Order Entry --
--      channel order masuk utama produk ini) -- createDraftOrder/
--      updateDraftOrder/confirmOrder SAMA SEKALI TIDAK menulis audit, dan
--      TIDAK memvalidasi company_id/actor tenant match sama sekali (berjalan
--      lewat admin/service_role client, bypass RLS sepenuhnya).
--
-- Fix: pindahkan seluruh mutasi order (bag. 2 & 3) ke RPC SECURITY DEFINER
-- yang menyatukan mutasi + audit dalam satu transaksi -- pola yang identik
-- dengan KPI/salesman/dispute yang sudah ada. TypeScript pemanggil (actions.ts
-- & repository.ts) di-refactor pada file terpisah untuk memanggil RPC ini,
-- BUKAN .from() langsung.
--
-- Perbaikan terkait (approval eksplisit Founder): permission app-layer untuk
-- update/cancel order memeriksa string "orders.edit" yang TIDAK PERNAH
-- di-seed (hanya orders.view/create/update/delete/manage ada -- lihat
-- 20260626000002:143-147) -- selalu false untuk user non-demo, artinya fitur
-- edit/cancel order rusak (fail-closed) di production untuk SEMUA user. RPC
-- di bawah memvalidasi permission "orders.update" (canonical yang benar,
-- dikonfirmasi Founder sudah diperbaiki di Gate 1A) -- BUKAN "orders.edit".
--
-- Trust boundary tambahan (bukan hanya audit, tapi juga celah tenant-isolation
-- yang ditemukan saat discovery): create/update/confirm draft Telegram
-- sebelumnya tidak pernah memvalidasi company_id pada order_id yang
-- dioperasikan (query hanya WHERE id = orderId, tanpa company_id, karena
-- berjalan lewat admin client). RPC di bawah menambahkan WHERE company_id =
-- p_company_id secara eksplisit pada semua operasi order -- defense in depth,
-- konsisten dengan Global Trust Boundary gate ini.
--
-- Total server-side: customer/product HARUS milik tenant yang sama (validasi
-- baru, sebelumnya hanya bergantung pada FK generik yang tidak mengecek
-- company_id). Total_amount/tax_amount/final_amount untuk order Web UI
-- dihitung ULANG di server dari item (formula identik calcTotals()) --
-- tidak dipercaya mentah dari client. Untuk draft Telegram, total sudah
-- hasil AI pricing engine (discount policy Knowledge Pack) yang TIDAK
-- direplikasi di SQL (di luar scope) -- diterima apa adanya seperti sebelum
-- perubahan ini.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. order_cancellation_disputes -- retrofit kolom kanonis (pola K1).
--    Signature identik 20260726000001, HANYA tambah kolom + actor_type
--    dinamis (requester: peran apa pun yang aktif, tidak dibatasi role;
--    reviewer: owner/manager/admin/super_admin).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_order_cancellation_dispute(
  p_company_id UUID,
  p_sales_order_id UUID,
  p_request_type TEXT,
  p_reason_code TEXT,
  p_notes TEXT,
  p_reported_pic_name TEXT,
  p_reported_pic_phone TEXT,
  p_contact_source TEXT,
  p_requested_by UUID,
  p_idempotency_key TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  request_id UUID,
  order_stage TEXT,
  ai_classification TEXT,
  auto_cancelled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_order public.sales_orders%ROWTYPE;
  v_existing public.order_cancellation_disputes%ROWTYPE;
  v_stage TEXT;
  v_classification TEXT;
  v_new_id UUID;
  v_auto_cancel BOOLEAN := FALSE;
  v_status TEXT;
BEGIN
  IF p_request_type NOT IN ('CUSTOMER_CANCELLED', 'CUSTOMER_DENIES_ORDER') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.order_cancellation_disputes
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN QUERY SELECT
        'already_exists'::TEXT,
        v_existing.id,
        v_existing.order_stage_at_request::TEXT,
        v_existing.ai_classification::TEXT,
        (v_existing.status = 'APPROVED');
      RETURN;
    END IF;
  END IF;

  SELECT r.name INTO v_actor_role
  FROM public.users u
  LEFT JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
  LEFT JOIN public.roles r ON r.id = ur.role_id
  WHERE u.id = p_requested_by
    AND u.company_id = p_company_id
    AND u.is_active = TRUE
  ORDER BY CASE r.name
    WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 WHEN 'admin' THEN 3
    WHEN 'super_admin' THEN 4 WHEN 'finance' THEN 5 WHEN 'warehouse' THEN 6
    WHEN 'sales' THEN 7 WHEN 'driver' THEN 8 ELSE 9 END
  LIMIT 1;

  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_requested_by AND u.company_id = p_company_id AND u.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_sales_order_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'order_not_found'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_order.status = 'cancelled' THEN
    RETURN QUERY SELECT 'order_already_cancelled'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_cancellation_disputes
    WHERE sales_order_id = p_sales_order_id AND status IN ('REQUESTED', 'ON_HOLD')
  ) THEN
    RETURN QUERY SELECT 'already_has_active_request'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  PERFORM 1 FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;

  v_stage := public.determine_order_stage(p_sales_order_id);

  IF p_request_type = 'CUSTOMER_DENIES_ORDER' THEN
    v_classification := 'HOLD_AND_ALERT';
    v_status := 'ON_HOLD';
  ELSIF v_stage = 'NOT_DISPATCHED' THEN
    v_classification := 'AUTO_CANCEL_SAFE';
    v_status := 'APPROVED';
    v_auto_cancel := TRUE;
  ELSIF v_stage = 'IN_DISPATCH_PLAN_NOT_DEPARTED' THEN
    v_classification := 'NEEDS_REVIEW';
    v_status := 'REQUESTED';
  ELSE
    v_classification := 'HOLD_AND_ALERT';
    v_status := 'ON_HOLD';
  END IF;

  INSERT INTO public.order_cancellation_disputes (
    company_id, sales_order_id, request_type, reason_code, notes,
    reported_pic_name_snapshot, reported_pic_phone_snapshot, contact_source,
    order_stage_at_request, ai_classification, status,
    requested_by, idempotency_key
  ) VALUES (
    p_company_id, p_sales_order_id, p_request_type, p_reason_code, p_notes,
    NULLIF(p_reported_pic_name, ''), NULLIF(p_reported_pic_phone, ''), p_contact_source,
    v_stage, v_classification, v_status,
    p_requested_by, p_idempotency_key
  )
  RETURNING id INTO v_new_id;

  IF v_auto_cancel THEN
    UPDATE public.sales_orders SET status = 'cancelled' WHERE id = p_sales_order_id;
    UPDATE public.order_cancellation_disputes
    SET status = 'APPROVED', resolution = 'CANCEL_APPROVED'
    WHERE id = v_new_id;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_requested_by, 'order.cancellation_dispute_requested', 'order_cancellation_disputes', v_new_id,
    jsonb_build_object(
      'sales_order_id', p_sales_order_id,
      'request_type', p_request_type,
      'reason_code', p_reason_code,
      'contact_source', p_contact_source,
      'order_stage_at_request', v_stage,
      'ai_classification', v_classification,
      'auto_cancelled', v_auto_cancel
    ),
    v_actor_role,
    'audit',
    'orders',
    'telegram',
    'success'
  );

  RETURN QUERY SELECT 'created'::TEXT, v_new_id, v_stage, v_classification, v_auto_cancel;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_order_cancellation_dispute(
  p_company_id UUID,
  p_request_id UUID,
  p_reviewer_id UUID,
  p_resolution TEXT,
  p_resolution_notes TEXT,
  p_actual_pic_name TEXT
)
RETURNS TABLE(result_outcome TEXT, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_request public.order_cancellation_disputes%ROWTYPE;
  v_final_status TEXT;
BEGIN
  IF p_resolution NOT IN ('CANCEL_APPROVED','CANCEL_REJECTED','CANCELLED_NOT_ORDERED','ORDERED_BY_ANOTHER_PIC','KEPT_ON_HOLD') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT r.name INTO v_actor_role
  FROM public.users u
  JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
  JOIN public.roles r ON r.id = ur.role_id
  WHERE u.id = p_reviewer_id
    AND u.company_id = p_company_id
    AND u.is_active = TRUE
    AND r.name IN ('owner','manager','admin','super_admin')
  ORDER BY CASE r.name WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 WHEN 'admin' THEN 3 WHEN 'super_admin' THEN 4 END
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_request
  FROM public.order_cancellation_disputes
  WHERE id = p_request_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_request.requested_by = p_reviewer_id THEN
    RETURN QUERY SELECT 'self_review_forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_request.status NOT IN ('REQUESTED', 'ON_HOLD') THEN
    RETURN QUERY SELECT 'already_resolved'::TEXT, v_request.status::TEXT;
    RETURN;
  END IF;

  v_final_status := CASE
    WHEN p_resolution = 'CANCEL_APPROVED' THEN 'APPROVED'
    WHEN p_resolution = 'CANCEL_REJECTED' THEN 'REJECTED'
    WHEN p_resolution = 'CANCELLED_NOT_ORDERED' THEN 'RESOLVED'
    WHEN p_resolution = 'ORDERED_BY_ANOTHER_PIC' THEN 'RESOLVED'
    WHEN p_resolution = 'KEPT_ON_HOLD' THEN 'ON_HOLD'
  END;

  UPDATE public.order_cancellation_disputes
  SET status = v_final_status,
      resolution = p_resolution,
      resolution_notes = p_resolution_notes,
      actual_pic_name_snapshot = NULLIF(p_actual_pic_name, ''),
      reviewed_by = p_reviewer_id,
      reviewed_at = NOW()
  WHERE id = p_request_id;

  IF p_resolution IN ('CANCEL_APPROVED', 'CANCELLED_NOT_ORDERED') THEN
    UPDATE public.sales_orders SET status = 'cancelled' WHERE id = v_request.sales_order_id;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_reviewer_id, 'order.cancellation_dispute_resolved', 'order_cancellation_disputes', p_request_id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', v_final_status, 'resolution', p_resolution),
    v_actor_role,
    'audit',
    'orders',
    'rpc',
    'success'
  );

  RETURN QUERY SELECT 'resolved'::TEXT, v_final_status;
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_cancellation_dispute(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_cancellation_dispute(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT)
  TO service_role;
REVOKE ALL ON FUNCTION public.resolve_order_cancellation_dispute(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_cancellation_dispute(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Web UI order RPCs -- menggantikan .from() langsung di orders/actions.ts.
--    Permission check manual (p_actor_id + role_permissions/permissions --
--    user_has_permission() TIDAK bisa dipakai, bergantung auth.uid() yang
--    NULL di service_role/admin-client context).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_number TEXT,
  p_customer_id UUID,
  p_sales_id UUID,
  p_notes TEXT,
  p_delivery_date DATE,
  p_discount_amount NUMERIC,
  p_items JSONB
)
RETURNS TABLE(result_outcome TEXT, result_order_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_total_amount NUMERIC;
  v_tax_amount NUMERIC;
  v_final_amount NUMERIC;
  v_item_count INTEGER;
  v_invalid_product_count INTEGER;
  v_order_id UUID;
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
      AND p.name = 'orders.create'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_customer_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_sales_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = p_sales_id AND u.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_sales_id'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_item_count FROM jsonb_array_elements(p_items);
  IF v_item_count = 0 THEN
    RETURN QUERY SELECT 'no_items'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_invalid_product_count
  FROM jsonb_to_recordset(p_items) AS x(product_id UUID)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.products pr WHERE pr.id = x.product_id AND pr.company_id = p_company_id
  );
  IF v_invalid_product_count > 0 THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(x.total_amount), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(total_amount NUMERIC);
  v_tax_amount := ROUND((v_total_amount - p_discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - p_discount_amount + v_tax_amount;

  INSERT INTO public.sales_orders (
    company_id, order_number, customer_id, sales_id, status, notes,
    delivery_date, created_by, total_amount, discount_amount, tax_amount, final_amount
  ) VALUES (
    p_company_id, p_order_number, p_customer_id, p_sales_id, 'draft', p_notes,
    p_delivery_date, p_actor_id, v_total_amount, p_discount_amount, v_tax_amount, v_final_amount
  )
  RETURNING id INTO v_order_id;

  INSERT INTO public.sales_order_items (
    order_id, product_id, quantity, unit_price, discount_amount, total_amount, notes
  )
  SELECT v_order_id, x.product_id, x.quantity, x.unit_price, x.discount_amount, x.total_amount, x.notes
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID, quantity INTEGER, unit_price NUMERIC,
    discount_amount NUMERIC, total_amount NUMERIC, notes TEXT
  );

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.create', 'sales_orders', v_order_id,
    jsonb_build_object(
      'order_number', p_order_number, 'customer_id', p_customer_id,
      'item_count', v_item_count, 'final_amount', v_final_amount
    ),
    NULL, 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'created'::TEXT, v_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_customer_id UUID,
  p_sales_id UUID,
  p_notes TEXT,
  p_delivery_date DATE,
  p_discount_amount NUMERIC,
  p_items JSONB
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_order public.sales_orders%ROWTYPE;
  v_total_amount NUMERIC;
  v_tax_amount NUMERIC;
  v_final_amount NUMERIC;
  v_item_count INTEGER;
  v_invalid_product_count INTEGER;
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

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF v_order.status NOT IN ('draft', 'confirmed') THEN
    RETURN QUERY SELECT 'invalid_status'::TEXT;
    RETURN;
  END IF;

  IF p_customer_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT;
    RETURN;
  END IF;

  IF p_sales_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = p_sales_id AND u.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_sales_id'::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_item_count FROM jsonb_array_elements(p_items);
  IF v_item_count = 0 THEN
    RETURN QUERY SELECT 'no_items'::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_invalid_product_count
  FROM jsonb_to_recordset(p_items) AS x(product_id UUID)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.products pr WHERE pr.id = x.product_id AND pr.company_id = p_company_id
  );
  IF v_invalid_product_count > 0 THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(x.total_amount), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(total_amount NUMERIC);
  v_tax_amount := ROUND((v_total_amount - p_discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - p_discount_amount + v_tax_amount;

  DELETE FROM public.sales_order_items WHERE order_id = p_order_id;

  INSERT INTO public.sales_order_items (
    order_id, product_id, quantity, unit_price, discount_amount, total_amount, notes
  )
  SELECT p_order_id, x.product_id, x.quantity, x.unit_price, x.discount_amount, x.total_amount, x.notes
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID, quantity INTEGER, unit_price NUMERIC,
    discount_amount NUMERIC, total_amount NUMERIC, notes TEXT
  );

  UPDATE public.sales_orders
  SET customer_id = p_customer_id,
      sales_id = p_sales_id,
      notes = p_notes,
      delivery_date = p_delivery_date,
      total_amount = v_total_amount,
      discount_amount = p_discount_amount,
      tax_amount = v_tax_amount,
      final_amount = v_final_amount
  WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.update', 'sales_orders', p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number, 'customer_id', v_order.customer_id,
      'final_amount', v_order.final_amount
    ),
    jsonb_build_object(
      'order_number', v_order.order_number, 'customer_id', p_customer_id,
      'item_count', v_item_count, 'final_amount', v_final_amount
    ),
    NULL, 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.cancel_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID
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
      AND p.name IN ('orders.delete', 'orders.update')
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

  IF v_old_status IN ('delivered', 'invoiced', 'paid', 'cancelled') THEN
    RETURN QUERY SELECT 'invalid_status'::TEXT;
    RETURN;
  END IF;

  UPDATE public.sales_orders SET status = 'cancelled' WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.cancel', 'sales_orders', p_order_id,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', 'cancelled'),
    NULL, 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'cancelled'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.cancel_sales_order_atomic(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_sales_order_atomic(UUID, UUID, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Telegram draft order RPCs -- menggantikan .from() langsung di
--    sales-orders/repository.ts. p_sales_id/p_actor_id di sini datang dari
--    identitas Telegram yang SUDAH di-resolve lewat mapping internal
--    (telegram_identities) di layer workflow -- bukan klaim mentah dari
--    payload Telegram -- tetap divalidasi ulang company match di sini
--    (defense in depth, RPC tidak boleh mempercayai caller tanpa verifikasi).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_draft_sales_order_atomic(
  p_company_id UUID,
  p_sales_id UUID,
  p_order_number TEXT,
  p_customer_id UUID,
  p_customer_name_raw TEXT,
  p_order_source TEXT,
  p_knowledge_version TEXT,
  p_extraction_confidence NUMERIC,
  p_missing_fields TEXT[],
  p_requires_discount_review BOOLEAN,
  p_delivery_note TEXT,
  p_telegram_event_id UUID,
  p_total_amount NUMERIC,
  p_discount_amount NUMERIC,
  p_final_amount NUMERIC,
  p_items JSONB
)
RETURNS TABLE(result_outcome TEXT, result_order_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order_id UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_sales_id AND u.company_id = p_company_id AND u.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.sales_orders (
    company_id, order_number, customer_id, customer_name_raw, sales_id, status,
    source_channel, order_source, knowledge_version, extraction_confidence,
    missing_fields, requires_discount_review, delivery_note,
    telegram_update_event_id, total_amount, discount_amount, tax_amount,
    final_amount, created_by
  ) VALUES (
    p_company_id, p_order_number, p_customer_id, p_customer_name_raw, p_sales_id, 'draft',
    'telegram', p_order_source, p_knowledge_version, p_extraction_confidence,
    p_missing_fields, p_requires_discount_review, p_delivery_note,
    p_telegram_event_id, p_total_amount, p_discount_amount, 0,
    p_final_amount, p_sales_id
  )
  RETURNING id INTO v_order_id;

  IF jsonb_array_length(p_items) > 0 THEN
    INSERT INTO public.sales_order_items (
      order_id, product_id, product_name_raw, quantity, unit, unit_price,
      discount_type, discount_value, amount_before_discount, discount_amount,
      discount_exception, total_amount
    )
    SELECT v_order_id, x.product_id, x.product_name_raw, x.quantity, x.unit, x.unit_price,
      x.discount_type, x.discount_value, x.amount_before_discount, x.discount_amount,
      x.discount_exception, x.total_amount
    FROM jsonb_to_recordset(p_items) AS x(
      product_id UUID, product_name_raw TEXT, quantity NUMERIC, unit TEXT,
      unit_price NUMERIC, discount_type TEXT, discount_value NUMERIC,
      amount_before_discount NUMERIC, discount_amount NUMERIC,
      discount_exception BOOLEAN, total_amount NUMERIC
    );
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_sales_id, 'order.create', 'sales_orders', v_order_id,
    jsonb_build_object(
      'order_number', p_order_number, 'customer_id', p_customer_id,
      'order_source', p_order_source, 'final_amount', p_final_amount
    ),
    'sales', 'audit', 'orders', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'created'::TEXT, v_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_draft_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_customer_id UUID,
  p_customer_name_raw TEXT,
  p_order_source TEXT,
  p_knowledge_version TEXT,
  p_extraction_confidence NUMERIC,
  p_missing_fields TEXT[],
  p_requires_discount_review BOOLEAN,
  p_delivery_note TEXT,
  p_total_amount NUMERIC,
  p_discount_amount NUMERIC,
  p_final_amount NUMERIC,
  p_items JSONB
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order public.sales_orders%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_actor_id AND u.company_id = p_company_id AND u.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF v_order.status != 'draft' THEN
    RETURN QUERY SELECT 'not_draft'::TEXT;
    RETURN;
  END IF;

  IF p_customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id = p_customer_id AND c.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT;
    RETURN;
  END IF;

  DELETE FROM public.sales_order_items WHERE order_id = p_order_id;

  IF jsonb_array_length(p_items) > 0 THEN
    INSERT INTO public.sales_order_items (
      order_id, product_id, product_name_raw, quantity, unit, unit_price,
      discount_type, discount_value, amount_before_discount, discount_amount,
      discount_exception, total_amount
    )
    SELECT p_order_id, x.product_id, x.product_name_raw, x.quantity, x.unit, x.unit_price,
      x.discount_type, x.discount_value, x.amount_before_discount, x.discount_amount,
      x.discount_exception, x.total_amount
    FROM jsonb_to_recordset(p_items) AS x(
      product_id UUID, product_name_raw TEXT, quantity NUMERIC, unit TEXT,
      unit_price NUMERIC, discount_type TEXT, discount_value NUMERIC,
      amount_before_discount NUMERIC, discount_amount NUMERIC,
      discount_exception BOOLEAN, total_amount NUMERIC
    );
  END IF;

  UPDATE public.sales_orders
  SET customer_id = p_customer_id,
      customer_name_raw = CASE WHEN p_customer_id IS NULL THEN p_customer_name_raw ELSE NULL END,
      order_source = p_order_source,
      knowledge_version = p_knowledge_version,
      extraction_confidence = p_extraction_confidence,
      missing_fields = p_missing_fields,
      requires_discount_review = p_requires_discount_review,
      delivery_note = p_delivery_note,
      total_amount = p_total_amount,
      discount_amount = p_discount_amount,
      final_amount = p_final_amount
  WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.update', 'sales_orders', p_order_id,
    jsonb_build_object(
      'customer_id', v_order.customer_id, 'order_source', v_order.order_source,
      'final_amount', v_order.final_amount
    ),
    jsonb_build_object(
      'customer_id', p_customer_id, 'order_source', p_order_source,
      'final_amount', p_final_amount
    ),
    'sales', 'audit', 'orders', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_payment_terms_days INTEGER
)
RETURNS TABLE(result_outcome TEXT, already_confirmed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old_status TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_actor_id AND u.company_id = p_company_id AND u.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, FALSE;
    RETURN;
  END IF;

  SELECT status INTO v_old_status
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_old_status IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_old_status = 'confirmed' THEN
    RETURN QUERY SELECT 'already_confirmed'::TEXT, TRUE;
    RETURN;
  END IF;

  UPDATE public.sales_orders
  SET status = 'confirmed',
      payment_terms_days = CASE WHEN p_payment_terms_days IS NOT NULL THEN p_payment_terms_days ELSE payment_terms_days END
  WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.confirm', 'sales_orders', p_order_id,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', 'confirmed', 'payment_terms_days', p_payment_terms_days),
    'sales', 'audit', 'orders', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'confirmed'::TEXT, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_draft_sales_order_atomic(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_draft_sales_order_atomic(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.update_draft_sales_order_atomic(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_draft_sales_order_atomic(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  TO service_role;
