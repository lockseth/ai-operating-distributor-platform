-- =============================================================================
-- Gate 3E-B — Telegram Sales Order Live Demo Readiness: Order Intake
-- Validation Hardening (create_draft_sales_order_atomic,
-- update_draft_sales_order_atomic).
--
-- Gap found during Gate 3E-B audit: kedua RPC ini sudah memvalidasi
-- p_customer_id (bila diisi) menunjuk baris `customers` pada company_id yang
-- sama, TAPI tidak pernah memeriksa customers.is_active, dan SAMA SEKALI
-- tidak memvalidasi p_items[].product_id (tidak ada pengecekan company_id
-- atau is_active -- hanya FK existence). Toko/produk yang sudah dinonaktifkan,
-- atau (secara teori, lewat kesalahan data admin) product_id/customer_id
-- lintas tenant, bisa lolos ke draft order tanpa ditolak. Ditutup di sini,
-- konsisten dengan pola guard p_sales_id yang sudah ada di kedua fungsi ini.
--
-- Gap kedua: tidak ada validasi quantity item sama sekali -- pricing.ts
-- (aplikasi) default quantity yang gagal diekstrak ke 0, dan angka "0" pada
-- teks order (mis. lupa isi jumlah) tetap lolos sebagai item quantity=0.
-- Ditutup dengan guard quantity > 0 per item.
--
-- Additive murni: CREATE OR REPLACE pada signature yang SAMA PERSIS (tidak
-- ada perubahan tabel/kolom), menambah 2 result_outcome baru
-- ('invalid_product', 'invalid_quantity') dan memperluas kondisi
-- 'invalid_customer' yang sudah ada. Caller (apps/web/src/lib/sales-orders/
-- repository.ts) diperbarui pada sesi yang sama untuk menerjemahkan outcome
-- baru ini menjadi DraftOrderRejectedError -- balasan Telegram Bahasa
-- Indonesia yang aman, TIDAK PERNAH menulis order parsial (satu transaksi
-- fungsi, gagal di awal sebelum INSERT apa pun).
-- =============================================================================

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
    SELECT 1 FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id AND c.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(product_id UUID, quantity NUMERIC)
    WHERE x.product_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = x.product_id AND p.company_id = p_company_id AND p.is_active = TRUE
      )
  ) THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(quantity NUMERIC)
    WHERE x.quantity IS NULL OR x.quantity <= 0
  ) THEN
    RETURN QUERY SELECT 'invalid_quantity'::TEXT, NULL::UUID;
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
    SELECT 1 FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id AND c.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(product_id UUID, quantity NUMERIC)
    WHERE x.product_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = x.product_id AND p.company_id = p_company_id AND p.is_active = TRUE
      )
  ) THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS x(quantity NUMERIC)
    WHERE x.quantity IS NULL OR x.quantity <= 0
  ) THEN
    RETURN QUERY SELECT 'invalid_quantity'::TEXT;
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
