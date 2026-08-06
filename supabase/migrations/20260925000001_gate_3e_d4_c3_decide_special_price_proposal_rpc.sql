-- =============================================================================
-- Gate 3E-D4-C3 -- Owner Special Price Approval Decision RPC.
--
-- Membangun public.decide_special_price_proposal_atomic(): satu-satunya jalur
-- Owner memutuskan proposal special price PENDING (APPROVE/REJECT). APPROVE
-- mempertahankan proposed price dan memindahkan order pending_owner_approval
-- -> draft. REJECT mengembalikan seluruh line ke master-price snapshot,
-- menghitung ulang subtotal/tax/final, dan memindahkan order ke draft yang
-- sama. Keputusan immutable, idempotent pada retry identik, fail-closed pada
-- retry payload berbeda maupun snapshot/current-line mismatch. Confirmation
-- snapshot-validation (C4), invalidasi approval pasca-perubahan draft,
-- WhatsApp outbox, UI, parser Telegram, role/permission baru, perubahan KPI,
-- cancel-pending workflow, dan perubahan knowledge_discount_policies TIDAK
-- termasuk gate ini.
--
-- Audit preflight (dibuktikan sebelum implementasi):
--   1. special_price_approval_lines (20260923000001) TIDAK menyimpan
--      sales_order_item_id -- hanya product_id + quantity + master/proposed
--      unit_price. sales_order_items (20260626000003) TIDAK punya
--      UNIQUE(order_id, product_id) -- SATU order BOLEH punya lebih dari
--      satu baris item dengan product_id yang sama (tidak ada constraint
--      DB atau RPC create/update draft yang mencegahnya). Tanpa kolom
--      penunjuk eksplisit, restorasi REJECT yang mencocokkan lewat
--      product_id semata AMBIGU pada order dengan produk duplikat --
--      persis skenario "snapshot C1/C2 tidak cukup untuk restorasi
--      deterministik" yang menjadi STOP CONDITION gate ini.
--      Keputusan: TIDAK stop -- gap ditutup dengan augmentasi aditif sempit
--      (bagian 1 di bawah) yang bukan bagian dari daftar "jangan
--      membangun" kontrak (confirmation-C4/invalidasi/WhatsApp/UI/
--      parser/role baru/KPI/cancel-workflow/knowledge_discount_policies).
--      Hosted (mcbwgvtkhykrrtvbpeys) dicek read-only sebelum implementasi:
--      special_price_approval_requests/lines = 0 baris (C2 belum pernah
--      dipakai lewat UI/smoke sungguhan) -- kolom baru NOT NULL aman tanpa
--      backfill. submit_special_price_proposal_atomic (C2) di-CREATE OR
--      REPLACE dengan signature IDENTIK hanya untuk mengisi kolom baru ini
--      (x.sales_order_item_id sudah tersedia di payload x yang sama,
--      TIDAK ADA logic evaluasi/precedence/formula yang diubah).
--   2. Trigger enforce_special_price_approval_request_invariants
--      (20260923000001, diperluas 20260924000001) -- daftar kolom immutable
--      pada UPDATE TIDAK mencakup decided_by/decision_reason/decided_at
--      (sudah didesain settable pada TEPAT SATU transisi PENDING->
--      APPROVED/REJECTED). Kolom baru gate ini (decision_idempotency_key,
--      decision_payload_hash) mengikuti pola SAMA -- diisi pada transisi
--      keputusan itu sendiri, BUKAN saat INSERT snapshot -- sehingga TIDAK
--      ditambahkan ke daftar immutable (menambahkannya akan membuat transisi
--      keputusan yang sah gagal AODP_SPAR_SNAPSHOT_IMMUTABLE). Setelah
--      transisi, OLD.status <> 'PENDING' pada trigger sudah menolak SEMUA
--      UPDATE lanjutan tanpa terkecuali -- imutabilitas kolom baru terjamin
--      transitif, tidak perlu pemeriksaan eksplisit tambahan. Trigger decider
--      check (EXISTS owner aktif tenant sama) SUDAH cukup untuk keputusan
--      gate ini -- tidak diubah.
--   3. Formula totals REJECT: identik update_sales_order_atomic
--      (20260922000001)/submit_special_price_proposal_atomic (20260924000001)
--      -- v_total_amount = SUM(item.total_amount), v_tax_amount =
--      ROUND((v_total_amount - order.discount_amount) * 0.11, 2),
--      v_final_amount = v_total_amount - order.discount_amount +
--      v_tax_amount. order.discount_amount TIDAK disentuh (bukan parameter
--      RPC ini, sama seperti C2). item.total_amount dipulihkan dengan
--      formula IDENTIK C2: GREATEST(0, ROUND(quantity * master_unit_price -
--      discount_amount, 2)) -- discount_amount per-item (existing, di luar
--      mekanisme special price) TIDAK direset, konsisten catatan preflight
--      C2 #3 (dua mekanisme diskon independen, di luar scope).
--   4. RLS item-mutation boundary (20260921000001 B1) + draft-only guard
--      update_sales_order_atomic (20260922000001 B2): SELAMA order
--      berstatus pending_owner_approval, TIDAK ADA jalur direct-client
--      ATAU RPC canonical (update_sales_order_atomic mensyaratkan status=
--      'draft' TANPA KECUALI) yang bisa memutasi sales_order_items --
--      snapshot approval SEHARUSNYA selalu identik current items saat
--      decide dipanggil. Gate ini TETAP memverifikasi kecocokan eksplisit
--      (bagian 3, langkah snapshot-mismatch) sebagai fail-closed defense-
--      in-depth terhadap regresi/bug di jalur lain, BUKAN karena ada jalur
--      mutasi yang diketahui aktif hari ini.
--   5. Lock order: C2 mengunci sales_orders (FOR UPDATE) SEBELUM menyentuh
--      special_price_approval_requests (INSERT baris baru, tidak ada lock
--      row existing yang relevan). Gate ini MENIRU urutan yang SAMA -- lock
--      sales_orders lebih dulu, BARU lock special_price_approval_requests
--      -- supaya submit (masa depan pada order lain) dan decide (order
--      manapun) tidak pernah mengunci order/request dengan urutan
--      berlawanan (deadlock-free by construction, dua RPC selalu mengunci
--      resource dalam urutan sama).
--   6. Actor/owner: pola raw EXISTS join users/user_roles/roles dengan
--      u.is_active = TRUE AND r.name = 'owner' -- IDENTIK decider check
--      pada trigger (20260923000001) dan audit_logs_select (20260819000001)
--      -- BUKAN get_user_roles()/user_has_role() (permission-based, bisa
--      lolos untuk Admin/manager/orders.manage yang bukan owner strict).
--      Identitas HANYA dari auth.uid() (pola provision_first_owner/C2) --
--      GRANT hanya authenticated, REVOKE termasuk service_role, supaya
--      strict-Owner enforcement tidak bisa "dibuktikan" lewat privilege
--      Postgres pemanggil.
--   7. Idempotency: pola IDENTIK C2 (idempotency_key + payload hash,
--      short-circuit SEBELUM lock -- lookup company-scoped) tapi kolom
--      TERPISAH (decision_idempotency_key/decision_payload_hash) dari
--      kolom submission (idempotency_key/request_payload_hash) -- satu
--      approval request punya DUA aksi independen (submit lalu decide),
--      menimpa kolom submit dengan kolom decide akan melanggar immutability
--      snapshot submission (poin 2 di atas) dan mencampur dua idempotency
--      domain yang berbeda. UNIQUE(company_id, decision_idempotency_key)
--      -- pola sama persis uq_spar_company_idempotency_key C2, termasuk
--      karakteristik race yang sama (dua request BERBEDA memakai key yang
--      SAMA secara konkuren -- constraint violation mentah, precedent
--      diterima C2, klien wajib memakai key unik per aksi logis).
--   8. Signature parameter: kontrak menuliskan contoh
--      "p_decision_reason text default null, p_idempotency_key text" --
--      URUTAN INI TIDAK VALID SQL (parameter tanpa default tidak boleh
--      mengikuti parameter berdefault). Gate ini menukar urutan
--      (p_idempotency_key sebelum p_decision_reason, idempotency_key TIDAK
--      berdefault -- wajib bermakna sesuai kontrak validasi input) supaya
--      signature dapat di-declare -- TIDAK mengubah semantik/nama parameter
--      apa pun, murni koreksi urutan untuk membuatnya valid.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Augmentasi aditif -- sales_order_item_id (restorasi deterministik) dan
--    kolom idempotency keputusan (terpisah dari idempotency submission C2).
-- -----------------------------------------------------------------------------

