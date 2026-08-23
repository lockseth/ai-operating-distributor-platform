-- =============================================================================
-- Gate P4.16-C -- Tegakkan customer_locked_overdue di SEMUA jalur order:
-- create_sales_order_atomic (web), confirm_sales_order_atomic (choke point
-- tunggal draft->confirmed, dipakai web DAN Telegram), create_draft_sales_
-- order_atomic/update_draft_sales_order_atomic (Telegram). Signature KEEMPAT
-- RPC IDENTIK -- CREATE OR REPLACE murni menyisipkan guard + (pada 2 RPC
-- pertama) logika konsumsi exception, tidak ada baris existing yang diubah.
--
-- Titik konsumsi (kontrak rencana Fase 2, ~/.claude/plans/linear-strolling-
-- teacup.md): karena SEMUA order (web maupun Telegram) berstatus 'draft' saat
-- dibuat dan HANYA confirm_sales_order_atomic yang boleh memindahkan ke
-- 'confirmed' (Gate 3E-D4-C4/C5, LOCKED), consumed_at BISA terisi di DUA
-- titik berbeda:
--   (a) create_sales_order_atomic -- bila is_customer_order_locked() sudah
--       FALSE saat create (exception sudah tersedia sebelum order dibuat)
--       exception langsung dikonsumsi DI SINI, sebelum order sempat confirm.
--   (b) confirm_sales_order_atomic -- draft Telegram TIDAK PERNAH mengonsumsi
--       di titik create (create_draft_sales_order_atomic HANYA memblokir,
--       tidak mengonsumsi -- lihat bagian 3/4 di bawah); juga jaring
--       pengaman untuk order web yang statusnya berubah locked SETELAH create
--       tapi SEBELUM confirm.
-- Guard confirm SENGAJA melewati pemeriksaan locked kalau order INI SENDIRI
-- sudah tercatat sebagai consumed_by_order_id pada row store_unlock_requests
-- manapun (exception sudah terpakai untuk order ini persis di titik create)
-- -- TANPA pengecualian ini, order yang BARU SAJA mengonsumsi exception-nya
-- sendiri di create_sales_order_atomic akan langsung ter-re-lock lagi di
-- confirm_sales_order_atomic (invoice yang sama masih overdue), gagal
-- mengonfirmasi order yang justru dimaksudkan exception itu untuk diloloskan
-- -- dibuktikan lewat skenario 3 verifikasi rencana ("order berikutnya
-- berhasil, exception ter-konsumsi") sebelum guard ini ditulis final.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. create_sales_order_atomic -- guard setelah customer_not_owned, konsumsi
--    setelah order berhasil dibuat (SEBELUM insert sales_order_items, tidak
--    ada dependensi urutan).
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
  p_items JSONB,
  p_requested_delivery_date DATE DEFAULT NULL,
  p_payment_terms_days INTEGER DEFAULT NULL
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

  -- Gate P4.16-C: toko dengan invoice overdue >= H+3 dan tanpa exception
  -- unconsumed ditolak fail-closed SEBELUM order sempat tersimpan.
  IF public.is_customer_order_locked(p_company_id, p_customer_id) THEN
    RETURN QUERY SELECT 'customer_locked_overdue'::TEXT, NULL::UUID;
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
    requested_delivery_date,
    payment_terms_days
  ) VALUES (
    p_company_id, p_order_number, p_customer_id, v_effective_sales_id, 'draft', p_notes,
    p_delivery_date, p_actor_id, v_total_amount, p_discount_amount, v_tax_amount, v_final_amount,
    p_requested_delivery_date,
    p_payment_terms_days
  )
  RETURNING id INTO v_order_id;

  -- Gate P4.16-C: exception SEKALI PAKAI dikonsumsi di sini kalau tersedia
  -- (lihat header migration). Tanpa row APPROVED unconsumed, UPDATE ini
  -- match 0 baris -- no-op aman.
  UPDATE public.store_unlock_requests
  SET consumed_at = NOW(), consumed_by_order_id = v_order_id
  WHERE company_id = p_company_id AND customer_id = p_customer_id
    AND status = 'APPROVED' AND consumed_at IS NULL;

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

COMMENT ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE, INTEGER) IS
  'Gate P4.02/P4.16-C: create draft order. Guard baru Gate P4.16-C -- toko dengan invoice overdue >= H+3 tanpa exception unconsumed ditolak (customer_locked_overdue); bila exception APPROVED unconsumed tersedia, order tetap dibuat DAN exception langsung dikonsumsi (consumed_at/consumed_by_order_id).';

