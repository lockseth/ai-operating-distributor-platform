-- =============================================================================
-- Gate 3E-D4-C4 -- Confirmation Enforcement & KPI Boundary.
--
-- Memperkuat confirm_sales_order_atomic (satu-satunya RPC yang boleh
-- memindahkan sales_orders.status -> 'confirmed') supaya order yang masih
-- pending Owner approval, atau yang memakai harga khusus tanpa APPROVED
-- request yang valid dan masih identik, TIDAK BISA dikonfirmasi -- dan
-- menutup jalur KEDUA yang bisa mencapai status 'confirmed' tanpa lewat RPC
-- ini sama sekali.
--
-- Root cause dibuktikan lewat reproduksi LANGSUNG terhadap DB lokal (bukan
-- asumsi) sebelum fix ditulis:
--   Bypass 1: confirm_sales_order_atomic (20260822000001:930) HANYA mengecek
--     v_old_status = 'confirmed' untuk idempotent short-circuit -- SELAIN itu
--     langsung SET status='confirmed' dari status APA PUN, termasuk
--     'pending_owner_approval' (order yang belum diputuskan Owner sama
--     sekali). Direproduksi: order dengan item unit_price=40000 (master
--     100000, TIDAK ADA APPROVED request) berstatus pending_owner_approval
--     berhasil confirm_sales_order_atomic -> result_outcome='confirmed',
--     DAN trg_sales_orders_credit_order_kpi (20260917000001) langsung
--     mengkredit ORDER_COUNT + REVENUE (2 event CREDITED) atas harga yang
--     belum pernah disetujui siapa pun. Ini persis temuan yang dicatat
--     sebagai "bukan bypass aktif" di header migration 20260923000001 baris
--     25-32 ("order tidak bisa mencapai pending_owner_approval di gate itu")
--     -- sejak C2 (20260924000001) order BISA mencapai status ini, sehingga
--     bypass yang dicatat sebagai "belum aktif" itu SEKARANG aktif dan harus
--     ditutup gate ini (kontrak eksplisit: "confirm RPC memvalidasinya pada
--     gate berikutnya").
--   Bypass 2 (ditemukan lewat audit caller, BUKAN di kontrak eksplisit tapi
--     wajib ditutup supaya gate ini tidak sia-sia -- lihat "Keputusan scope
--     Bypass 2" di bawah): public.update_sales_order_status_atomic
--     (20260923000001) TIDAK PERNAH memiliki guard untuk p_new_status=
--     'confirmed' (hanya paid/invoiced/pending_owner_approval yang dibekukan
--     oleh guard existing) -- DAN RPC ini adalah RPC yang SESUNGGUHNYA
--     dipanggil tombol "Konfirmasi" di web dashboard
--     (apps/web/src/components/orders/status-updater.tsx TRANSITIONS.draft
--     -> updateOrderStatusAction -> update_sales_order_status_atomic,
--     apps/web/src/lib/orders/actions.ts:198-260) -- BUKAN
--     confirm_sales_order_atomic (yang hanya dipanggil oleh alur Telegram
--     lewat sales-orders/repository.ts confirmOrder(), workflow.ts:292).
--     Direproduksi: order draft normal berhasil confirm lewat
--     update_sales_order_status_atomic(p_new_status='confirmed') ->
--     result_outcome='updated', SAMA SEKALI tidak lewat validasi apa pun
--     yang ditambahkan gate ini pada confirm_sales_order_atomic. Memperkuat
--     confirm_sales_order_atomic SAJA tanpa menutup jalur ini membuat seluruh
--     enforcement gate ini bisa dilewati oleh tombol UI utama yang sudah ada
--     hari ini -- bukan STOP CONDITION "lebih dari satu jalur yang tidak
--     dapat diamankan secara sempit" karena fix-nya sempit dan berpola
--     identik guard existing (lihat bagian 2 di bawah).
--
-- Keputusan scope Bypass 2: ditutup dengan pola IDENTIK guard existing di
-- RPC yang sama (paid_workflow_required/invoice_issuance_required/
-- special_price_approval_workflow_required, 20260923000001/20260824000001/
-- 20260825000001) -- p_new_status='confirmed' sekarang ditolak
-- (confirmation_workflow_required) TANPA KECUALI, memaksa SEMUA konfirmasi
-- lewat confirm_sales_order_atomic. apps/web/src/lib/orders/actions.ts
-- (updateOrderStatusAction, SATU-SATUNYA caller aplikasi selain test) di-
-- update pada commit yang sama untuk me-reroute target "confirmed" ke
-- confirm_sales_order_atomic (pola identik precedent Gate 3E-D4-B2 yang
-- menyelaraskan UI/caller pada commit yang sama dengan guard RPC-nya) --
-- TIDAK ada perubahan visual/komponen UI (StatusUpdater/TRANSITIONS tetap
-- sama), murni reroute RPC backend supaya kontrak "order normal tetap bisa
-- dikonfirmasi lewat tombol yang sama" terpenuhi.
--
-- Audit preflight (dibuktikan sebelum implementasi):
--   1. State machine actual sales_orders.status (9 nilai, 20260923000001):
--      draft, confirmed, processing, delivering, delivered, invoiced, paid,
--      cancelled, pending_owner_approval. Hanya SATU RPC yang pernah menulis
--      'confirmed' pada baris existing: confirm_sales_order_atomic (dulu)
--      DAN update_sales_order_status_atomic (dulu, Bypass 2 di atas, gate
--      ini menutupnya). create_sales_order_atomic/create_draft_sales_order_
--      atomic (20260919000001/20260920000001) SELALU hardcode status=
--      'draft' pada INSERT -- tidak ada jalur INSERT langsung ke 'confirmed'
--      yang aktif.
--   2. Approval lifecycle actual (C1-C3): submit_special_price_proposal_
--      atomic (20260924000001, diperluas 20260925000001) HANYA membuat baris
--      special_price_approval_requests/lines DAN memindahkan order ke
--      pending_owner_approval BILA sedikitnya satu line requires_approval
--      (melebihi/tidak tercakup knowledge_discount_policies); bila TIDAK,
--      'approval_not_required' TANPA mutasi apa pun. decide_special_price_
--      proposal_atomic (20260925000001) APPROVE mempertahankan proposed
--      price (order->draft, item TIDAK disentuh); REJECT memulihkan setiap
--      line ke master_unit_price snapshot (item DIPULIHKAN, order->draft).
--      special_price_approval_lines.sales_order_item_id (ditambahkan C3,
--      NOT NULL, UNIQUE(approval_request_id, sales_order_item_id)) adalah
--      penunjuk eksplisit deterministik ke baris item yang di-snapshot --
--      representasi ini TERBUKTI cukup untuk memvalidasi approval saat
--      confirm (bukan STOP CONDITION "snapshot tidak cukup"): query yang
--      SAMA persis dengan snapshot_mismatch check C3 (product_id/quantity/
--      unit_price=proposed_unit_price identik current item) bisa dijalankan
--      ulang di confirm sebagai defense-in-depth pada titik confirm, tanpa
--      perubahan skema tambahan.
--   3. Keputusan scope pemicu enforcement -- confirm_sales_order_atomic
--      HANYA memvalidasi lewat RIWAYAT special_price_approval_requests
--      order ybs (proposal_version TERTINGGI menentukan), BUKAN evaluasi
--      ulang knowledge_discount_policies terhadap seluruh item order secara
--      independen dari riwayat approval. Alasan (dibuktikan, bukan asumsi):
--        a. Order TANPA riwayat approval sama sekali (tidak pernah memanggil
--           submit_special_price_proposal_atomic) mencakup SEMUA order
--           legacy/existing -- termasuk alur Telegram AI-extraction
--           (requires_discount_review, 20260709000001:266) yang MENERIMA
--           unit_price bebas per item TANPA relasi ke products.price DAN
--           TIDAK PERNAH lewat mekanisme special_price_approval_requests
--           (mekanisme itu, TERPISAH, informational -- tidak pernah
--           memblokir confirm, existing sebelum C1-C3 dan di luar kontrak
--           gate ini). update_sales_order_atomic (20260922000001, draft-
--           only) JUGA menerima unit_price bebas per item tanpa validasi
--           policy apa pun -- pola LAMA, pre-existing, TIDAK diperkenalkan
--           C1-C3. Mengevaluasi ulang knowledge_discount_policies terhadap
--           SEMUA item current (independen riwayat approval) akan
--           memblokir confirm untuk order legacy yang sah ini bila product
--           terkait TIDAK punya knowledge_discount_policies aktif SAMA
--           SEKALI (formula requires_approval C2 baris 425-429: "tidak ada
--           policy yang match sama sekali -> requires_approval=TRUE", by
--           design fail-closed UNTUK ALUR PROPOSAL -- bukan untuk semua
--           order) -- regresi besar terhadap "Order normal yang tidak
--           memerlukan approval harus tetap dapat dikonfirmasi sesuai
--           kontrak existing" (kontrak gate ini eksplisit) DAN melanggar
--           "Jangan mengubah policy diskon C2/C3" (mengubah KAPAN evaluasi
--           itu berlaku adalah bagian dari policy diskon, bukan hanya
--           formula-nya).
--        b. Enforcement berbasis riwayat approval (bukan re-evaluasi
--           independen) memenuhi SETIAP baris ENFORCEMENT WAJIB kontrak
--           tanpa menyentuh order yang tidak pernah masuk mekanisme C1-C3:
--           pending_owner_approval (status check), request PENDING
--           (EXISTS check eksplisit, defense-in-depth), proposal TERAKHIR
--           REJECTED dengan harga khusus MASIH dipakai (verifikasi restore
--           ke master_unit_price snapshot), APPROVED tapi snapshot tidak
--           lagi identik/stale (verifikasi ulang match persis snapshot_
--           mismatch check C3, terhadap proposal_version TERTINGGI --
--           proposal versi lama otomatis stale begitu versi baru ada).
--        c. Temuan terkait TAPI di luar scope gate ini (dicatat, TIDAK
--           diperbaiki, lihat "Yang SENGAJA TIDAK diubah" di bawah):
--           update_sales_order_atomic masih menerima unit_price di bawah
--           master TANPA lewat submit_special_price_proposal_atomic sama
--           sekali (tidak pernah membuat riwayat approval) -- order semacam
--           ini TETAP bisa confirm lewat gate ini (tidak ada riwayat
--           approval untuk divalidasi). Menutup celah ini memerlukan
--           evaluasi policy independen terhadap SEMUA order (lihat (a) di
--           atas mengapa itu regresi besar) -- keputusan produk yang lebih
--           luas dari "confirmation enforcement", di luar kontrak eksplisit
--           gate ini ("Jangan mengubah policy diskon C2/C3", "Jangan
--           refactor luas").
--   4. Idempotency confirm_sales_order_atomic: RPC ini TIDAK memiliki
--      parameter idempotency_key sejak awal (berbeda dari C2/C3 yang
--      menambahkannya eksplisit) -- "key" alaminya adalah p_order_id itu
--      sendiri (satu order hanya bisa confirmed sekali, itulah esensi
--      status machine-nya). Short-circuit v_old_status='confirmed' ->
--      already_confirmed=TRUE (TANPA menjalankan UPDATE, sehingga
--      trg_sales_orders_credit_order_kpi TIDAK PERNAH refire karena trigger
--      hanya listen AFTER UPDATE OF status) SUDAH cukup untuk "retry
--      identik -> tiada KPI/audit ganda" -- dibuktikan lewat test idempotent
--      retry (termasuk retry dengan p_payment_terms_days BERBEDA: short-
--      circuit terjadi SEBELUM baris payment_terms_days disentuh, sehingga
--      retry payload berbeda TIDAK diam-diam menimpa apa pun -- fail-closed
--      by construction tanpa perlu kolom idempotency_key/payload_hash baru).
--      TIDAK menambah parameter baru pada RPC ini (scope sempit, tidak ada
--      caller yang perlu diubah untuk mengirim idempotency_key baru).
--   5. Locking & concurrency: SELECT ... FOR UPDATE pada sales_orders SUDAH
--      ada sejak 20260822000001 (baris 952-955, TIDAK diubah) -- confirm
--      konkuren untuk order yang sama SUDAH serial lewat lock ini (transaksi
--      kedua membaca status ter-update transaksi pertama setelah commit,
--      short-circuit already_confirmed). TIDAK ADA locking baru yang perlu
--      ditambahkan (pola sama persis catatan 20260922000001 baris 30-38).
--   6. Authorization: TIDAK diubah -- actor cukup user aktif pada tenant
--      yang sama (pola trusted-caller existing, SECURITY DEFINER, GRANT
--      hanya service_role) -- kontrak gate ini eksplisit "jangan
--      longgarkan privilege/RLS", enforcement gate ini murni tentang STATE
--      order/approval, bukan siapa yang boleh memanggil.
--
-- Yang SENGAJA TIDAK diubah/dibangun (di luar scope, lihat kontrak):
--   WhatsApp Owner, UI baru (selain reroute minimal caller Bypass 2 di
--   atas), penyatuan dua sistem KPI/dashboard/sales_reports, policy diskon
--   C2/C3 itu sendiri, refactor luas RPC lain, requires_discount_review
--   (mekanisme TERPISAH/pre-existing, tidak disentuh), evaluasi policy
--   independen dari riwayat approval (poin 3c di atas -- temuan out-of-
--   scope, dilaporkan bukan diperbaiki).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. confirm_sales_order_atomic -- enforcement approval boundary.
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
  v_old_status      TEXT;
  v_latest_request  public.special_price_approval_requests%ROWTYPE;
  v_line_count      INTEGER;
  v_matched_count   INTEGER;
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

  -- Guard 1 (Gate 3E-D4-C4): hanya draft yang bisa dikonfirmasi -- menutup
  -- Bypass 1 (lihat header). Sebelumnya RPC ini menerima status APA PUN
  -- selain 'confirmed' (termasuk 'pending_owner_approval', 'processing',
  -- dll) dan langsung mengonfirmasinya tanpa validasi.
  IF v_old_status <> 'draft' THEN
    RETURN QUERY SELECT 'invalid_order_state'::TEXT, FALSE;
    RETURN;
  END IF;

  -- Guard 2 (defense-in-depth, kontrak eksplisit): tidak boleh ada request
  -- PENDING untuk order ini. Seharusnya mustahil selama status=draft
  -- (uq_spar_one_pending_per_order + transisi atomic submit_special_price_
  -- proposal_atomic mengubah status DAN insert PENDING dalam satu transaksi
  -- yang sama) -- diperiksa eksplisit sesuai kontrak, bukan karena ada
  -- jalur aktif yang diketahui bisa menghasilkan anomali ini hari ini.
  IF EXISTS (
    SELECT 1 FROM public.special_price_approval_requests spar
    WHERE spar.sales_order_id = p_order_id AND spar.status = 'PENDING'
  ) THEN
    RETURN QUERY SELECT 'pending_approval_exists'::TEXT, FALSE;
    RETURN;
  END IF;

  -- Guard 3 (Gate 3E-D4-C4): proposal special-price TERAKHIR (proposal_
  -- version tertinggi) untuk order ini, jika ada riwayat sama sekali --
  -- lihat preflight #3 untuk alasan enforcement berbasis riwayat (bukan
  -- re-evaluasi policy independen).
  SELECT * INTO v_latest_request
  FROM public.special_price_approval_requests spar
  WHERE spar.sales_order_id = p_order_id
  ORDER BY spar.proposal_version DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_latest_request.status = 'APPROVED' THEN
      -- Snapshot APPROVED wajib IDENTIK dengan current sales_order_items --
      -- pola sama persis snapshot_mismatch check decide_special_price_
      -- proposal_atomic (20260925000001), dijalankan ulang di titik confirm
      -- sebagai defense-in-depth terhadap regresi/bug di jalur lain (mis.
      -- item dimutasi setelah APPROVE sebelum confirm dipanggil).
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
      -- Line yang pernah diajukan wajib SUDAH kembali ke master_unit_price
      -- snapshot (restore oleh decide_special_price_proposal_atomic saat
      -- REJECT). Bila masih memakai harga khusus (restore tidak terjadi/
      -- dilewati lewat jalur lain), confirmation ditolak fail-closed --
      -- kontrak eksplisit "REJECTED -> ditolak bila harga khusus masih
      -- dipakai".
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
      -- Status PENDING sudah tertutup Guard 2 di atas -- cabang ini
      -- seharusnya tidak pernah tercapai (CHECK constraint hanya
      -- mengizinkan PENDING/APPROVED/REJECTED), fail-closed bila tercapai.
      RETURN QUERY SELECT 'invalid_approval_state'::TEXT, FALSE;
      RETURN;
    END IF;
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

COMMENT ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER) IS
  'Gate 3E-D4-C4: satu-satunya RPC yang boleh memindahkan sales_orders.status -> confirmed. Guard 1: hanya draft (bukan pending_owner_approval/status lain apa pun) yang bisa dikonfirmasi. Guard 2: tidak boleh ada special_price_approval_requests berstatus PENDING (defense-in-depth). Guard 3: proposal terakhir (versi tertinggi), jika ada -- APPROVED wajib snapshot identik current items (fail-closed bila stale/dimutasi setelah approve); REJECTED wajib item sudah direstore ke master_unit_price (fail-closed bila harga khusus masih dipakai). Order tanpa riwayat approval sama sekali (termasuk legacy/requires_discount_review) tidak tersentuh guard ini. KPI ORDER_COUNT/REVENUE (trg_sales_orders_credit_order_kpi, 20260917000001) hanya fire pada UPDATE OF status yang benar-benar berhasil sampai baris UPDATE ini -- idempotent alami lewat short-circuit already_confirmed (tidak ada parameter idempotency_key baru, lihat catatan preflight #4).';

REVOKE ALL ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_sales_order_atomic(UUID, UUID, UUID, INTEGER)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 2. update_sales_order_status_atomic -- tutup Bypass 2 (lihat header):
--    p_new_status='confirmed' ditolak TANPA KECUALI, pola identik guard
--    paid/invoiced/pending_owner_approval existing di RPC yang sama.
-- -----------------------------------------------------------------------------

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

  IF v_old_status = 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'pending_owner_approval_locked'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoiced_locked'::TEXT;
    RETURN;
  END IF;

  IF v_old_status = 'paid' THEN
    RETURN QUERY SELECT 'paid_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard G (Gate 3E-D4-C4): tidak ada aktor -- termasuk owner -- yang bisa
  -- membuat order confirmed lewat generic status mutation ini (Bypass 2,
  -- lihat header migration). Confirmation SELALU lewat
  -- confirm_sales_order_atomic, satu-satunya RPC yang memvalidasi special-
  -- price approval boundary (Gate 3E-D4-C4).
  IF p_new_status = 'confirmed' THEN
    RETURN QUERY SELECT 'confirmation_workflow_required'::TEXT;
    RETURN;
  END IF;

  IF p_new_status = 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'special_price_approval_workflow_required'::TEXT;
    RETURN;
  END IF;

  IF p_new_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoice_issuance_required'::TEXT;
    RETURN;
  END IF;

  IF p_new_status = 'paid' THEN
    RETURN QUERY SELECT 'payment_workflow_required'::TEXT;
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

COMMENT ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT) IS
  'Gate 3E-D4-C4 menambah Guard G: p_new_status=''confirmed'' selalu ditolak (confirmation_workflow_required) -- confirmation hanya lewat confirm_sales_order_atomic. Guard paid/invoiced/pending_owner_approval (20260824000001/20260825000001/20260923000001) tidak berubah.';

REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;
