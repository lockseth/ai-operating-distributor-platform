-- =============================================================================
-- Gate 3E-D3-A -- Sales Auto-Attribution Enforcement
--
-- Audit findings (baca CLAUDE.md gate prompt untuk kontrak lengkap):
--
-- 1. customers_insert/customers_update (migration 20260626000004, diperbaiki
--    parsial oleh 20260918000002) tidak pernah menegakkan bahwa Sales hanya
--    boleh mengatribusikan toko kepada DIRINYA SENDIRI. customers_update
--    khususnya memakai permission 'customers.update' sebagai jalur bypass --
--    role 'sales' JUGA memegang permission itu (lihat seed
--    20260707000001_seed_system_role_permissions.sql), sehingga secara tidak
--    sengaja Sales bisa UPDATE (termasuk reassign assigned_sales_id) customer
--    SIAPA PUN di tenant, bukan cuma miliknya. Fix: bypass sekarang memakai
--    role bypass array yang sama dengan yang sudah dipakai di
--    sales_orders_select/update_sales_order_atomic (owner/manager/admin/
--    super_admin) -- admin tetap bisa mengelola seluruh customer (regresi
--    diverifikasi oleh cross-tenant-and-rls.integration.test.ts #3), sales
--    hanya boleh menyentuh baris miliknya sendiri DAN tidak bisa mengubah
--    assigned_sales_id menjauh dari dirinya (WITH CHECK). customers_insert
--    ditambah WITH CHECK serupa (defense-in-depth -- role 'sales' saat ini
--    TIDAK memegang 'customers.create' per seed, tapi RPC/RLS tidak boleh
--    bergantung pada itu tetap begitu selamanya).
--
-- 2. create_sales_order_atomic (migration 20260822000001) menerima p_sales_id
--    mentah dari client TANPA validasi ownership sama sekali -- order-form.tsx
--    menampilkan dropdown seluruh sales ke actor mana pun yang punya
--    orders.create, termasuk Sales sendiri. Migration Gate 3B
--    (20260905000001) sudah menambah ownership boundary untuk UPDATE dan
--    secara eksplisit mencatat create belum diperbaiki ("dilaporkan sebagai
--    gap, belum jelas kontraknya") -- persis scope gate ini. Fix: actor
--    non-bypass (Sales) SELALU diatribusikan ke dirinya sendiri
--    (p_sales_id dari client diabaikan total, bukan divalidasi), actor bypass
--    (owner/manager/admin/super_admin) tetap bebas memilih sales_id seperti
--    sebelumnya (workflow assignment existing tidak berubah).
--
-- 3. Baik create maupun update_sales_order_atomic tidak pernah memeriksa
--    apakah customer yang dipakai sudah diatribusikan ke Sales lain. Fix:
--    actor non-bypass ditolak (customer_not_owned) HANYA bila
--    customers.assigned_sales_id sudah terisi DAN bukan milik actor --
--    customer yang BELUM ter-attribute (assigned_sales_id NULL) tetap
--    diizinkan, dibuktikan oleh kontrak existing yang sudah di-assert
--    gate-3b-role-permission-matrix.integration.test.ts test #17 ("Sales
--    masih BISA membuat sales order baru miliknya sendiri" untuk customer
--    tanpa assigned_sales_id). Tidak ada auto-claim/transfer toko yang
--    ditambahkan -- customers.assigned_sales_id TIDAK disentuh oleh RPC ini.
--
-- 4. create_draft_sales_order_atomic/update_draft_sales_order_atomic
--    (jalur Telegram) sudah memakai p_sales_id/p_actor_id tepercaya dari
--    identity resolve (bukan klaim mentah) -- tapi belum memeriksa ownership
--    customer yang di-resolve dari teks (pricing.ts), dan
--    update_draft_sales_order_atomic belum memverifikasi p_actor_id adalah
--    pemilik draft order yang diedit (defense-in-depth terhadap pemanggilan
--    RPC langsung yang di-spoof -- alur normal lewat workflow.ts sudah aman
--    karena conversation_state di-scope per identity, tapi RPC sendiri tidak
--    boleh mempercayai caller tanpa verifikasi, sesuai catatan header
--    migration 20260822000001). Kedua RPC ini adalah kanal sales-only
--    (capability sales.order.telegram cuma role 'sales', lihat
--    telegram-enrollment/capability.ts) -- tidak ada konsep bypass role di
--    sini.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. customers_insert -- WITH CHECK ownership (defense-in-depth)
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "customers_insert" ON public.customers;

CREATE POLICY "customers_insert" ON public.customers
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('customers.create')
    AND (
      public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
      OR assigned_sales_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- 2. customers_update -- bypass memakai ROLE (bukan permission customers.update
--    yang juga dipegang sales), Sales dibatasi ke baris miliknya sendiri, dan
--    tidak bisa mengubah assigned_sales_id menjauh dari dirinya (WITH CHECK).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "customers_update" ON public.customers;

CREATE POLICY "customers_update" ON public.customers
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
      OR assigned_sales_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
      OR assigned_sales_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- 3. Web order RPCs -- auto-attribution + customer ownership enforcement.
-- -----------------------------------------------------------------------------

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

  -- Gate 3E-D3-A: actor non-bypass (Sales) SELALU diatribusikan ke dirinya
  -- sendiri -- p_sales_id dari client diabaikan total, tidak divalidasi.
  v_effective_sales_id := CASE WHEN v_actor_bypasses_ownership THEN p_sales_id ELSE p_actor_id END;

  SELECT * INTO v_customer
  FROM public.customers c
  WHERE c.id = p_customer_id AND c.company_id = p_company_id;

  IF p_customer_id IS NULL OR NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Gate 3E-D3-A: toko yang SUDAH dimiliki Sales lain ditolak fail-closed.
  -- Toko belum ter-attribute (assigned_sales_id NULL) tetap diizinkan --
  -- lihat catatan #3 di header migration ini.
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

  SELECT COALESCE(SUM(x.total_amount), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(total_amount NUMERIC);
  v_tax_amount := ROUND((v_total_amount - p_discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - p_discount_amount + v_tax_amount;

  INSERT INTO public.sales_orders (
    company_id, order_number, customer_id, sales_id, status, notes,
    delivery_date, created_by, total_amount, discount_amount, tax_amount, final_amount
  ) VALUES (
    p_company_id, p_order_number, p_customer_id, v_effective_sales_id, 'draft', p_notes,
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

  -- Gate 3E-D3-A: sama seperti create -- non-bypass actor tidak bisa
  -- memindahkan order ke sales_id lain lewat parameter update.
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

  IF v_order.status NOT IN ('draft', 'confirmed') THEN
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

  -- Gate 3E-D3-A: lihat catatan customer_not_owned di create_sales_order_atomic.
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
      sales_id = v_effective_sales_id,
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

-- -----------------------------------------------------------------------------
-- 4. Telegram draft order RPCs -- customer ownership enforcement. Kanal ini
--    sales-only (capability sales.order.telegram), tidak ada konsep bypass
--    role -- p_sales_id/p_actor_id SUDAH tepercaya (resolve dari identity di
--    workflow, lihat header migration 20260822000001), jadi tidak perlu
--    override, hanya ditambah pengecekan ownership customer (dan, untuk
--    update, ownership order itu sendiri -- defense-in-depth terhadap
--    panggilan RPC langsung yang di-spoof).
-- -----------------------------------------------------------------------------

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
  v_customer public.customers%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_sales_id AND u.company_id = p_company_id AND u.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT * INTO v_customer
    FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
      RETURN;
    END IF;

    -- Gate 3E-D3-A: toko yang SUDAH dimiliki Sales lain ditolak fail-closed.
    -- Toko belum ter-attribute (assigned_sales_id NULL) tetap diizinkan.
    IF v_customer.assigned_sales_id IS NOT NULL AND v_customer.assigned_sales_id <> p_sales_id THEN
      RETURN QUERY SELECT 'customer_not_owned'::TEXT, NULL::UUID;
      RETURN;
    END IF;
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
  v_customer public.customers%ROWTYPE;
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

  -- Gate 3E-D3-A: defense-in-depth -- RPC tidak boleh mempercayai caller
  -- tanpa verifikasi (lihat header migration 20260822000001). Alur normal
  -- (workflow.ts) selalu memanggil ini dengan actor = identity pemilik
  -- conversation_state/pendingOrderId, jadi ini seharusnya tidak pernah
  -- gagal lewat UI Telegram asli -- hanya menutup jalur RPC langsung yang
  -- di-spoof.
  IF v_order.sales_id IS DISTINCT FROM p_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF v_order.status != 'draft' THEN
    RETURN QUERY SELECT 'not_draft'::TEXT;
    RETURN;
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT * INTO v_customer
    FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invalid_customer'::TEXT;
      RETURN;
    END IF;

    -- Gate 3E-D3-A: lihat catatan customer_not_owned di
    -- create_draft_sales_order_atomic.
    IF v_customer.assigned_sales_id IS NOT NULL AND v_customer.assigned_sales_id <> p_actor_id THEN
      RETURN QUERY SELECT 'customer_not_owned'::TEXT;
      RETURN;
    END IF;
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