-- Signature TIDAK berubah -- REVOKE/GRANT dipertahankan identik migration
-- terakhir (20261006000001) supaya tidak ada regresi privilege.
REVOKE ALL ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB, DATE, INTEGER)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 2. confirm_sales_order_atomic -- guard antara Guard 1 (draft-only) dan
--    Guard 2 (pending-approval-exists), dengan pengecualian "order ini sudah
--    consumed_by_order_id" (lihat header migration). Konsumsi (jaring
--    pengaman draft Telegram) SEBELUM recompute total -- tidak mengubah
--    urutan Guard 2/3/recompute existing sama sekali.
-- -----------------------------------------------------------------------------

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
  v_order                 public.sales_orders%ROWTYPE;
  v_old_status             TEXT;
  v_current_special_count  INTEGER;
  v_latest_request         public.special_price_approval_requests%ROWTYPE;
  v_line_count             INTEGER;
  v_matched_count          INTEGER;
  v_recomputed_total       NUMERIC;
  v_recomputed_tax         NUMERIC;
  v_recomputed_final       NUMERIC;
  v_already_consumed_by_self BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_actor_id AND u.company_id = p_company_id AND u.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, FALSE;
    RETURN;
  END IF;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, FALSE;
    RETURN;
  END IF;

  v_old_status := v_order.status;

  IF v_old_status = 'confirmed' THEN
    RETURN QUERY SELECT 'already_confirmed'::TEXT, TRUE;
    RETURN;
  END IF;

  -- Guard 1 (Gate 3E-D4-C4, TIDAK diubah): hanya draft yang bisa dikonfirmasi.
  IF v_old_status <> 'draft' THEN
    RETURN QUERY SELECT 'invalid_order_state'::TEXT, FALSE;
    RETURN;
  END IF;

  -- Guard P4.16-C: toko terkunci ditolak DI SINI JUGA (defense-in-depth
  -- untuk draft yang dibuat sebelum toko locked, terutama jalur Telegram) --
  -- KECUALI order INI SENDIRI sudah tercatat sebagai consumed_by_order_id
  -- pada row manapun (exception sudah dikonsumsi persis untuk order ini di
  -- create_sales_order_atomic -- tanpa pengecualian ini order tsb akan
  -- langsung ter-re-lock lagi di sini, lihat header migration).
  SELECT EXISTS (
    SELECT 1 FROM public.store_unlock_requests sur WHERE sur.consumed_by_order_id = p_order_id
  ) INTO v_already_consumed_by_self;

  IF NOT v_already_consumed_by_self THEN
    IF public.is_customer_order_locked(p_company_id, v_order.customer_id) THEN
      RETURN QUERY SELECT 'customer_locked_overdue'::TEXT, FALSE;
      RETURN;
    END IF;

    -- Jaring pengaman konsumsi -- draft Telegram (create_draft_sales_order_
    -- atomic) TIDAK PERNAH mengonsumsi di titik create, jadi konsumsi
    -- pertama kali untuk order semacam ini terjadi DI SINI. No-op aman kalau
    -- tidak ada exception APPROVED unconsumed (toko memang tidak locked).
    UPDATE public.store_unlock_requests
    SET consumed_at = NOW(), consumed_by_order_id = p_order_id
    WHERE company_id = p_company_id AND customer_id = v_order.customer_id
      AND status = 'APPROVED' AND consumed_at IS NULL;
  END IF;

  -- Guard 2 (Gate 3E-D4-C4, TIDAK diubah): tidak boleh ada request PENDING.
  IF EXISTS (
    SELECT 1 FROM public.special_price_approval_requests spar
    WHERE spar.sales_order_id = p_order_id AND spar.status = 'PENDING'
  ) THEN
    RETURN QUERY SELECT 'pending_approval_exists'::TEXT, FALSE;
    RETURN;
  END IF;

  -- Guard 3 (Gate 3E-D6-A, menggantikan Guard 3 lama Gate 3E-D4-C4): evaluasi
  -- ULANG apakah order ini SAAT INI memakai harga khusus pada SELURUH
  -- sales_order_items -- formula IDENTIK submit_special_price_proposal_
  -- atomic/decide_special_price_proposal_atomic (precedence product >
  -- customer > global, tie-break updated_at DESC), ditambah precondition
  -- unit_price < products.price (lihat header migration -- mencegah order
  -- normal tanpa diskon sama sekali salah ditandai perlu approval hanya
  -- karena tidak ada knowledge_discount_policies yang dikonfigurasi).
  SELECT COUNT(*) INTO v_current_special_count
  FROM public.sales_order_items soi
  JOIN public.products pr ON pr.id = soi.product_id
  LEFT JOIN LATERAL (
    SELECT kdp.id AS policy_id, kdp.max_percentage, kdp.max_nominal
    FROM public.knowledge_discount_policies kdp
    WHERE kdp.company_id = p_company_id AND kdp.is_active = TRUE
      AND (
        (kdp.scope = 'product' AND kdp.product_id = soi.product_id)
        OR (kdp.scope = 'customer' AND v_order.customer_id IS NOT NULL AND kdp.customer_id = v_order.customer_id)
        OR (kdp.scope = 'global')
      )
    ORDER BY
      CASE kdp.scope WHEN 'product' THEN 1 WHEN 'customer' THEN 2 WHEN 'global' THEN 3 END ASC,
      kdp.updated_at DESC, kdp.id DESC
    LIMIT 1
  ) pol ON TRUE
  WHERE soi.order_id = p_order_id
    AND soi.unit_price < pr.price
    AND (
      pol.policy_id IS NULL
      OR (pol.max_percentage IS NULL AND pol.max_nominal IS NULL)
      OR (pol.max_percentage IS NOT NULL AND ((pr.price - soi.unit_price) / pr.price * 100) > pol.max_percentage)
      OR (pol.max_nominal IS NOT NULL AND ((pr.price - soi.unit_price) * soi.quantity) > pol.max_nominal)
    );

  IF v_current_special_count > 0 THEN
    SELECT * INTO v_latest_request
    FROM public.special_price_approval_requests spar
    WHERE spar.sales_order_id = p_order_id
    ORDER BY spar.proposal_version DESC
    LIMIT 1;

    IF NOT FOUND THEN
      -- Celah utama Gate 3E-D6-A: order TIDAK PERNAH memanggil submit_
      -- special_price_proposal_atomic sama sekali -- sebelumnya Guard 3
      -- lama dilewati total pada kondisi ini.
      RETURN QUERY SELECT 'unapproved_special_price'::TEXT, FALSE;
      RETURN;
    END IF;

    IF v_latest_request.status = 'APPROVED' THEN
      SELECT COUNT(*) INTO v_line_count
      FROM public.special_price_approval_lines spal
      WHERE spal.approval_request_id = v_latest_request.id;

      SELECT COUNT(*) INTO v_matched_count
      FROM public.special_price_approval_lines spal
      JOIN public.sales_order_items soi ON soi.id = spal.sales_order_item_id
      WHERE spal.approval_request_id = v_latest_request.id
        AND soi.order_id = p_order_id
        AND soi.product_id = spal.product_id
        AND soi.quantity = spal.quantity
        AND soi.unit_price = spal.proposed_unit_price;

      -- v_matched_count wajib sama dengan v_current_special_count JUGA --
      -- bukan hanya v_line_count -- supaya item harga khusus LAIN yang tidak
      -- pernah tercakup approval request ini (celah cakupan parsial) ikut
      -- terdeteksi (v_current_special_count > v_matched_count).
      IF v_line_count = 0 OR v_matched_count <> v_line_count OR v_matched_count <> v_current_special_count THEN
        RETURN QUERY SELECT 'approval_snapshot_mismatch'::TEXT, FALSE;
        RETURN;
      END IF;
    ELSE
      -- REJECTED (atau status lain di luar PENDING/APPROVED -- PENDING
      -- sudah tertutup Guard 2): order masih memakai harga khusus current
      -- tanpa keputusan APPROVED yang berlaku -- fail-closed, strictly lebih
      -- kuat dari pemeriksaan restore-per-baris lama (lihat header migration).
      RETURN QUERY SELECT 'unapproved_special_price'::TEXT, FALSE;
      RETURN;
    END IF;
  END IF;

  -- Gate 3E-D4-C5 (TIDAK diubah): recompute total_amount/tax_amount/
  -- final_amount server-side dari sales_order_items SAAT INI.
  SELECT COALESCE(SUM(GREATEST(0, ROUND(soi.quantity * soi.unit_price - soi.discount_amount, 2))), 0)
  INTO v_recomputed_total
  FROM public.sales_order_items soi
  WHERE soi.order_id = p_order_id;

  v_recomputed_tax   := ROUND((v_recomputed_total - v_order.discount_amount) * 0.11, 2);
  v_recomputed_final := v_recomputed_total - v_order.discount_amount + v_recomputed_tax;

  UPDATE public.sales_orders
  SET status = 'confirmed',
      total_amount = v_recomputed_total,
      tax_amount   = v_recomputed_tax,
      final_amount = v_recomputed_final,
      payment_terms_days = CASE WHEN p_payment_terms_days IS NOT NULL THEN p_payment_terms_days ELSE payment_terms_days END
  WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.confirm', 'sales_orders', p_order_id,
    jsonb_build_object('status', v_old_status, 'total_amount', v_order.total_amount, 'final_amount', v_order.final_amount),
    jsonb_build_object('status', 'confirmed', 'payment_terms_days', p_payment_terms_days, 'total_amount', v_recomputed_total, 'final_amount', v_recomputed_final),
    'sales', 'audit', 'orders', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'confirmed'::TEXT, FALSE;
