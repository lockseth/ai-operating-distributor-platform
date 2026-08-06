-- =============================================================================
-- Gate 3E-D4-C2 -- Special Price Proposal Submission & Policy Evaluation RPC.
--
-- Membangun public.submit_special_price_proposal_atomic(): satu-satunya jalur
-- Sales mengajukan special price pada line draft order miliknya sendiri.
-- Server mengevaluasi knowledge_discount_policies (bukan client), menyimpan
-- snapshot immutable (special_price_approval_requests/lines, skema Gate
-- 3E-D4-C1), dan memindahkan order ke pending_owner_approval HANYA bila
-- sedikitnya satu line melebihi batas diskon efektif. Approve/reject Owner,
-- confirmation gate, invalidasi approval pasca-perubahan order, WhatsApp
-- outbox, UI, dan role/permission baru TIDAK termasuk gate ini.
--
-- Audit preflight (dibuktikan sebelum implementasi):
--   1. knowledge_discount_policies (20260709000001): scope global/product/
--      customer, max_percentage/max_nominal NULLABLE independen, is_active.
--      TIDAK ADA kolom effective date/priority -- precedence lintas-scope
--      (product > customer > global) adalah application logic yang SUDAH
--      terbukti (apps/web/src/lib/sales-orders/discount.ts:findApplicablePolicy,
--      dikutip juga di header migration 20260923000001 baris 75-81). Skema
--      TIDAK mencegah lebih dari satu baris aktif untuk scope+key yang SAMA
--      (mis. dua baris scope='product' aktif untuk product_id yang sama) --
--      tidak ada precedent kode yang menentukan tie-break ini. Keputusan gate
--      ini: dalam SATU tier yang sama, baris dengan updated_at TERBARU
--      menang (deterministic, "penyuntingan terakhir mencerminkan niat
--      Owner saat ini" -- kdp_manage adalah owner-only, lihat
--      20260905000001). Ini TIDAK melonggarkan fail-closed: precedence
--      LINTAS-tier (product/customer/global) tetap dihormati penuh --
--      tie-break hanya berlaku SESUDAH tier ditentukan, satu ORDER BY
--      (tier ASC, updated_at DESC, id DESC) LIMIT 1 lewat LATERAL join.
--   2. discount.ts:evaluateItemDiscount -- "policy ada tapi tidak
--      mendefinisikan limit untuk tipe diskon ini -> tetap review" dan "tidak
--      ada policy sama sekali -> requiresReview". Gate ini mengeneralisasi
--      pola yang SAMA ke evaluasi berbasis harga (bukan discount_type/value):
--      requires_approval per line = TRUE bila (a) tidak ada policy yang
--      match pada tier manapun, (b) policy match tapi max_percentage DAN
--      max_nominal keduanya NULL, (c) implied discount melebihi
--      max_percentage yang match, ATAU (d) implied discount nominal
--      (per-line, quantity x (master-proposed)) melebihi max_nominal yang
--      match -- kedua dimensi dievaluasi independen, cocok pola "review bila
--      limit tipe ybs tidak terdefinisi/dilanggar" di atas, BUKAN OR-relaxed
--      (memenuhi salah satu limit tidak cukup jika limit lain didefinisikan
--      dan dilanggar).
--   3. sales_order_items (20260626000003 + 20260709000001): unit_price,
--      discount_amount (nominal per-item, existing), total_amount (post-
--      discount, comment eksplisit "total_amount tetap menyimpan nilai
--      setelah diskon" baris 249-250). products.price adalah harga master
--      canonical (20260626000003:38). Gate ini HANYA mengubah unit_price
--      line yang diajukan -- discount_amount existing per-item TIDAK
--      disentuh/direset (di luar scope; interaksi dua mekanisme diskon
--      sekaligus bukan pertanyaan yang diajukan kontrak gate ini).
--   4. update_sales_order_atomic (20260922000001, terbaru): formula
--      recalculation canonical -- v_total_amount = SUM(item.total_amount),
--      v_tax_amount = ROUND((v_total_amount - order.discount_amount) *
--      0.11, 2), v_final_amount = v_total_amount - order.discount_amount +
--      v_tax_amount. Gate ini REUSE formula identik (order-level
--      discount_amount TIDAK diubah RPC ini -- bukan parameter, dipertahankan
--      dari v_order.discount_amount existing).
--   5. Actor/role: pola "strictly role tertentu + aktif + tenant sama" sudah
--      established (audit_logs_select 20260819000001, decider owner check
--      20260923000001). Gate ini menerapkan pola SAMA untuk role 'sales' --
--      permission-based check (mis. 'orders.update') SENGAJA TIDAK dipakai
--      supaya Owner/Admin/manager/Operator/pemegang orders.manage yang
--      kebetulan juga py orders.update TIDAK bisa submit "seolah Sales"
--      (kontrak poin 19) -- hanya role='sales' aktif yang lolos.
--   6. Identitas caller: BERBEDA dari mayoritas RPC order lain (yang menerima
--      p_actor_id/p_company_id sebagai parameter trusted dari service-role
--      caller) -- kontrak gate ini eksplisit "Requester berasal dari actor,
--      bukan parameter" dan "GRANT hanya authenticated". Pola yang SUDAH ada
--      untuk RPC semacam ini adalah provision_first_owner (20260907000001):
--      auth.uid() SEBAGAI SATU-SATUNYA sumber identitas, TIDAK ADA parameter
--      user_id/company_id, GRANT EXECUTE HANYA authenticated (REVOKE
--      termasuk dari service_role -- bila service_role tetap memanggil
--      langsung, auth.uid() akan NULL dan caller ditolak sebagai
--      unauthenticated, otorisasi tidak pernah bergantung pada privilege
--      Postgres pemanggil). Gate ini mengikuti pola identik, memakai
--      public.get_user_company_id()/public.get_user_roles() (helper RLS
--      existing, 20260626000004 + 20260904000001, is_active=TRUE sudah
--      built-in) alih-alih menulis ulang join yang sama.
--   7. Idempotency: pola existing (order_cancellation_disputes,
--      20260725000001) HANYA membandingkan keberadaan idempotency_key
--      (UNIQUE(company_id, idempotency_key)), TIDAK memvalidasi payload sama
--      -- kontrak gate ini eksplisit mensyaratkan retry payload BEDA harus
--      ditolak (poin 15/18, tidak dipenuhi pola lama). Gate ini menambah
--      kolom request_payload_hash (md5 atas sales_order_id + reason
--      (trimmed) + baris {sales_order_item_id, proposed_unit_price} yang
--      diurutkan) disimpan berdampingan idempotency_key -- retry dengan key
--      sama dibandingkan hash-nya: sama -> kembalikan hasil existing
--      (already_exists, tanpa insert baru); beda -> idempotency_conflict
--      (fail-closed, tanpa mutasi). Kolom baru ditambahkan ke daftar kolom
--      immutable trigger trg_spar_enforce_invariants (defense-in-depth,
--      konsisten filosofi Gate 3E-D4-C1 -- snapshot request tidak pernah
--      diedit in-place).
--   8. Konkurensi: SELECT ... FOR UPDATE pada sales_orders (pola identik
--      update_sales_order_atomic/confirm_sales_order_atomic, TERBUKTI cukup
--      per catatan migration 20260922000001 baris 30-38 -- tidak ada
--      advisory lock baru yang perlu ditambahkan) menyerialkan submission
--      konkuren untuk order yang sama; unique partial index
--      uq_spar_one_pending_per_order (20260923000001) adalah backstop DB-level
--      kedua.
--
-- Yang SENGAJA TIDAK diubah/dibangun (lihat kontrak "Jangan membangun"):
--   approve/reject RPC, confirmation gate, invalidasi approval pasca-
--   perubahan order, WhatsApp outbox, UI Sales/Owner, parser Telegram baru,
--   role/permission/capability baru, perubahan KPI, perubahan
--   knowledge_discount_policies itu sendiri.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Kolom idempotency pada special_price_approval_requests (additive).
-- -----------------------------------------------------------------------------

ALTER TABLE public.special_price_approval_requests
  ADD COLUMN IF NOT EXISTS idempotency_key      TEXT,
  ADD COLUMN IF NOT EXISTS request_payload_hash TEXT;

ALTER TABLE public.special_price_approval_requests
  ADD CONSTRAINT uq_spar_company_idempotency_key UNIQUE (company_id, idempotency_key);

COMMENT ON COLUMN public.special_price_approval_requests.idempotency_key IS
  'Gate 3E-D4-C2: opsional, disediakan caller. Retry dengan key sama + payload sama (lihat request_payload_hash) mengembalikan request existing tanpa insert baru; payload beda ditolak fail-closed.';
COMMENT ON COLUMN public.special_price_approval_requests.request_payload_hash IS
  'Gate 3E-D4-C2: md5(sales_order_id + reason trimmed + baris {sales_order_item_id, proposed_unit_price} terurut). Dipakai submit_special_price_proposal_atomic untuk membedakan retry idempotent dari payload berbeda dengan key yang sama. Bukan order_snapshot_hash (tujuan berbeda -- kolom itu untuk deteksi perubahan order pasca-proposal oleh gate berikutnya).';

-- Kolom baru wajib immutable seperti kolom snapshot lain -- perluas daftar
-- kolom yang diperiksa trigger invariant (defense-in-depth, tidak ada jalur
-- yang seharusnya mengubahnya, tapi trigger existing tidak otomatis
-- melindungi kolom yang belum ada saat ditulis).
CREATE OR REPLACE FUNCTION public.enforce_special_price_approval_request_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order       public.sales_orders%ROWTYPE;
  v_max_version INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_order FROM public.sales_orders WHERE id = NEW.sales_order_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'AODP_SPAR_ORDER_NOT_FOUND: sales_order_id % tidak ditemukan', NEW.sales_order_id
        USING ERRCODE = '23514';
    END IF;

    IF v_order.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'AODP_SPAR_TENANT_MISMATCH: company_id request harus sama dengan company_id order'
        USING ERRCODE = '23514';
    END IF;

    IF v_order.sales_id IS DISTINCT FROM NEW.requested_by THEN
      RAISE EXCEPTION 'AODP_SPAR_REQUESTER_MISMATCH: requested_by harus sales pemilik order (sales_orders.sales_id)'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = NEW.requested_by AND u.company_id = NEW.company_id AND u.is_active = TRUE
    ) THEN
      RAISE EXCEPTION 'AODP_SPAR_REQUESTER_INVALID: requested_by harus user aktif pada tenant yang sama'
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(MAX(proposal_version), 0) INTO v_max_version
    FROM public.special_price_approval_requests
    WHERE sales_order_id = NEW.sales_order_id;

    IF NEW.proposal_version <= v_max_version THEN
      RAISE EXCEPTION 'AODP_SPAR_VERSION_NOT_INCREASING: proposal_version % harus lebih besar dari versi tertinggi % untuk order ini', NEW.proposal_version, v_max_version
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status <> 'PENDING' THEN
      RAISE EXCEPTION 'AODP_SPAR_INITIAL_STATUS: proposal baru wajib berstatus PENDING'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'AODP_SPAR_DECISION_IMMUTABLE: keputusan final (APPROVED/REJECTED) tidak dapat diubah'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.company_id            IS DISTINCT FROM OLD.company_id
       OR NEW.sales_order_id     IS DISTINCT FROM OLD.sales_order_id
       OR NEW.proposal_version   IS DISTINCT FROM OLD.proposal_version
       OR NEW.requested_by       IS DISTINCT FROM OLD.requested_by
       OR NEW.requested_at       IS DISTINCT FROM OLD.requested_at
       OR NEW.reason             IS DISTINCT FROM OLD.reason
       OR NEW.order_snapshot_hash IS DISTINCT FROM OLD.order_snapshot_hash
       OR NEW.idempotency_key      IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_payload_hash IS DISTINCT FROM OLD.request_payload_hash
       OR NEW.created_at         IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'AODP_SPAR_SNAPSHOT_IMMUTABLE: isi proposal tidak dapat diubah setelah dibuat'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status NOT IN ('APPROVED','REJECTED') THEN
      RAISE EXCEPTION 'AODP_SPAR_INVALID_TRANSITION: transisi status hanya PENDING->APPROVED atau PENDING->REJECTED'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.users u
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
      JOIN public.roles r ON r.id = ur.role_id
      WHERE u.id = NEW.decided_by
        AND u.company_id = NEW.company_id
        AND u.is_active = TRUE
        AND r.name = 'owner'
    ) THEN
      RAISE EXCEPTION 'AODP_SPAR_DECIDER_NOT_OWNER: decided_by harus user owner aktif pada tenant yang sama'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. submit_special_price_proposal_atomic -- RPC canonical submission.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_special_price_proposal_atomic(
  p_sales_order_id UUID,
  p_items JSONB,
  p_reason TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE(
  result_outcome TEXT,
  requires_approval BOOLEAN,
  approval_request_id UUID,
  proposal_version INTEGER,
  order_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id             UUID;
  v_company_id           UUID;
  v_order                public.sales_orders%ROWTYPE;
  v_reason               TEXT;
  v_idem_key             TEXT;
  v_payload_fingerprint  TEXT;
  v_existing             public.special_price_approval_requests%ROWTYPE;
  v_existing_order_status TEXT;
  v_item_count           INTEGER;
  v_distinct_item_count  INTEGER;
  v_missing_line_count   INTEGER;
  v_invalid_price_count  INTEGER;
  v_bad_payload_count    INTEGER;
  v_over_master_count    INTEGER;
  v_inactive_product_count INTEGER;
  v_requires_approval    BOOLEAN;
  v_next_version         INTEGER;
  v_new_request_id       UUID;
  v_total_amount         NUMERIC;
  v_tax_amount           NUMERIC;
  v_final_amount         NUMERIC;
  v_snapshot_hash        TEXT;
BEGIN
  -- Step 1 (kontrak): identitas HANYA dari sesi JWT terverifikasi.
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- get_user_company_id() (20260904000001) sudah mensyaratkan is_active=TRUE.
  v_company_id := public.get_user_company_id();
  IF v_company_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Kontrak poin 19: strictly role 'sales' -- BUKAN permission-based, supaya
  -- Owner/Admin/manager/Operator/orders.manage tidak bisa submit "seolah Sales".
  IF NOT ('sales' = ANY(COALESCE(public.get_user_roles(v_actor_id), ARRAY[]::TEXT[]))) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Step 2: lock parent order row.
  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_sales_order_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Step 3: ownership -- hanya Sales pemilik order.
  IF v_order.sales_id IS DISTINCT FROM v_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  v_reason   := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

  -- Idempotency short-circuit -- SEBELUM pemeriksaan status draft, supaya
  -- retry request asli yang sudah memindahkan order ke pending_owner_approval
  -- tetap idempotent (bukan gagal not_draft).
  IF v_idem_key IS NOT NULL THEN
    v_payload_fingerprint := md5(
      p_sales_order_id::TEXT || '|' || COALESCE(v_reason, '') || '|' ||
      COALESCE((
        SELECT string_agg(x.sales_order_item_id::TEXT || ':' || x.proposed_unit_price::TEXT, ',' ORDER BY x.sales_order_item_id)
        FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
      ), '')
    );

    SELECT * INTO v_existing
    FROM public.special_price_approval_requests
    WHERE company_id = v_company_id AND idempotency_key = v_idem_key;

    IF FOUND THEN
      IF v_existing.request_payload_hash = v_payload_fingerprint THEN
        SELECT status INTO v_existing_order_status
        FROM public.sales_orders WHERE id = v_existing.sales_order_id;

        RETURN QUERY SELECT 'already_exists'::TEXT, TRUE, v_existing.id, v_existing.proposal_version, v_existing_order_status;
        RETURN;
      ELSE
        RETURN QUERY SELECT 'idempotency_conflict'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
        RETURN;
      END IF;
    END IF;
  END IF;

  IF v_order.status <> 'draft' THEN
    RETURN QUERY SELECT 'not_draft'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Step 5: payload struktural.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN QUERY SELECT 'no_items'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_bad_payload_count
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
  WHERE x.sales_order_item_id IS NULL OR x.proposed_unit_price IS NULL;

  IF v_bad_payload_count > 0 THEN
    RETURN QUERY SELECT 'invalid_payload'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT x.sales_order_item_id)
  INTO v_item_count, v_distinct_item_count
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC);

  IF v_item_count <> v_distinct_item_count THEN
    RETURN QUERY SELECT 'duplicate_line'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_missing_line_count
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.sales_order_items soi
    WHERE soi.id = x.sales_order_item_id AND soi.order_id = p_sales_order_id
  );

  IF v_missing_line_count > 0 THEN
    RETURN QUERY SELECT 'line_not_found'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_invalid_price_count
  FROM jsonb_to_recordset(p_items) AS x(proposed_unit_price NUMERIC)
  WHERE x.proposed_unit_price <= 0;

  IF v_invalid_price_count > 0 THEN
    RETURN QUERY SELECT 'invalid_price'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_inactive_product_count
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID)
  JOIN public.sales_order_items soi ON soi.id = x.sales_order_item_id
  WHERE soi.product_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.products pr
       WHERE pr.id = soi.product_id AND pr.company_id = v_company_id AND pr.is_active = TRUE
     );

  IF v_inactive_product_count > 0 THEN
    RETURN QUERY SELECT 'inactive_product'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Kontrak poin 3: harga master produk tidak pernah berubah -- proposed
  -- price yang melebihi harga master (bukan diskon) ditolak sebagai harga
  -- tidak valid (konsisten CHECK chk_spal_price_is_discount pada tabel
  -- snapshot, ditegakkan di sini juga sebelum jalur "tidak perlu approval").
  SELECT COUNT(*) INTO v_over_master_count
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
  JOIN public.sales_order_items soi ON soi.id = x.sales_order_item_id
  JOIN public.products pr ON pr.id = soi.product_id
  WHERE x.proposed_unit_price > pr.price;

  IF v_over_master_count > 0 THEN
    RETURN QUERY SELECT 'invalid_price'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Step 6-8: evaluasi policy per line, deterministic (product > customer >
  -- global tier, tie-break updated_at DESC dalam tier yang sama -- lihat
  -- catatan preflight #1 di atas).
  SELECT bool_or(eval.requires_line_approval) INTO v_requires_approval
  FROM (
    SELECT
      (
        pol.policy_id IS NULL
        OR (pol.max_percentage IS NULL AND pol.max_nominal IS NULL)
        OR (pol.max_percentage IS NOT NULL AND ((pr.price - x.proposed_unit_price) / pr.price * 100) > pol.max_percentage)
        OR (pol.max_nominal IS NOT NULL AND ((pr.price - x.proposed_unit_price) * soi.quantity) > pol.max_nominal)
      ) AS requires_line_approval
    FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
    JOIN public.sales_order_items soi ON soi.id = x.sales_order_item_id
    JOIN public.products pr ON pr.id = soi.product_id
    LEFT JOIN LATERAL (
      SELECT kdp.id AS policy_id, kdp.max_percentage, kdp.max_nominal
      FROM public.knowledge_discount_policies kdp
      WHERE kdp.company_id = v_company_id AND kdp.is_active = TRUE
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
  ) eval;

  IF NOT v_requires_approval THEN
    -- Kontrak poin 9: TIDAK ada approval request, TIDAK ada perubahan status,
    -- TIDAK ada mutasi order/item sama sekali lewat jalur ini.
    RETURN QUERY SELECT 'approval_not_required'::TEXT, FALSE, NULL::UUID, NULL::INTEGER, v_order.status::TEXT;
    RETURN;
  END IF;

  -- Kontrak poin 10: reason wajib bermakna setelah trim HANYA bila approval
  -- diperlukan.
  IF v_reason IS NULL THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  -- Mutasi harga line yang diajukan (server-computed total_amount, bukan
  -- client) -- item lain pada order tidak disentuh.
  UPDATE public.sales_order_items soi
  SET unit_price   = x.proposed_unit_price,
      total_amount = GREATEST(0, ROUND(soi.quantity * x.proposed_unit_price - soi.discount_amount, 2))
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
  WHERE soi.id = x.sales_order_item_id;

  -- Recalculate subtotal/tax/final -- formula identik update_sales_order_atomic
  -- (20260922000001). order-level discount_amount TIDAK diubah RPC ini.
  SELECT COALESCE(SUM(total_amount), 0) INTO v_total_amount
  FROM public.sales_order_items WHERE order_id = p_sales_order_id;

  v_tax_amount   := ROUND((v_total_amount - v_order.discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - v_order.discount_amount + v_tax_amount;

  UPDATE public.sales_orders
  SET status       = 'pending_owner_approval',
      total_amount = v_total_amount,
      tax_amount   = v_tax_amount,
      final_amount = v_final_amount
  WHERE id = p_sales_order_id;

  v_snapshot_hash := md5(
    COALESCE((
      SELECT string_agg(soi.id::TEXT || ':' || soi.product_id::TEXT || ':' || soi.quantity::TEXT || ':' || soi.unit_price::TEXT, ',' ORDER BY soi.id)
      FROM public.sales_order_items soi WHERE soi.order_id = p_sales_order_id
    ), '')
    || '|' || COALESCE(v_order.customer_id::TEXT, '') || '|' || COALESCE(v_order.sales_id::TEXT, '') || '|' || v_final_amount::TEXT
  );

  -- Alias tabel wajib -- "proposal_version" bertabrakan dengan nama kolom
  -- output RETURNS TABLE (variabel implisit plpgsql), referensi tanpa alias
  -- gagal "column reference is ambiguous".
  v_next_version := COALESCE(
    (SELECT MAX(spar.proposal_version) FROM public.special_price_approval_requests spar WHERE spar.sales_order_id = p_sales_order_id),
    0
  ) + 1;

  INSERT INTO public.special_price_approval_requests (
    company_id, sales_order_id, proposal_version, requested_by, reason,
    order_snapshot_hash, idempotency_key, request_payload_hash
  ) VALUES (
    v_company_id, p_sales_order_id, v_next_version, v_actor_id, v_reason,
    v_snapshot_hash, v_idem_key, v_payload_fingerprint
  )
  RETURNING id INTO v_new_request_id;

  INSERT INTO public.special_price_approval_lines (
    approval_request_id, line_number, product_id, product_name_snapshot, quantity,
    master_unit_price, proposed_unit_price, policy_id, policy_scope_snapshot,
    policy_max_percentage_snapshot, policy_max_nominal_snapshot, effective_floor_unit_price
  )
  SELECT
    v_new_request_id,
    ROW_NUMBER() OVER (ORDER BY x.sales_order_item_id),
    soi.product_id,
    pr.name,
    soi.quantity,
    pr.price,
    x.proposed_unit_price,
    pol.policy_id,
    pol.scope,
    pol.max_percentage,
    pol.max_nominal,
    GREATEST(
      0,
      CASE
        WHEN pol.policy_id IS NULL OR (pol.max_percentage IS NULL AND pol.max_nominal IS NULL) THEN pr.price
        ELSE GREATEST(
          COALESCE(pr.price * (1 - pol.max_percentage / 100.0), 0),
          COALESCE(pr.price - (pol.max_nominal / soi.quantity), 0)
        )
      END
    )
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
  JOIN public.sales_order_items soi ON soi.id = x.sales_order_item_id
  JOIN public.products pr ON pr.id = soi.product_id
  LEFT JOIN LATERAL (
    SELECT kdp.id AS policy_id, kdp.scope, kdp.max_percentage, kdp.max_nominal
    FROM public.knowledge_discount_policies kdp
    WHERE kdp.company_id = v_company_id AND kdp.is_active = TRUE
      AND (
        (kdp.scope = 'product' AND kdp.product_id = soi.product_id)
        OR (kdp.scope = 'customer' AND v_order.customer_id IS NOT NULL AND kdp.customer_id = v_order.customer_id)
        OR (kdp.scope = 'global')
      )
    ORDER BY
      CASE kdp.scope WHEN 'product' THEN 1 WHEN 'customer' THEN 2 WHEN 'global' THEN 3 END ASC,
      kdp.updated_at DESC, kdp.id DESC
    LIMIT 1
  ) pol ON TRUE;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    v_company_id, v_actor_id, 'order.special_price_proposal_submitted', 'sales_orders', p_sales_order_id,
    jsonb_build_object('status', v_order.status, 'final_amount', v_order.final_amount),
    jsonb_build_object(
      'status', 'pending_owner_approval', 'approval_request_id', v_new_request_id,
      'proposal_version', v_next_version, 'final_amount', v_final_amount
    ),
    'sales', 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'submitted'::TEXT, TRUE, v_new_request_id, v_next_version, 'pending_owner_approval'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.submit_special_price_proposal_atomic(UUID, JSONB, TEXT, TEXT) IS
  'Gate 3E-D4-C2: Sales mengajukan special price pada draft order miliknya. Evaluasi knowledge_discount_policies server-side (product>customer>global, tie-break updated_at DESC dalam tier sama); requires_approval per line bila implied discount melebihi max_percentage/max_nominal yang match ATAU tidak ada policy/limit yang match (fail-closed, 0% default). Bila TIDAK ada line yang memerlukan approval: tidak ada mutasi/side-effect sama sekali. Bila ADA: harga line diajukan di-update, subtotal/tax/final direcalculate (formula identik update_sales_order_atomic), order berpindah draft->pending_owner_approval, snapshot immutable dibuat, audit log ditulis -- satu transaksi atomic. Identitas caller selalu auth.uid(); GRANT hanya authenticated.';

REVOKE ALL ON FUNCTION public.submit_special_price_proposal_atomic(UUID, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_special_price_proposal_atomic(UUID, JSONB, TEXT, TEXT)
  TO authenticated;
