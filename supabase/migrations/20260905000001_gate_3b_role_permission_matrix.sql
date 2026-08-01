-- =============================================================================
-- Gate 3B (Role Permission Matrix & Admin Discount Restriction)
--
-- Audit findings (lihat AODP_GATE_3B_ROLE_PERMISSION_MATRIX.md):
--
-- 1. kdp_manage (knowledge_discount_policies, migration 20260709000001)
--    mengizinkan owner/manager/admin/super_admin mengelola KEBIJAKAN diskon
--    (max_percentage/max_nominal per scope). Keputusan produk Gate 3B:
--    "pengaturan/kebijakan diskon" adalah owner-only -- admin (dan role
--    lain selain owner) DILARANG membuat/mengubah/mengaktifkan/
--    menonaktifkan/menghapus baris kebijakan ini. Tidak ada UI/RPC lain
--    yang menulis ke tabel ini (dikonfirmasi via audit) -- RLS adalah satu-
--    satunya permukaan yang perlu dikunci.
--
--    Ini TIDAK mengubah kdp_select (lihat semua role tetap boleh membaca --
--    dibutuhkan untuk evaluasi diskon transaksi di jalur Telegram intake)
--    maupun input diskon TRANSAKSI (order-level/line-item, tabel
--    sales_orders/sales_order_items) -- keduanya sengaja TIDAK disamakan
--    dengan pengaturan kebijakan diskon (instruksi Gate 3B eksplisit).
--
-- 2. update_sales_order_atomic (migration 20260822000001) dipanggil lewat
--    service-role client (getAdminClient(), lihat apps/web/src/lib/orders/
--    actions.ts) sehingga RLS sales_orders_update TIDAK PERNAH berlaku di
--    jalur mutasi order yang sesungguhnya. RPC ini hanya memeriksa
--    permission 'orders.update', TANPA mengecek ownership (sales_id) --
--    padahal RLS sales_orders_update (migration 20260626000004) secara
--    eksplisit mendeklarasikan niat "sales hanya boleh mengubah order
--    miliknya sendiri" (sales_id = auth.uid()). Akibatnya user manapun
--    yang punya 'orders.update' -- termasuk sales -- bisa mengedit
--    (termasuk mengubah diskon) order milik salesperson lain, melanggar
--    kontrak ownership/assignment yang sudah dinyatakan repo. Fix ini
--    menegakkan ulang niat tersebut DI DALAM RPC (satu-satunya jalur yang
--    benar-benar dieksekusi), memakai role bypass array yang SAMA dengan
--    yang sudah ada di sales_orders_select (owner/manager/admin/
--    super_admin tetap bisa mengedit order siapa pun di tenant mereka,
--    konsisten dengan kontrak ADMIN Gate 3B "boleh membantu pengelolaan
--    order"). Tidak ada perubahan pada create_sales_order_atomic (assignment
--    sales_id saat pembuatan order adalah keputusan produk terpisah yang
--    belum jelas kontraknya -- dilaporkan sebagai gap, tidak diperluas atau
--    dipersempit diam-diam).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Discount policy settings -- owner-only manage (LOCK Gate 3B)
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "kdp_manage" ON public.knowledge_discount_policies;
CREATE POLICY "kdp_manage" ON public.knowledge_discount_policies
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner'])
  );

-- -----------------------------------------------------------------------------
-- 2. Sales order update -- enforce ownership boundary inside the RPC
--    (bypass roles mirror sales_orders_select's role array, minus 'finance'
--    which never holds 'orders.update' per role_permissions seed anyway).
-- -----------------------------------------------------------------------------

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
  v_actor_bypasses_ownership BOOLEAN;
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

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_actor_id
      AND ur.company_id = p_company_id
      AND r.name IN ('owner', 'manager', 'admin', 'super_admin')
  ) INTO v_actor_bypasses_ownership;

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