END;
$$;

COMMENT ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER) IS
  'Gate 3E-D4-C4 (guard draft-only/pending-request, TIDAK diubah) + Gate 3E-D4-C5 (recompute total/tax/final, TIDAK diubah) + Gate 3E-D6-A (Guard 3 SELALU mengevaluasi ulang harga khusus, TIDAK diubah) + Gate P4.16-C (toko locked ditolak DI SINI JUGA kecuali order ini sudah consumed_by_order_id sebelumnya; jaring pengaman konsumsi exception untuk draft Telegram yang belum sempat konsumsi di titik create). Satu-satunya RPC yang boleh memindahkan sales_orders.status -> confirmed.';

REVOKE ALL ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 3. create_draft_sales_order_atomic (Telegram) -- guard SETELAH blok
--    resolusi customer (p_customer_id IS NOT NULL / ELSIF p_customer_name_raw),
--    SEBELUM validasi produk. TIDAK mengonsumsi exception (lihat header
--    migration -- konsumsi untuk draft Telegram terjadi di confirm).
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

    -- Gate P4.16-C: toko terkunci ditolak fail-closed. TIDAK mengonsumsi
    -- exception di sini (lihat header migration) -- konsumsi untuk draft
    -- Telegram terjadi di confirm_sales_order_atomic.
    IF public.is_customer_order_locked(p_company_id, p_customer_id) THEN
      RETURN QUERY SELECT 'customer_locked_overdue'::TEXT, NULL::UUID;
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