ALTER TABLE public.special_price_approval_lines
  ADD COLUMN sales_order_item_id UUID REFERENCES public.sales_order_items (id);

-- Hosted (mcbwgvtkhykrrtvbpeys) dibuktikan 0 baris existing pada preflight
-- (lihat catatan #1) -- NOT NULL aman tanpa backfill.
ALTER TABLE public.special_price_approval_lines
  ALTER COLUMN sales_order_item_id SET NOT NULL;

ALTER TABLE public.special_price_approval_lines
  ADD CONSTRAINT uq_spal_request_sales_order_item UNIQUE (approval_request_id, sales_order_item_id);

COMMENT ON COLUMN public.special_price_approval_lines.sales_order_item_id IS
  'Gate 3E-D4-C3: penunjuk eksplisit ke baris sales_order_items yang di-snapshot -- ditambahkan supaya decide_special_price_proposal_atomic dapat memulihkan (REJECT) baris yang TEPAT secara deterministik, karena product_id semata AMBIGU pada order dengan lebih dari satu baris item ber-product_id sama (tidak ada UNIQUE(order_id, product_id) pada sales_order_items). Diisi submit_special_price_proposal_atomic (C2, CREATE OR REPLACE signature identik) saat INSERT snapshot.';

ALTER TABLE public.special_price_approval_requests
  ADD COLUMN decision_idempotency_key TEXT,
  ADD COLUMN decision_payload_hash    TEXT;

ALTER TABLE public.special_price_approval_requests
  ADD CONSTRAINT uq_spar_company_decision_idempotency_key UNIQUE (company_id, decision_idempotency_key);

COMMENT ON COLUMN public.special_price_approval_requests.decision_idempotency_key IS
  'Gate 3E-D4-C3: idempotency key untuk AKSI KEPUTUSAN (APPROVE/REJECT) -- terpisah dari idempotency_key (aksi submission, C2). Wajib diisi caller decide_special_price_proposal_atomic. Retry key+payload sama -> hasil existing tanpa mutasi/audit tambahan; payload beda -> idempotency_conflict fail-closed.';
COMMENT ON COLUMN public.special_price_approval_requests.decision_payload_hash IS
  'Gate 3E-D4-C3: md5(approval_request_id + decision + decision_reason trimmed). Dipakai decide_special_price_proposal_atomic membedakan retry idempotent dari payload berbeda dengan key yang sama.';

-- -----------------------------------------------------------------------------
-- 2. submit_special_price_proposal_atomic -- CREATE OR REPLACE signature
--    IDENTIK (UUID, JSONB, TEXT, TEXT), HANYA menambah pengisian
--    sales_order_item_id pada INSERT snapshot line. Tidak ada perubahan
--    logic evaluasi policy/precedence/formula/idempotency submission.
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
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  v_company_id := public.get_user_company_id();
  IF v_company_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  IF NOT ('sales' = ANY(COALESCE(public.get_user_roles(v_actor_id), ARRAY[]::TEXT[]))) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_sales_order_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  IF v_order.sales_id IS DISTINCT FROM v_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  v_reason   := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

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

  SELECT COUNT(*) INTO v_over_master_count
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
  JOIN public.sales_order_items soi ON soi.id = x.sales_order_item_id
  JOIN public.products pr ON pr.id = soi.product_id
  WHERE x.proposed_unit_price > pr.price;

  IF v_over_master_count > 0 THEN
    RETURN QUERY SELECT 'invalid_price'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

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
    RETURN QUERY SELECT 'approval_not_required'::TEXT, FALSE, NULL::UUID, NULL::INTEGER, v_order.status::TEXT;
    RETURN;
  END IF;

  IF v_reason IS NULL THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::BOOLEAN, NULL::UUID, NULL::INTEGER, NULL::TEXT;
    RETURN;
  END IF;

  UPDATE public.sales_order_items soi
  SET unit_price   = x.proposed_unit_price,
      total_amount = GREATEST(0, ROUND(soi.quantity * x.proposed_unit_price - soi.discount_amount, 2))
  FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, proposed_unit_price NUMERIC)
  WHERE soi.id = x.sales_order_item_id;

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

  -- Gate 3E-D4-C3: tambah sales_order_item_id (x.sales_order_item_id) pada
  -- SELECT list/kolom INSERT -- satu-satunya perubahan dari C2, lihat
  -- catatan preflight #1.
  INSERT INTO public.special_price_approval_lines (
    approval_request_id, line_number, product_id, product_name_snapshot, quantity,
    master_unit_price, proposed_unit_price, policy_id, policy_scope_snapshot,
    policy_max_percentage_snapshot, policy_max_nominal_snapshot, effective_floor_unit_price,
    sales_order_item_id
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
    ),
    x.sales_order_item_id
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

