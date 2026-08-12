-- =============================================================================
-- Gate 3E-D6-A -- Special Price Approval Enforcement (closure gate).
--
-- Root cause dibuktikan live (docs/product/readiness/AODP_PHASE_3_CLOSEOUT_
-- AUDIT.md §5-§7, direproduksi ulang di
-- apps/web/src/lib/orders/gate-3e-d6-a-special-price-confirmation-gap.
-- integration.test.ts SEBELUM migration ini ditulis): create_sales_order_
-- atomic/update_sales_order_atomic (20260927000001, satu-satunya jalur order
-- web aktif) TIDAK PERNAH memvalidasi sales_order_items.unit_price terhadap
-- products.price/knowledge_discount_policies -- sementara Guard 3
-- confirm_sales_order_atomic (20260926000001/20260927000001) HANYA
-- memvalidasi riwayat special_price_approval_requests "IF FOUND", dilewati
-- total bila order TIDAK PERNAH memanggil submit_special_price_proposal_
-- atomic sama sekali (kasus NORMAL untuk order yang dibuat lewat create/
-- update_sales_order_atomic, karena RPC itu tidak pernah membuat riwayat
-- approval). Order dengan harga jauh di bawah products.price berhasil
-- confirm_sales_order_atomic TANPA riwayat approval APA PUN, dan
-- trg_sales_orders_credit_order_kpi (20260917000001) mengkredit ORDER_COUNT/
-- REVENUE dari nilai yang tidak pernah disetujui Owner.
--
-- Keputusan scope (menjawab pertanyaan Founder/CTO yang sebelumnya BLOCKED
-- di AODP_PHASE_3_CLOSEOUT_AUDIT.md §16 poin 1 -- "reject vs auto-route"):
-- kontrak gate ini eksplisit TIDAK meminta auto-route status ke
-- pending_owner_approval pada create/update (itu tetap memerlukan UI Sales/
-- Owner yang secara eksplisit di luar scope kontrak: "UI baru atau redesign"
-- TIDAK diizinkan). Kontrak HANYA mensyaratkan: order dengan harga khusus
-- TIDAK BOLEH menjadi 'confirmed' tanpa keputusan Owner 'approved' yang sah.
-- Ini dipenuhi dengan memperkuat confirm_sales_order_atomic (satu-satunya
-- RPC yang boleh memindahkan status -> confirmed, kontrak existing sejak
-- C4) sebagai boundary tunggal paling authoritative dan reusable -- BUKAN
-- dengan membangun approval engine/status/jalur paralel baru. create_sales_
-- order_atomic/update_sales_order_atomic TIDAK diubah (order dengan harga
-- khusus tetap tersimpan sebagai draft seperti sebelumnya -- TIDAK BISA
-- confirm sampai Sales mengajukan lewat submit_special_price_proposal_atomic
-- (RPC existing, sudah teruji C2/C3) dan Owner approve lewat decide_special_
-- price_proposal_atomic (RPC existing, sudah teruji C3)).
--
-- Fix (scope SEMPIT, reuse TOTAL kontrak/formula existing):
--   1. confirm_sales_order_atomic (CREATE OR REPLACE, signature IDENTIK):
--      Guard 3 SEKARANG SELALU mengevaluasi ulang apakah sales_order_items
--      CURRENT order ini memakai harga khusus -- formula IDENTIK
--      submit_special_price_proposal_atomic/decide_special_price_proposal_
--      atomic (unit_price < products.price DAN (tidak ada knowledge_
--      discount_policies aktif yang match ATAU melebihi max_percentage/
--      max_nominal yang match, product > customer > global, tie-break
--      updated_at DESC) -- TIDAK ADA formula/policy/threshold baru, murni
--      re-run formula C2 terhadap SEMUA item current, bukan hanya baris yang
--      kebetulan tercakup submit_special_price_proposal_atomic. Precondition
--      "unit_price < products.price" (tidak ada pada formula C2 asli, yang
--      konteksnya selalu "line yang secara eksplisit diajukan") WAJIB
--      ditambahkan supaya order yang tidak pernah menyimpang dari harga
--      master TIDAK salah ditandai perlu approval hanya karena tenant belum
--      mengonfigurasi knowledge_discount_policies (dibuktikan lewat
--      gate-3e-d4-c4-confirmation-enforcement.integration.test.ts skenario 1,
--      yang memakai unit_price=products.price TANPA policy apa pun --
--      re-run test itu SETELAH migration ini membuktikan tidak ada regresi).
--      Bila TIDAK ADA item yang memenuhi kondisi ini: Guard 3 dilewati total,
--      order normal tetap confirm seperti sebelumnya (kontrak poin 1, TIDAK
--      ADA regresi terhadap order legacy/normal -- dibuktikan lewat re-run
--      SELURUH test file gate-3e-d4-c4 SETELAH migration ini).
--      Bila ADA: latest special_price_approval_requests (proposal_version
--      TERTINGGI) WAJIB ditemukan DAN berstatus APPROVED DAN approval lines
--      -nya cocok PERSIS satu-satu (product_id/quantity/unit_price) dengan
--      SELURUH item yang saat ini memerlukan approval (v_matched_count =
--      v_line_count = v_current_special_count) -- menutup DUA celah
--      sekaligus: (a) order TANPA riwayat approval sama sekali (NOT FOUND,
--      celah utama di atas) DAN (b) order dengan approval PARSIAL (sebagian
--      item disetujui, item lain yang JUGA harga khusus tidak pernah
--      diajukan sama sekali -- celah kedua yang terbukti lewat
--      gate-3e-d6-a-special-price-confirmation-gap.integration.test.ts
--      skenario 5, TIDAK tertutup oleh pemeriksaan match-existing-lines saja
--      karena hanya memeriksa baris yang SUDAH ada di snapshot, bukan
--      kelengkapan cakupan terhadap seluruh item order). REJECTED
--      disederhanakan: order dengan item harga khusus current DAN keputusan
--      terakhir REJECTED SELALU ditolak (unapproved_special_price) --
--      strictly lebih kuat dari pemeriksaan restore-per-baris lama (yang
--      hanya memeriksa baris tercakup snapshot REJECTED itu sendiri, celah
--      sama seperti (b) di atas bila ada baris lain di luar snapshot),
--      dibuktikan menghasilkan outcome IDENTIK pada seluruh skenario existing
--      gate-3e-d4-c4 (skenario 4a/4b/9 -- lihat test re-run).
--   2. RLS sales_orders_insert/sales_orders_update (20260923000001, WITH
--      CHECK "status <> 'pending_owner_approval'"): tambah "status <>
--      'confirmed'" -- pola ADDITIVE IDENTIK guard pending_owner_approval
--      yang sudah ada (bukan restriksi baru, hanya memperluas nilai yang
--      diblokir). Root cause (dibuktikan live lewat gate-3e-d6-a test
--      skenario 7/8 SEBELUM migration ini): sales_orders_update TIDAK
--      PERNAH memeriksa target status untuk pemegang 'orders.manage' selain
--      pending_owner_approval (celah PRE-EXISTING, didokumentasikan eksplisit
--      di header 20260923000001 preflight #3 dan 20260927000001 Temuan #2
--      sebagai residual risk di luar scope gate-gate sebelumnya) -- direct-
--      client authenticated (BUKAN service-role) yang memegang permission
--      'orders.manage' (mis. owner/admin/manager) bisa UPDATE sales_orders
--      SET status='confirmed' langsung lewat PostgREST, ATAU INSERT baris
--      baru langsung berstatus 'confirmed', TOTAL BYPASS confirm_sales_
--      order_atomic (dan seluruh Guard 1-3 di dalamnya, termasuk fix poin 1
--      di atas) -- trg_sales_orders_credit_order_kpi (AFTER INSERT OR UPDATE
--      OF status, WHEN NEW.status='confirmed') tetap fire pada kedua jalur
--      ini terlepas dari siapa/bagaimana pemanggilnya, sehingga bypass ini
--      JUGA mengkredit KPI tanpa validasi apa pun. Kontrak gate ini eksplisit
--      melarang bypass "direct table write" -- fix ini menutupnya dengan
--      pola yang SUDAH established di migration yang sama (bukan mekanisme
--      baru). confirm_sales_order_atomic SENDIRI TIDAK terpengaruh (SECURITY
--      DEFINER, berjalan sebagai pemilik fungsi -- bukan role 'authenticated'
--      yang tunduk RLS ini) -- satu-satunya jalur SAH menuju 'confirmed'
--      tetap berfungsi identik. Grep menyeluruh terhadap apps/web/src
--      membuktikan TIDAK ADA kode produksi yang melakukan direct-client
--      update/insert ke sales_orders (seluruh mutasi order lewat RPC
--      SECURITY DEFINER/service-role, pola konsisten di setiap migration
--      order sejak awal) -- fix ini TIDAK berdampak pada flow produk manapun
--      yang sudah ada, murni menutup permukaan serang API langsung yang
--      tidak pernah dipakai UI.
--
-- Di luar scope (TIDAK diubah, sesuai kontrak eksplisit gate ini):
--   create_sales_order_atomic/update_sales_order_atomic itu sendiri (order
--   harga khusus tetap tersimpan sebagai draft, TIDAK auto-route ke
--   pending_owner_approval -- keputusan produk UI Sales/Owner yang lebih
--   luas, di luar scope "UI baru atau redesign"); submit_special_price_
--   proposal_atomic/decide_special_price_proposal_atomic (RPC existing,
--   tidak diubah); approval bertingkat; notifikasi/WhatsApp/Telegram baru;
--   perubahan KPI; perubahan master pricing; requires_discount_review
--   (mekanisme terpisah, pre-existing, di luar scope); status/kolom lain
--   pada guard pending_owner_approval/paid/invoiced yang sudah ada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. confirm_sales_order_atomic -- Guard 3 sekarang selalu mengevaluasi
--    ulang harga khusus terhadap SELURUH item current (formula identik C2/
--    C3), bukan hanya IF FOUND riwayat approval.
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
  'Gate 3E-D4-C4 (guard draft-only/pending-request, TIDAK diubah) + Gate 3E-D4-C5 (recompute total/tax/final, TIDAK diubah) + Gate 3E-D6-A (Guard 3 SELALU mengevaluasi ulang harga khusus terhadap SELURUH sales_order_items current -- formula identik submit_special_price_proposal_atomic/decide_special_price_proposal_atomic -- bukan hanya IF FOUND riwayat approval seperti sebelumnya; menutup order yang tidak pernah submit proposal sama sekali DAN order dengan approval cakupan parsial). Satu-satunya RPC yang boleh memindahkan sales_orders.status -> confirmed.';

REVOKE ALL ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 2. RLS sales_orders_insert/sales_orders_update -- tutup jalur direct-client
--    menuju status='confirmed' (pola additive identik guard
--    pending_owner_approval existing, 20260923000001).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "sales_orders_insert" ON public.sales_orders;

CREATE POLICY "sales_orders_insert" ON public.sales_orders
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('orders.create')
    AND status <> 'pending_owner_approval'
    AND status <> 'confirmed'
  );

DROP POLICY IF EXISTS "sales_orders_update" ON public.sales_orders;

CREATE POLICY "sales_orders_update" ON public.sales_orders
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('orders.manage')
      OR (sales_id = auth.uid() AND status = 'draft')
    )
  )
  WITH CHECK (
    company_id = public.get_user_company_id()
    AND status <> 'pending_owner_approval'
    AND status <> 'confirmed'
    AND (
      public.user_has_permission('orders.manage')
      OR (sales_id = auth.uid() AND status = 'draft')
    )
  );

COMMENT ON POLICY "sales_orders_insert" ON public.sales_orders IS
  'Gate 3E-D4-C1 (blok pending_owner_approval) + Gate 3E-D6-A (blok confirmed -- direct-client tidak boleh INSERT order yang langsung confirmed, memaksa lewat create_sales_order_atomic -> confirm_sales_order_atomic).';

COMMENT ON POLICY "sales_orders_update" ON public.sales_orders IS
  'Gate 3E-D4-C1 (blok pending_owner_approval) + Gate 3E-D6-A (blok confirmed -- direct-client tidak boleh UPDATE status menjadi confirmed, memaksa lewat confirm_sales_order_atomic, satu-satunya RPC yang menegakkan Guard special-price approval).';
