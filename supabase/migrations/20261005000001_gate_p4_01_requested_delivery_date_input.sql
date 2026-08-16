-- =============================================================================
-- Gate P4.01 -- requested_delivery_date: sambungkan input yang hilang untuk
-- AI Dispatch Planner.
--
-- Temuan (role-play UAT order-to-cash, 2026-08-16): AI Dispatch Planner
-- (apps/web/src/lib/dispatch/service.ts, planDispatch) sudah punya logic
-- hard-constraint untuk "requestedDeliveryDate" (preferensi tanggal kirim
-- customer, dicek PERTAMA sebelum aturan lain -- kalau terisi & beda dari
-- kandidat AI, planner berhenti dan pakai tanggal itu, status
-- 'customer_requested_delay'). Kolom sumbernya, sales_orders.
-- requested_delivery_date, sudah ada sejak migration 20260721000001, tapi
-- TIDAK ADA jalur (UI maupun parameter RPC) untuk mengisinya -- selalu NULL
-- di produksi. Field "Tanggal Pengiriman" yang ada di form order mengisi
-- kolom LAIN (delivery_date, murni catatan/tampilan), bukan kolom ini.
--
-- Scope gate ini: HANYA menambah parameter opsional baru
-- (p_requested_delivery_date DATE DEFAULT NULL) ke create_sales_order_atomic
-- & update_sales_order_atomic, murni ADDITIVE -- pola identik migration
-- 20261004000001 (foto/GPS toko): signature lama di-DROP eksplisit dulu
-- (CREATE OR REPLACE saja akan membuat overload ambigu), baru buat versi
-- baru. TIDAK ada baris validasi/logic lain yang diubah -- body adalah
-- salinan persis dari 20260927000001, hanya titik yang menyentuh kolom baru
-- ditandai "-- BARU". dispatch/service.ts TIDAK disentuh -- logic-nya sudah
-- benar, tinggal dikasih data lewat kolom ini.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. create_sales_order_atomic -- tambah p_requested_delivery_date di akhir.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.create_sales_order_atomic(
  UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB
);

