-- =============================================================================
-- Gate 3E-D4-C7 -- Telegram Order Pricing, Command, and Dashboard Visibility
-- Fix (pricing bagian server-side).
--
-- Root cause (dibuktikan lewat SO-2608-0001, hosted mcbwgvtkhykrrtvbpeys,
-- flag telegram_sales_orders di-OFF-kan sebelum audit ini): kedua RPC draft
-- Telegram (create_draft_sales_order_atomic/update_draft_sales_order_atomic,
-- terakhir diganti 20260920000001) MENERIMA sales_order_items.unit_price
-- LANGSUNG dari client (x.unit_price pada p_items JSONB, diisi
-- apps/web/src/lib/sales-orders/pricing.ts dari field harga OPSIONAL hasil
-- parsing teks Telegram) -- TIDAK PERNAH mengambil/memvalidasi harga master
-- dari products.price sama sekali. Kedua RPC ini JUGA tidak pernah
-- memvalidasi product_id (null/cross-tenant/inactive/ambigu semua lolos
-- tanpa penolakan) -- berbeda dari create_sales_order_atomic (jalur non-
-- draft, 20260919000001) yang SUDAH memvalidasi keberadaan+tenant produk.
-- Order sales normal (tanpa menyebut harga di pesan Telegram -- pola lazim,
-- lihat extraction.ts baris "Harga -- OPSIONAL") akan selalu memakai
-- unit_price=0 default dari pricing.ts, tersimpan apa adanya. Dibuktikan
-- LANGSUNG (bukan asumsi): SO-2608-0001 -- product_id NULL, unit_price=0,
-- total_amount=0, final_amount=0, sampai berhasil confirmed (Gate 3E-D4-C5
-- recompute total dari unit_price yang SUDAH salah, jadi tetap 0).
--
-- Fix (scope SEMPIT -- HANYA jalur draft Telegram, mengikuti pola formula
-- IDENTIK Gate 3E-D4-C5/submit_special_price_proposal_atomic): product_id
-- WAJIB non-null, aktif, tenant benar, DAN products.price > 0 -- gagal salah
-- satu = 'invalid_product', ZERO writes (tidak ada INSERT sales_orders sama
-- sekali). unit_price/amount_before_discount/discount_amount/total_amount
-- item SEKARANG direkomputasi server-side dari products.price (master),
-- x.unit_price dari client diabaikan total -- Telegram/parser TIDAK PERNAH
-- lagi menjadi sumber harga untuk order harga normal (kontrak eksplisit gate
-- ini). discount_type/discount_value (assertion diskon dari teks sales,
-- mekanisme discount-policy review yang SUDAH ada, TIDAK diubah) tetap
-- dipakai apa adanya untuk menghitung discount_amount TERHADAP harga master
-- yang baru. p_total_amount/p_discount_amount/p_final_amount order-level
-- dari client JUGA diabaikan, direkomputasi dari SUM item yang baru --
-- konsisten dengan pola "server tidak pernah percaya agregat client" yang
-- sudah dipakai create_sales_order_atomic/confirm_sales_order_atomic.
--
-- TIDAK diubah: signature RPC (identik, repository.ts tidak perlu berubah),
-- validasi ownership/status/draft-only yang sudah ada, kontrak special-price/
-- approval Owner (C1-C6, jalur TERPISAH lewat auth.uid()/web app, tidak
-- disentuh sama sekali), RLS, grants (REPLACE mempertahankan grant lama).
--
-- Temuan #4 (field-language parsing, sesi UAT sama): p_customer_id NULL
-- DENGAN p_customer_name_raw diisi (teks toko ADA tapi tidak resolve ke satu
-- customer pasti -- termasuk setelah fallback word-containment app-layer,
-- lihat pricing.ts resolveCustomerId/normalize.ts containsAllWords) SEKARANG
-- JUGA ditolak 'invalid_customer', zero writes -- simetris dengan product_id
-- di atas. p_customer_id NULL DAN p_customer_name_raw NULL (toko memang
-- tidak disebutkan) TETAP diizinkan lolos, kontrak existing tidak disentuh.
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
  v_invalid_product_count INTEGER;
  v_total_amount NUMERIC;
  v_discount_amount NUMERIC;
  v_final_amount NUMERIC;
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
  ELSIF p_customer_name_raw IS NOT NULL THEN
    -- Gate 3E-D4-C7 (Temuan #4 -- field-language parsing): p_customer_id
    -- NULL DAN p_customer_name_raw diisi berarti teks toko ADA di pesan
    -- tapi TIDAK resolve ke satu customer pasti (NOT_FOUND atau ambigu --
    -- keduanya sudah collapsed jadi customerId null di pricing.ts, termasuk
    -- setelah fallback word-containment). Kebalikan Gate 3E-B lama (dulu
    -- diizinkan lolos sebagai fallback raw-text): sekarang ditolak fail-
    -- closed, zero writes -- balasan (buildOrderRejectedReply) meminta
    -- sales memperjelas nama toko. p_customer_id NULL DAN p_customer_name_
    -- raw NULL (toko memang tidak disebutkan sama sekali di pesan) TETAP
    -- diizinkan lolos -- kontrak existing, bukan bagian gate ini.
    RETURN QUERY SELECT 'invalid_customer'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Gate 3E-D4-C7: product_id WAJIB non-null, aktif, tenant benar, dan
  -- punya harga master > 0 -- mencakup NOT_FOUND/ambigu (keduanya sudah
  -- collapsed jadi productId null di pricing.ts), cross-tenant, inactive,
  -- dan harga master NULL/0/negatif. Jika p_items kosong, loop ini tidak
  -- menemukan baris invalid (v_invalid_product_count=0) -- konsisten dengan
  -- perilaku sebelumnya untuk kasus itu (di luar scope gate ini, dicegah di
  -- app layer oleh isLikelyOrderMessage sebelum RPC ini pernah dipanggil).
  SELECT COUNT(*) INTO v_invalid_product_count
  FROM jsonb_to_recordset(p_items) AS x(product_id UUID)
  WHERE x.product_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.products pr
       WHERE pr.id = x.product_id AND pr.company_id = p_company_id
         AND pr.is_active = TRUE AND pr.price > 0
     );
  IF v_invalid_product_count > 0 THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Gate 3E-D4-C7: total/discount/final order-level direkomputasi dari
  -- harga master per item (bukan p_total_amount/p_discount_amount/
  -- p_final_amount dari client) -- formula per-item IDENTIK blok INSERT di
  -- bawah supaya SUM konsisten dengan baris yang benar-benar tersimpan.
  SELECT
    COALESCE(SUM(ROUND(x.quantity * pr.price, 2)), 0),
    COALESCE(SUM(
      CASE
        WHEN x.discount_type = 'percentage' AND x.discount_value IS NOT NULL
          THEN ROUND(x.quantity * pr.price * (x.discount_value / 100.0), 2)
        WHEN x.discount_type = 'nominal' AND x.discount_value IS NOT NULL
          THEN x.discount_value
        ELSE 0
      END
    ), 0)
  INTO v_total_amount, v_discount_amount
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID, quantity NUMERIC, discount_type TEXT, discount_value NUMERIC
  )
  JOIN public.products pr ON pr.id = x.product_id AND pr.company_id = p_company_id;

  v_final_amount := GREATEST(0, v_total_amount - v_discount_amount);

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
    p_telegram_event_id, v_total_amount, v_discount_amount, 0,
    v_final_amount, p_sales_id
  )
  RETURNING id INTO v_order_id;

  IF jsonb_array_length(p_items) > 0 THEN
    INSERT INTO public.sales_order_items (
      order_id, product_id, product_name_raw, quantity, unit, unit_price,
      discount_type, discount_value, amount_before_discount, discount_amount,
      discount_exception, total_amount
    )
    SELECT
      v_order_id, x.product_id, x.product_name_raw, x.quantity, x.unit, pr.price,
      x.discount_type, x.discount_value,
      ROUND(x.quantity * pr.price, 2) AS amount_before_discount,
      CASE
        WHEN x.discount_type = 'percentage' AND x.discount_value IS NOT NULL
          THEN ROUND(x.quantity * pr.price * (x.discount_value / 100.0), 2)
        WHEN x.discount_type = 'nominal' AND x.discount_value IS NOT NULL
          THEN x.discount_value
        ELSE 0
      END AS discount_amount,
      x.discount_exception,
      GREATEST(0, ROUND(
        x.quantity * pr.price - (
          CASE
            WHEN x.discount_type = 'percentage' AND x.discount_value IS NOT NULL
              THEN x.quantity * pr.price * (x.discount_value / 100.0)
            WHEN x.discount_type = 'nominal' AND x.discount_value IS NOT NULL
              THEN x.discount_value
            ELSE 0
          END
        ), 2
      )) AS total_amount
    FROM jsonb_to_recordset(p_items) AS x(
      product_id UUID, product_name_raw TEXT, quantity NUMERIC, unit TEXT,
      unit_price NUMERIC, discount_type TEXT, discount_value NUMERIC,
      amount_before_discount NUMERIC, discount_amount NUMERIC,
      discount_exception BOOLEAN, total_amount NUMERIC
    )
    JOIN public.products pr ON pr.id = x.product_id AND pr.company_id = p_company_id;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_sales_id, 'order.create', 'sales_orders', v_order_id,
    jsonb_build_object(
      'order_number', p_order_number, 'customer_id', p_customer_id,
      'order_source', p_order_source, 'final_amount', v_final_amount
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
  v_invalid_product_count INTEGER;
  v_total_amount NUMERIC;
  v_discount_amount NUMERIC;
  v_final_amount NUMERIC;
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
  -- tanpa verifikasi (lihat header migration 20260822000001). TIDAK diubah.
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
  ELSIF p_customer_name_raw IS NOT NULL THEN
    -- Gate 3E-D4-C7 (Temuan #4): lihat catatan identik di
    -- create_draft_sales_order_atomic -- dijalankan SEBELUM DELETE
    -- sales_order_items manapun, sehingga koreksi (UBAH) yang gagal
    -- validasi customer tidak menyentuh draft lama sama sekali.
    RETURN QUERY SELECT 'invalid_customer'::TEXT;
    RETURN;
  END IF;

  -- Gate 3E-D4-C7: lihat catatan create_draft_sales_order_atomic -- product_id
  -- WAJIB non-null, aktif, tenant benar, harga master > 0. Guard dijalankan
  -- SEBELUM DELETE sales_order_items manapun -- draft lama TIDAK disentuh
  -- sama sekali kalau koreksi baru gagal validasi (zero writes).
  SELECT COUNT(*) INTO v_invalid_product_count
  FROM jsonb_to_recordset(p_items) AS x(product_id UUID)
  WHERE x.product_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.products pr
       WHERE pr.id = x.product_id AND pr.company_id = p_company_id
         AND pr.is_active = TRUE AND pr.price > 0
     );
  IF v_invalid_product_count > 0 THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT;
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(ROUND(x.quantity * pr.price, 2)), 0),
    COALESCE(SUM(
      CASE
        WHEN x.discount_type = 'percentage' AND x.discount_value IS NOT NULL
          THEN ROUND(x.quantity * pr.price * (x.discount_value / 100.0), 2)
        WHEN x.discount_type = 'nominal' AND x.discount_value IS NOT NULL
          THEN x.discount_value
        ELSE 0
      END
    ), 0)
  INTO v_total_amount, v_discount_amount
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID, quantity NUMERIC, discount_type TEXT, discount_value NUMERIC
  )
  JOIN public.products pr ON pr.id = x.product_id AND pr.company_id = p_company_id;

  v_final_amount := GREATEST(0, v_total_amount - v_discount_amount);

  DELETE FROM public.sales_order_items WHERE order_id = p_order_id;

  IF jsonb_array_length(p_items) > 0 THEN
    INSERT INTO public.sales_order_items (
      order_id, product_id, product_name_raw, quantity, unit, unit_price,
      discount_type, discount_value, amount_before_discount, discount_amount,
      discount_exception, total_amount
    )
    SELECT
      p_order_id, x.product_id, x.product_name_raw, x.quantity, x.unit, pr.price,
      x.discount_type, x.discount_value,
      ROUND(x.quantity * pr.price, 2) AS amount_before_discount,
      CASE
        WHEN x.discount_type = 'percentage' AND x.discount_value IS NOT NULL
          THEN ROUND(x.quantity * pr.price * (x.discount_value / 100.0), 2)
        WHEN x.discount_type = 'nominal' AND x.discount_value IS NOT NULL
          THEN x.discount_value
        ELSE 0
      END AS discount_amount,
      x.discount_exception,
      GREATEST(0, ROUND(
        x.quantity * pr.price - (
          CASE
            WHEN x.discount_type = 'percentage' AND x.discount_value IS NOT NULL
              THEN x.quantity * pr.price * (x.discount_value / 100.0)
            WHEN x.discount_type = 'nominal' AND x.discount_value IS NOT NULL
              THEN x.discount_value
            ELSE 0
          END
        ), 2
      )) AS total_amount
    FROM jsonb_to_recordset(p_items) AS x(
      product_id UUID, product_name_raw TEXT, quantity NUMERIC, unit TEXT,
      unit_price NUMERIC, discount_type TEXT, discount_value NUMERIC,
      amount_before_discount NUMERIC, discount_amount NUMERIC,
      discount_exception BOOLEAN, total_amount NUMERIC
    )
    JOIN public.products pr ON pr.id = x.product_id AND pr.company_id = p_company_id;
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
      total_amount = v_total_amount,
      discount_amount = v_discount_amount,
      final_amount = v_final_amount
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
      'final_amount', v_final_amount
    ),
    'sales', 'audit', 'orders', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.create_draft_sales_order_atomic(UUID, UUID, TEXT, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB) IS
  'Gate 3E-D4-C7: product_id per item WAJIB non-null/aktif/tenant-benar/harga master>0 (zero writes jika gagal) -- unit_price/amount_before_discount/discount_amount/total_amount per item DAN total/discount/final order-level direkomputasi server-side dari products.price, mengabaikan x.unit_price dan p_total_amount/p_discount_amount/p_final_amount dari client sepenuhnya. Telegram/parser tidak pernah lagi menjadi sumber harga untuk order harga normal.';

COMMENT ON FUNCTION public.update_draft_sales_order_atomic(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB) IS
  'Gate 3E-D4-C7: guard/recompute IDENTIK create_draft_sales_order_atomic (lihat komentar di sana) -- dijalankan SEBELUM DELETE sales_order_items manapun, sehingga koreksi (UBAH) yang gagal validasi harga/produk tidak menyentuh draft lama sama sekali.';