-- -----------------------------------------------------------------------------
-- 4. update_draft_sales_order_atomic (Telegram) -- guard IDENTIK, dijalankan
--    SEBELUM DELETE sales_order_items manapun (draft lama tidak disentuh
--    kalau gagal validasi, pola sama Gate 3E-D4-C7).
-- -----------------------------------------------------------------------------

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

    -- Gate P4.16-C: lihat catatan create_draft_sales_order_atomic -- tidak
    -- mengonsumsi exception di sini.
    IF public.is_customer_order_locked(p_company_id, p_customer_id) THEN
      RETURN QUERY SELECT 'customer_locked_overdue'::TEXT;
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
  'Gate 3E-D4-C7/P4.16-C: product_id per item WAJIB non-null/aktif/tenant-benar/harga master>0 (zero writes jika gagal). Guard baru Gate P4.16-C -- toko locked ditolak (customer_locked_overdue), TIDAK mengonsumsi exception di sini (konsumsi terjadi di confirm_sales_order_atomic).';

COMMENT ON FUNCTION public.update_draft_sales_order_atomic(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT[], BOOLEAN, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB) IS
  'Gate 3E-D4-C7/P4.16-C: guard/recompute IDENTIK create_draft_sales_order_atomic (lihat komentar di sana) -- dijalankan SEBELUM DELETE sales_order_items manapun.';

-- Signature TIDAK berubah -- REVOKE/GRANT dipertahankan (kedua RPC ini tidak
-- pernah punya REVOKE/GRANT eksplisit di migration sebelumnya -- default
-- privilege PostgreSQL untuk fungsi SECURITY DEFINER baru berlaku, konsisten
-- histori migration 20260929000001 yang juga tidak menambahkannya).