-- -----------------------------------------------------------------------------
-- 3. enforce_special_price_approval_line_invariants -- CREATE OR REPLACE
--    untuk menambah pemeriksaan sales_order_item_id (INSERT): item wajib
--    milik order yang sama dengan approval request induk DAN product_id
--    baris item wajib sama dengan product_id snapshot (defense-in-depth,
--    mencegah snapshot yang menunjuk item order/produk yang salah lolos
--    lewat jalur tulis mana pun -- termasuk service-role/RPC masa depan,
--    pola identik trigger existing).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_special_price_approval_line_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company_id  UUID;
  v_order_id    UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AODP_SPAL_IMMUTABLE: baris snapshot proposal tidak dapat diubah setelah dibuat -- buat proposal versi baru'
      USING ERRCODE = '23514';
  END IF;

  SELECT company_id, sales_order_id INTO v_company_id, v_order_id
  FROM public.special_price_approval_requests
  WHERE id = NEW.approval_request_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.products pr WHERE pr.id = NEW.product_id AND pr.company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'AODP_SPAL_PRODUCT_TENANT_MISMATCH: product_id harus berada pada company yang sama dengan approval request'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.knowledge_discount_policies kdp WHERE kdp.id = NEW.policy_id AND kdp.company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'AODP_SPAL_POLICY_TENANT_MISMATCH: policy_id harus berada pada company yang sama dengan approval request'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sales_order_items soi
    WHERE soi.id = NEW.sales_order_item_id
      AND soi.order_id = v_order_id
      AND soi.product_id = NEW.product_id
  ) THEN
    RAISE EXCEPTION 'AODP_SPAL_ITEM_MISMATCH: sales_order_item_id harus merujuk baris item pada order yang sama dengan product_id yang cocok'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_special_price_approval_line_invariants() IS
  'Gate 3E-D4-C1, diperluas 3E-D4-C3: INSERT -- product_id/policy_id (jika ada) wajib tenant sama dengan approval request induk; sales_order_item_id wajib merujuk baris item pada order yang sama dengan product_id yang cocok (Gate 3E-D4-C3, dipakai decide_special_price_proposal_atomic untuk restorasi deterministik). UPDATE -- diblokir total, baris snapshot immutable.';

