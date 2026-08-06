-- =============================================================================
-- Gate 3E-D3-B -- Telegram Draft `missing_fields` JSONB Fix
--
-- Root cause (ditemukan saat verifikasi hosted Gate 3E-D3-A): parameter
-- p_missing_fields bertipe TEXT[] ditulis LANGSUNG ke kolom
-- sales_orders.missing_fields yang bertipe jsonb, tanpa cast. Postgres
-- menolak assignment ini pada plan-time (SQLSTATE 42804, "column
-- \"missing_fields\" is of type jsonb but expression is of type text[]"),
-- untuk SEMUA pemanggil, terlepas dari isi datanya (termasuk array kosong).
-- Pola ini sudah ada sejak migration 20260908000001 (belum pernah berhasil
-- complete lewat jalur create/update draft manapun) dan dibawa apa adanya
-- (tidak diubah) oleh 20260919000001 -- migration itu hanya menambah
-- ownership check yang berjalan SEBELUM statement yang gagal ini, sehingga
-- baru benar-benar tereksekusi saat actor lolos ownership check.
--
-- Fix: konversi p_missing_fields (TEXT[]) ke jsonb secara eksplisit dan
-- deterministik memakai to_jsonb() bawaan Postgres -- cast native, tanpa
-- SQL dinamis/concatenation (tidak ada permukaan SQL injection baru), dan
-- tidak ambigu: to_jsonb(text[]) SELALU menghasilkan JSONB array of string
-- (mis. ["customer.name","items[0].quantity"]), bukan objek atau string
-- JSON. COALESCE(..., ARRAY[]::text[]) memastikan input NULL juga
-- menghasilkan jsonb '[]' yang valid, bukan SQL NULL.
--
-- Scope: HANYA baris INSERT/UPDATE missing_fields di dalam
-- create_draft_sales_order_atomic dan update_draft_sales_order_atomic.
-- Signature RPC (nama & tipe parameter) TIDAK berubah -- tidak ada alasan
-- mutlak untuk mengubahnya, aplikasi (repository.ts) tetap mengirim
-- string[] biasa lewat p_missing_fields apa adanya. Seluruh logika lain
-- (ownership check, auto-attribution, permission check) dari Gate 3E-D3-A
-- disalin apa adanya (CREATE OR REPLACE FUNCTION menimpa seluruh body,
-- sehingga tidak boleh ada perubahan tersembunyi di luar baris yang
-- disebut di atas).
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
    to_jsonb(COALESCE(p_missing_fields, ARRAY[]::TEXT[])), p_requires_discount_review, p_delivery_note,
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
      missing_fields = to_jsonb(COALESCE(p_missing_fields, ARRAY[]::TEXT[])),
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