CREATE FUNCTION public.create_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_number TEXT,
  p_customer_id UUID,
  p_sales_id UUID,
  p_notes TEXT,
  p_delivery_date DATE,
  p_discount_amount NUMERIC,
  p_items JSONB,
  p_requested_delivery_date DATE DEFAULT NULL -- BARU
)
RETURNS TABLE(result_outcome TEXT, result_order_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_actor_bypasses_ownership BOOLEAN;
  v_effective_sales_id UUID;
  v_customer public.customers%ROWTYPE;
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

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_actor_id
      AND ur.company_id = p_company_id
      AND r.name IN ('owner', 'manager', 'admin', 'super_admin')
  ) INTO v_actor_bypasses_ownership;

  v_effective_sales_id := CASE WHEN v_actor_bypasses_ownership THEN p_sales_id ELSE p_actor_id END;

  SELECT * INTO v_customer
  FROM public.customers c
  WHERE c.id = p_customer_id AND c.company_id = p_company_id;

  IF p_customer_id IS NULL OR NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF NOT v_actor_bypasses_ownership
     AND v_customer.assigned_sales_id IS NOT NULL
     AND v_customer.assigned_sales_id <> v_effective_sales_id THEN
    RETURN QUERY SELECT 'customer_not_owned'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_effective_sales_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_effective_sales_id AND u.company_id = p_company_id
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

  SELECT COALESCE(SUM(GREATEST(0, ROUND(x.quantity * x.unit_price - x.discount_amount, 2))), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(quantity NUMERIC, unit_price NUMERIC, discount_amount NUMERIC);
  v_tax_amount := ROUND((v_total_amount - p_discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - p_discount_amount + v_tax_amount;

  INSERT INTO public.sales_orders (
    company_id, order_number, customer_id, sales_id, status, notes,
    delivery_date, created_by, total_amount, discount_amount, tax_amount, final_amount,
    requested_delivery_date -- BARU
  ) VALUES (
    p_company_id, p_order_number, p_customer_id, v_effective_sales_id, 'draft', p_notes,
    p_delivery_date, p_actor_id, v_total_amount, p_discount_amount, v_tax_amount, v_final_amount,
    p_requested_delivery_date -- BARU
  )
  RETURNING id INTO v_order_id;

  INSERT INTO public.sales_order_items (
    order_id, product_id, quantity, unit_price, discount_amount, total_amount, notes
  )
  SELECT v_order_id, x.product_id, x.quantity, x.unit_price, x.discount_amount,
    GREATEST(0, ROUND(x.quantity * x.unit_price - x.discount_amount, 2)), x.notes
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

REVOKE ALL ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 2. update_sales_order_atomic -- tambah p_requested_delivery_date di akhir
--    (Guard draft-only Gate 3E-D4-B2 TIDAK diubah).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.update_sales_order_atomic(
  UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB
);

CREATE FUNCTION public.update_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_customer_id UUID,
  p_sales_id UUID,
  p_notes TEXT,
  p_delivery_date DATE,
  p_discount_amount NUMERIC,
  p_items JSONB,
  p_requested_delivery_date DATE DEFAULT NULL -- BARU
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_actor_bypasses_ownership BOOLEAN;
  v_effective_sales_id UUID;
  v_order public.sales_orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
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

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_actor_id
      AND ur.company_id = p_company_id
      AND r.name IN ('owner', 'manager', 'admin', 'super_admin')
  ) INTO v_actor_bypasses_ownership;

  v_effective_sales_id := CASE WHEN v_actor_bypasses_ownership THEN p_sales_id ELSE p_actor_id END;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF NOT v_actor_bypasses_ownership AND v_order.sales_id IS DISTINCT FROM p_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF v_order.status != 'draft' THEN
    RETURN QUERY SELECT 'invalid_status'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_customer
  FROM public.customers c
  WHERE c.id = p_customer_id AND c.company_id = p_company_id;

  IF p_customer_id IS NULL OR NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT;
    RETURN;
  END IF;

  IF NOT v_actor_bypasses_ownership
     AND v_customer.assigned_sales_id IS NOT NULL
     AND v_customer.assigned_sales_id <> v_effective_sales_id THEN
    RETURN QUERY SELECT 'customer_not_owned'::TEXT;
    RETURN;
  END IF;

  IF v_effective_sales_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_effective_sales_id AND u.company_id = p_company_id
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

  SELECT COALESCE(SUM(GREATEST(0, ROUND(x.quantity * x.unit_price - x.discount_amount, 2))), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(quantity NUMERIC, unit_price NUMERIC, discount_amount NUMERIC);
  v_tax_amount := ROUND((v_total_amount - p_discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - p_discount_amount + v_tax_amount;

  DELETE FROM public.sales_order_items WHERE order_id = p_order_id;

  INSERT INTO public.sales_order_items (
    order_id, product_id, quantity, unit_price, discount_amount, total_amount, notes
  )
  SELECT p_order_id, x.product_id, x.quantity, x.unit_price, x.discount_amount,
    GREATEST(0, ROUND(x.quantity * x.unit_price - x.discount_amount, 2)), x.notes
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID, quantity INTEGER, unit_price NUMERIC,
    discount_amount NUMERIC, total_amount NUMERIC, notes TEXT
  );

  UPDATE public.sales_orders
  SET customer_id = p_customer_id,
      sales_id = v_effective_sales_id,
      notes = p_notes,
      delivery_date = p_delivery_date,
      total_amount = v_total_amount,
      discount_amount = p_discount_amount,
      tax_amount = v_tax_amount,
      final_amount = v_final_amount,
      requested_delivery_date = p_requested_delivery_date -- BARU
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

REVOKE ALL ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE)
  TO service_role;
