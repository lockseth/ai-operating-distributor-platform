-- =============================================================================
-- Gate 3E-D4-C5 -- Order Price Mutation Enforcement & Approval-History
-- Integrity (closure gate).
--
-- Audit dilakukan terhadap SELURUH jalur yang dapat mengubah harga/unit
-- price/nilai turunan pada sales_order_items, subtotal/tax/discount/final
-- amount pada sales_orders, dan snapshot/histori approval (direct SQL, RPC
-- lama/baru, trigger, grants, role authenticated) sebelum fix ditulis --
-- lihat "Root cause dibuktikan" di bawah untuk reproduksi NYATA terhadap DB
-- lokal (bukan asumsi).
--
-- Temuan #1 (Celah A -- root cause paling tajam, BELUM PERNAH tercatat di
-- gate manapun sebelumnya): create_sales_order_atomic (20260919000001) dan
-- update_sales_order_atomic (20260922000001, draft-only) MENERIMA
-- sales_order_items.total_amount LANGSUNG dari client (x.total_amount pada
-- p_items JSONB) -- TIDAK PERNAH direkomputasi server-side dari
-- quantity*unit_price-discount_amount. unit_price itu sendiri SUDAH benar
-- divalidasi (invalid_product check, dan pada submit_special_price_proposal_
-- atomic dibandingkan terhadap products.price + knowledge_discount_policies)
-- -- tapi total_amount adalah kolom TERPISAH yang tidak pernah diperiksa
-- konsistensinya terhadap unit_price*quantity-discount_amount di MANA PUN
-- (base table hanya CHECK total_amount >= 0, tidak ada relasi ke kolom lain).
-- v_total_amount order-level dihitung sebagai SUM(x.total_amount) dari nilai
-- yang sama-sama client-trusted ini (create_sales_order_atomic baris 206-207,
-- update_sales_order_atomic/20260922000001 baris 203-204) -- sehingga
-- sales_orders.total_amount/tax_amount/final_amount ikut fabricated.
--
-- Direproduksi LANGSUNG (apps/web/src/lib/orders/gate-3e-d4-c5-price-
-- mutation-repro.integration.test.ts, dijalankan terhadap Postgres lokal
-- sebelum fix ini ditulis, dihapus pada commit yang sama dengan migration
-- ini setelah regression test permanen menggantikannya): order dibuat lewat
-- create_sales_order_atomic dengan SATU line unit_price=100000 (PERSIS
-- products.price -- TIDAK PERNAH memicu submit_special_price_proposal_atomic
-- sama sekali, tidak ada riwayat approval), quantity=10 (nilai sah =
-- 1.000.000), tapi client mengirim total_amount=1. Hasil TERBUKTI:
-- sales_order_items.total_amount tersimpan = 1 (bukan 1.000.000),
-- sales_orders.final_amount = 1.11, confirm_sales_order_atomic BERHASIL
-- ('confirmed') TANPA pemeriksaan apa pun (tidak ada riwayat approval untuk
-- diperiksa Guard 3 -- order ini bahkan tidak pernah "terlihat" sebagai
-- harga khusus karena unit_price tidak pernah menyimpang dari master), dan
-- sales_kpi_achievement_events REVENUE dikredit PERSIS pada nilai fabrikasi
-- (1.11, bukan 1.110.000) -- KPI/revenue reporting rusak total tanpa
-- menyentuh unit_price atau workflow approval sama sekali. Ini adalah jalur
-- "di luar workflow harga khusus/approval yang sah" paling tajam karena
-- SAMA SEKALI tidak terlihat oleh mekanisme approval manapun (C1-C4)
-- -- unit_price legitimate, hanya total_amount yang dipalsukan.
--
-- Temuan #2 (Celah B -- "order setelah keputusan approval" dan order biasa,
-- direct DML): confirm_sales_order_atomic (20260926000001) TIDAK PERNAH
-- merekomputasi sales_orders.total_amount/tax_amount/final_amount dari
-- sales_order_items -- RPC ini HANYA men-set status='confirmed' (+
-- payment_terms_days), mempercayai APA PUN yang sudah tersimpan di kolom
-- tsb. sales_orders_update RLS (20260626000004, diperketat 20260923000001
-- HANYA untuk status='pending_owner_approval') tidak membatasi KOLOM yang
-- boleh diubah -- Sales pemilik order draft (dan pemegang orders.manage)
-- bisa langsung UPDATE total_amount/tax_amount/discount_amount/final_amount
-- lewat direct PostgREST client SELAMA status tidak berubah menjadi/dari
-- pending_owner_approval. Ini termasuk order YANG BARU SAJA keluar dari
-- decide_special_price_proposal_atomic (status kembali ke draft) -- snapshot
-- match Guard 3 confirm HANYA memeriksa product_id/quantity/unit_price
-- (pola identik decide), TIDAK PERNAH memeriksa total_amount/discount_amount
-- item, apalagi kolom AGREGAT pada sales_orders itu sendiri. Direproduksi
-- LANGSUNG (test file yang sama, kasus REPRO 2): order draft normal (tanpa
-- riwayat approval sama sekali) dengan item yang benar (quantity=10,
-- unit_price=100000, total_amount=1.000.000 -- SUDAH benar), lalu
-- sales_orders.final_amount di-UPDATE langsung (mensimulasikan direct
-- DML/jalur RPC lama yang tersedia lewat RLS existing) menjadi 1 --
-- confirm_sales_order_atomic BERHASIL ('confirmed') dan final_amount TETAP
-- 1 setelah confirm (tidak pernah dikoreksi).
--
-- Temuan #3 (Celah C, cakupan lain yang SUDAH terbukti tertutup -- dicatat
-- untuk kelengkapan audit, BUKAN celah baru): (a) products.price TIDAK
-- PERNAH ditulis oleh RPC order manapun (create/update/confirm/submit/
-- decide) -- grep menyeluruh terhadap seluruh migration order, satu-satunya
-- penulis products.price adalah commit_import_batch (master data import,
-- di luar domain order). (b) special_price_approval_requests/lines REVOKE
-- INSERT/UPDATE/DELETE HANYA dari authenticated/anon, TIDAK dari
-- service_role -- pola ini IDENTIK audit_logs (20260819000001, append-only
-- precedent yang dikutip eksplisit sebagai acuan C1), bukan oversight C1 --
-- service_role adalah credential trusted-server (getAdminClient(), tidak
-- pernah dipegang end-user), dan SECURITY DEFINER RPC submit/decide berjalan
-- sebagai pemilik fungsi (bukan service_role) sehingga REVOKE tsb tidak
-- memengaruhi RPC itu sendiri -- TIDAK diubah gate ini, didokumentasikan
-- sebagai residual risk inheren (kontrak eksplisit mengizinkan ini bila
-- didokumentasikan). (c) Guard 3 confirm_sales_order_atomic (product_id/
-- quantity/unit_price match) SUDAH terbukti menutup mutasi unit_price/
-- quantity/product_id pasca-decision (test C4 #7/#7b) -- gate ini TIDAK
-- mengubah Guard tsb, hanya menambah recompute total/tax/final SETELAH
-- Guard lolos sebagai lapis tambahan yang independen dari kebenaran kolom
-- total_amount/discount_amount itu sendiri.
--
-- Fix (scope SEMPIT -- server-side recalculation SAJA, pola formula IDENTIK
-- yang SUDAH dipakai submit_special_price_proposal_atomic/decide_special_
-- price_proposal_atomic (GREATEST(0, ROUND(quantity*harga-diskon, 2))
-- untuk item, ROUND((total-discount)*0.11,2) untuk tax, total-discount+tax
-- untuk final) -- TIDAK ADA policy/threshold/evaluasi diskon baru, TIDAK ADA
-- role/permission/kolom/tabel baru, TIDAK ADA perubahan RLS):
--
-- 1. create_sales_order_atomic, update_sales_order_atomic (CREATE OR
--    REPLACE, signature IDENTIK): sales_order_items.total_amount SEKARANG
--    direkomputasi server-side dari quantity*unit_price-discount_amount
--    (mengabaikan x.total_amount dari client sepenuhnya) -- SATU-SATUNYA
--    perubahan pada kedua RPC ini, seluruh validasi/ownership/tenant/status
--    check lain TIDAK disentuh.
-- 2. confirm_sales_order_atomic (CREATE OR REPLACE, signature IDENTIK):
--    SETELAH seluruh guard existing (draft-only, no-pending-request,
--    approved/rejected snapshot match -- TIDAK diubah) lolos, total_amount/
--    tax_amount/final_amount sales_orders direkomputasi ULANG dari
--    sales_order_items SAAT ITU (bukan kolom item.total_amount yang
--    tersimpan -- formula diturunkan LANGSUNG dari quantity/unit_price/
--    discount_amount mentah per baris, supaya baris yang di-DML langsung di
--    luar RPC manapun, atau baris lama dari SEBELUM gate ini, ikut
--    terkoreksi otomatis) dan ditulis dalam UPDATE yang SAMA dengan
--    status='confirmed' -- trg_sales_orders_credit_order_kpi
--    (20260917000001, AFTER UPDATE OF status, WHEN NEW.status='confirmed')
--    membaca NEW.final_amount, sehingga KPI REVENUE ikut mengkredit nilai
--    yang benar secara otomatis TANPA mengubah trigger itu sendiri.
--    order.discount_amount (order-level, mekanisme terpisah dari special-
--    price/policy, pre-existing) TIDAK disentuh -- dibaca apa adanya, pola
--    identik submit/decide.
--
-- Audit tambahan (dibuktikan, bukan diubah -- konfirmasi cakupan gate ini
-- sudah cukup, TIDAK ADA regresi):
--   - create_draft_sales_order_atomic/update_draft_sales_order_atomic
--     (jalur Telegram AI-extraction, 20260920000001) SENGAJA TIDAK disentuh
--     -- mekanisme TERPISAH (requires_discount_review/discount_exception,
--     product_id nullable, quantity NUMERIC bebas dari AI extraction),
--     eksplisit di luar kontrak gate ini ("Jangan melebar ke ... Telegram").
--   - submit_special_price_proposal_atomic/decide_special_price_proposal_
--     atomic (C2/C3) SUDAH memakai formula GREATEST(0, ROUND(...)) yang
--     identik untuk baris yang mereka sentuh -- TIDAK diubah gate ini.
--     Baris LAIN pada order yang sama yang TIDAK disentuh submit/decide
--     tetap ter-cover oleh recompute confirm (poin 2 di atas), sehingga
--     tidak ada celah campuran baris-benar/baris-fabricated yang lolos.
--   - Tidak perlu backfill data historis: order yang SUDAH confirmed
--     sebelum gate ini tidak tersentuh (confirm hanya berjalan untuk order
--     yang BELUM confirmed); order draft/pending lama otomatis terkoreksi
--     saat confirm_sales_order_atomic akhirnya dipanggil (recompute
--     mengabaikan kolom total_amount item yang tersimpan, menghitung ulang
--     dari quantity/unit_price/discount_amount mentah).
--   - order-level discount_amount (p_discount_amount pada create/update)
--     TIDAK dibatasi/divalidasi gate ini -- kapasitas ini SUDAH tersedia
--     tanpa batas lewat RPC resmi sejak awal (bukan bypass yang
--     diperkenalkan/ditutup gate ini), mengubahnya adalah keputusan
--     kebijakan diskon order-level yang lebih luas, eksplisit di luar
--     kontrak ("Jangan mengubah policy diskon C2/C3").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. create_sales_order_atomic -- total_amount item direkomputasi server-side.
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

  -- Gate 3E-D4-C5: total_amount TIDAK LAGI dipercaya dari client -- dihitung
  -- ulang server-side dari quantity*unit_price-discount_amount (formula
  -- identik submit_special_price_proposal_atomic/decide_special_price_
  -- proposal_atomic). x.total_amount dari payload client diabaikan total.
  SELECT COALESCE(SUM(GREATEST(0, ROUND(x.quantity * x.unit_price - x.discount_amount, 2))), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(quantity NUMERIC, unit_price NUMERIC, discount_amount NUMERIC);
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

REVOKE ALL ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_order_atomic(UUID, UUID, TEXT, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 2. update_sales_order_atomic -- total_amount item direkomputasi server-side
--    (Guard draft-only Gate 3E-D4-B2 TIDAK diubah).
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

  -- Gate 3E-D4-B2: draft-only, TANPA KECUALI -- TIDAK diubah gate ini.
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

  -- Gate 3E-D4-C5: lihat catatan create_sales_order_atomic -- total_amount
  -- direkomputasi server-side, x.total_amount client diabaikan total.
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

REVOKE ALL ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 3. confirm_sales_order_atomic -- recompute total/tax/final dari item truth
--    SETELAH seluruh guard existing (Gate 3E-D4-C4, TIDAK diubah) lolos.
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
  v_order            public.sales_orders%ROWTYPE;
  v_old_status       TEXT;
  v_latest_request   public.special_price_approval_requests%ROWTYPE;
  v_line_count       INTEGER;
  v_matched_count    INTEGER;
  v_recomputed_total NUMERIC;
  v_recomputed_tax   NUMERIC;
  v_recomputed_final NUMERIC;
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

  -- Guard 2 (Gate 3E-D4-C4, TIDAK diubah): tidak boleh ada request PENDING.
  IF EXISTS (
    SELECT 1 FROM public.special_price_approval_requests spar
    WHERE spar.sales_order_id = p_order_id AND spar.status = 'PENDING'
  ) THEN
    RETURN QUERY SELECT 'pending_approval_exists'::TEXT, FALSE;
    RETURN;
  END IF;

  -- Guard 3 (Gate 3E-D4-C4, TIDAK diubah): proposal TERAKHIR, jika ada
  -- riwayat -- APPROVED wajib snapshot identik; REJECTED wajib item sudah
  -- direstore ke master_unit_price.
  SELECT * INTO v_latest_request
  FROM public.special_price_approval_requests spar
  WHERE spar.sales_order_id = p_order_id
  ORDER BY spar.proposal_version DESC
  LIMIT 1;

  IF FOUND THEN
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

      IF v_line_count = 0 OR v_matched_count <> v_line_count THEN
        RETURN QUERY SELECT 'approval_snapshot_mismatch'::TEXT, FALSE;
        RETURN;
      END IF;
    ELSIF v_latest_request.status = 'REJECTED' THEN
      SELECT COUNT(*) INTO v_line_count
      FROM public.special_price_approval_lines spal
      WHERE spal.approval_request_id = v_latest_request.id;

      SELECT COUNT(*) INTO v_matched_count
      FROM public.special_price_approval_lines spal
      JOIN public.sales_order_items soi ON soi.id = spal.sales_order_item_id
      WHERE spal.approval_request_id = v_latest_request.id
        AND soi.order_id = p_order_id
        AND soi.unit_price = spal.master_unit_price;

      IF v_line_count > 0 AND v_matched_count <> v_line_count THEN
        RETURN QUERY SELECT 'unapproved_special_price'::TEXT, FALSE;
        RETURN;
      END IF;
    ELSE
      RETURN QUERY SELECT 'invalid_approval_state'::TEXT, FALSE;
      RETURN;
    END IF;
  END IF;

  -- Gate 3E-D4-C5: recompute total_amount/tax_amount/final_amount server-
  -- side dari sales_order_items SAAT INI -- lihat "Temuan #1/#2" di header
  -- migration ini. Formula item IDENTIK submit_special_price_proposal_atomic/
  -- decide_special_price_proposal_atomic (GREATEST(0, ROUND(quantity*harga-
  -- diskon,2))), diturunkan ULANG dari quantity/unit_price/discount_amount
  -- MENTAH per baris (BUKAN kolom total_amount tersimpan) supaya baris yang
  -- di-DML langsung di luar RPC atau baris lama sebelum gate ini ikut
  -- terkoreksi otomatis. order.discount_amount (order-level, mekanisme
  -- terpisah) dibaca apa adanya, TIDAK disentuh.
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
  'Gate 3E-D4-C4 (guard draft-only/pending-request/approval-snapshot, TIDAK diubah) + Gate 3E-D4-C5 (recompute total_amount/tax_amount/final_amount server-side dari sales_order_items SAAT konfirmasi -- diturunkan dari quantity/unit_price/discount_amount mentah, bukan kolom total_amount tersimpan -- sebelum menulis status=confirmed, sehingga trg_sales_orders_credit_order_kpi (AFTER UPDATE OF status) mengkredit REVENUE pada nilai yang benar-benar server-computed, kebal terhadap total_amount yang di-DML langsung atau dipalsukan lewat RPC create/update lama). Satu-satunya RPC yang boleh memindahkan sales_orders.status -> confirmed.';

REVOKE ALL ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  TO service_role;