-- -----------------------------------------------------------------------------
-- 4. decide_special_price_proposal_atomic -- RPC canonical keputusan Owner.
--    Lock order lebih dulu (identik urutan C2), lalu lock request. Idempotency
--    short-circuit SEBELUM lock (pola sama C2). Snapshot/current-line
--    mismatch fail-closed sebelum mutasi apa pun.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.decide_special_price_proposal_atomic(
  p_approval_request_id UUID,
  p_decision TEXT,
  p_idempotency_key TEXT,
  p_decision_reason TEXT DEFAULT NULL
)
RETURNS TABLE(
  result_outcome TEXT,
  approval_request_id UUID,
  decision TEXT,
  proposal_version INTEGER,
  order_status TEXT,
  decided_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id            UUID;
  v_company_id          UUID;
  v_decision            TEXT;
  v_reason              TEXT;
  v_idem_key            TEXT;
  v_payload_fingerprint TEXT;
  v_existing            public.special_price_approval_requests%ROWTYPE;
  v_existing_order_status TEXT;
  v_request             public.special_price_approval_requests%ROWTYPE;
  v_order               public.sales_orders%ROWTYPE;
  v_mismatch_count      INTEGER;
  v_line_count          INTEGER;
  v_matched_line_count  INTEGER;
  v_total_amount        NUMERIC;
  v_tax_amount          NUMERIC;
  v_final_amount        NUMERIC;
  v_decided_at          TIMESTAMPTZ;
BEGIN
  -- Step 1 (kontrak): identitas HANYA dari sesi JWT terverifikasi.
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- get_user_company_id() (20260904000001) sudah mensyaratkan is_active=TRUE.
  v_company_id := public.get_user_company_id();
  IF v_company_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Kontrak poin 1-3: strictly role 'owner' aktif tenant sama -- raw EXISTS
  -- join, IDENTIK decider check trigger (20260923000001)/audit_logs_select
  -- (20260819000001), BUKAN permission-based (Admin/manager/orders.manage
  -- yang bukan owner strict harus ditolak).
  IF NOT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = v_actor_id
      AND u.company_id = v_company_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_decision IS NULL OR upper(btrim(p_decision)) NOT IN ('APPROVE', 'REJECT') THEN
    RETURN QUERY SELECT 'invalid_decision'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  v_decision := CASE upper(btrim(p_decision)) WHEN 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END;

  v_idem_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_idem_key IS NULL OR length(v_idem_key) > 200 THEN
    RETURN QUERY SELECT 'invalid_idempotency_key'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_decision_reason, '')), '');
  IF v_decision = 'REJECTED' AND v_reason IS NULL THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_payload_fingerprint := md5(p_approval_request_id::TEXT || '|' || v_decision || '|' || COALESCE(v_reason, ''));

  -- Idempotency short-circuit SEBELUM lock -- pola identik C2, lookup
  -- company-scoped memakai kolom decision_idempotency_key (terpisah dari
  -- idempotency_key submission, lihat preflight #7).
  SELECT * INTO v_existing
  FROM public.special_price_approval_requests
  WHERE company_id = v_company_id AND decision_idempotency_key = v_idem_key;

  IF FOUND THEN
    IF v_existing.decision_payload_hash = v_payload_fingerprint THEN
      SELECT status INTO v_existing_order_status FROM public.sales_orders WHERE id = v_existing.sales_order_id;
      RETURN QUERY SELECT
        'already_decided'::TEXT, v_existing.id, v_existing.status::TEXT, v_existing.proposal_version,
        v_existing_order_status, v_existing.decided_at;
      RETURN;
    ELSE
      RETURN QUERY SELECT 'idempotency_conflict'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
  END IF;

  -- Resolve request tenant-scoped (fail-closed, tidak membocorkan
  -- keberadaan request cross-tenant -- not_found untuk keduanya: request
  -- tidak ada ATAU request ada tapi tenant lain).
  SELECT * INTO v_request
  FROM public.special_price_approval_requests
  WHERE id = p_approval_request_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Step lock (kontrak "Lock order lebih dahulu", preflight #5): kunci
  -- sales_orders SEBELUM special_price_approval_requests -- urutan identik
  -- submit_special_price_proposal_atomic, deadlock-free by construction.
  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = v_request.sales_order_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO v_request
  FROM public.special_price_approval_requests
  WHERE id = p_approval_request_id AND company_id = v_company_id
  FOR UPDATE;

  -- Concurrent APPROVE vs REJECT (kontrak poin 15/21): loser mengunci
  -- request SETELAH winner commit (winner melepas lock order+request
  -- bersamaan saat commit) -- status sudah bukan PENDING lagi di sini.
  -- Fail-closed, TIDAK menimpa keputusan, TIDAK ada mutasi/audit baru.
  IF v_request.status <> 'PENDING' THEN
    RETURN QUERY SELECT
      'already_decided'::TEXT, v_request.id, v_request.status::TEXT, v_request.proposal_version,
      v_order.status::TEXT, v_request.decided_at;
    RETURN;
  END IF;

  IF v_order.status <> 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'invalid_order_state'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Kontrak "Verifikasi snapshot lines cocok dengan current order lines" /
  -- STOP CONDITION "snapshot mismatch fail-closed": setiap baris snapshot
  -- wajib menunjuk sales_order_item yang MASIH pada order yang sama, dengan
  -- product_id/quantity/unit_price current PERSIS sama dengan snapshot.
  -- unit_price current dibandingkan ke proposed_unit_price (bukan
  -- master_unit_price) karena C2 sudah menulis proposed price ke item --
  -- kondisi normal SEBELUM decide adalah item = proposed (lihat preflight
  -- #4: tidak ada jalur mutasi item selama pending_owner_approval).
  SELECT COUNT(*) INTO v_line_count
  FROM public.special_price_approval_lines spal
  WHERE spal.approval_request_id = v_request.id;

  SELECT COUNT(*) INTO v_matched_line_count
  FROM public.special_price_approval_lines spal
  JOIN public.sales_order_items soi ON soi.id = spal.sales_order_item_id
  WHERE spal.approval_request_id = v_request.id
    AND soi.order_id = v_order.id
    AND soi.product_id = spal.product_id
    AND soi.quantity = spal.quantity
    AND soi.unit_price = spal.proposed_unit_price;

  IF v_line_count = 0 OR v_matched_line_count <> v_line_count THEN
    RETURN QUERY SELECT 'snapshot_mismatch'::TEXT, NULL::UUID, NULL::TEXT, NULL::INTEGER, NULL::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_decided_at := NOW();

  IF v_decision = 'REJECTED' THEN
    -- Kontrak poin 8: pulihkan SETIAP line ke master-price snapshot
    -- (immutable, bukan current products.price -- lihat kolom
    -- master_unit_price snapshot C1). discount_amount per-item existing
    -- dipertahankan, formula identik C2.
    UPDATE public.sales_order_items soi
    SET unit_price   = spal.master_unit_price,
        total_amount = GREATEST(0, ROUND(soi.quantity * spal.master_unit_price - soi.discount_amount, 2))
    FROM public.special_price_approval_lines spal
    WHERE spal.approval_request_id = v_request.id
      AND soi.id = spal.sales_order_item_id;

    SELECT COALESCE(SUM(total_amount), 0) INTO v_total_amount
    FROM public.sales_order_items WHERE order_id = v_order.id;

    v_tax_amount   := ROUND((v_total_amount - v_order.discount_amount) * 0.11, 2);
    v_final_amount := v_total_amount - v_order.discount_amount + v_tax_amount;

    UPDATE public.sales_orders
    SET status       = 'draft',
        total_amount = v_total_amount,
        tax_amount   = v_tax_amount,
        final_amount = v_final_amount
    WHERE id = v_order.id;
  ELSE
    -- Kontrak poin 7: APPROVE mempertahankan proposed price -- item TIDAK
    -- disentuh sama sekali, totals order TIDAK direcalculate (sudah
    -- current sejak C2 menulis proposed price ke item + totals).
    UPDATE public.sales_orders SET status = 'draft' WHERE id = v_order.id;
  END IF;

  UPDATE public.special_price_approval_requests
  SET status                   = v_decision,
      decided_by               = v_actor_id,
      decided_at               = v_decided_at,
      decision_reason          = v_reason,
      decision_idempotency_key = v_idem_key,
      decision_payload_hash    = v_payload_fingerprint
  WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    v_company_id, v_actor_id,
    CASE WHEN v_decision = 'APPROVED' THEN 'order.special_price_proposal_approved' ELSE 'order.special_price_proposal_rejected' END,
    'special_price_approval_requests', v_request.id,
    jsonb_build_object('status', 'PENDING', 'order_status', 'pending_owner_approval'),
    jsonb_build_object('status', v_decision, 'order_status', 'draft', 'decision_reason', v_reason),
    'owner', 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT
    (CASE WHEN v_decision = 'APPROVED' THEN 'approved' ELSE 'rejected' END)::TEXT,
    v_request.id, v_decision, v_request.proposal_version, 'draft'::TEXT, v_decided_at;
END;
$$;

COMMENT ON FUNCTION public.decide_special_price_proposal_atomic(UUID, TEXT, TEXT, TEXT) IS
  'Gate 3E-D4-C3: Owner (strictly role owner aktif, tenant sama -- BUKAN permission-based) memutuskan proposal PENDING. APPROVE: proposed price dipertahankan, order pending_owner_approval->draft, TIDAK mengonfirmasi/KPI. REJECT: setiap line dipulihkan ke master_unit_price snapshot (immutable, bukan current products.price), totals direcalculate (formula identik update_sales_order_atomic/C2), order->draft. Snapshot/current-line mismatch fail-closed sebelum mutasi apa pun. Idempotent pada retry key+payload identik (decision_idempotency_key/decision_payload_hash, kolom terpisah dari idempotency submission C2); payload beda pada key sama -> idempotency_conflict. Concurrent APPROVE vs REJECT: lock sales_orders lebih dulu lalu special_price_approval_requests (urutan identik C2, deadlock-free) -- loser melihat status sudah bukan PENDING setelah lock, fail-closed tanpa menimpa keputusan. Identitas caller selalu auth.uid(); GRANT hanya authenticated.';

REVOKE ALL ON FUNCTION public.decide_special_price_proposal_atomic(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_special_price_proposal_atomic(UUID, TEXT, TEXT, TEXT)
  TO authenticated;
