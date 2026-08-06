-- =============================================================================
-- Gate 3E-D4-C1 -- Special Price Approval Schema & State Machine Foundation
--
-- Scope (lihat kontrak gate): schema minimal untuk proposal special price,
-- keputusan Owner, status pending approval, dan audit trail -- TANPA
-- membangun RPC submit-proposal, RPC approve/reject, UI, WhatsApp outbox,
-- atau perubahan KPI. Gate berikutnya membangun RPC SECURITY DEFINER yang
-- menulis ke tabel-tabel ini; gate ini HANYA menyiapkan fondasi database
-- yang fail-closed dan tidak bisa dilewati direct-client.
--
-- Audit preflight (dibuktikan sebelum implementasi):
--   1. sales_orders.status CHECK constraint (nama: sales_orders_status_check,
--      migration 20260626000003) -- 8 nilai existing (draft, confirmed,
--      processing, delivering, delivered, invoiced, paid, cancelled). Tidak
--      ada consumer yang mengasumsikan daftar TERTUTUP di level DB (RPC
--      status hanya membandingkan status TERTENTU, tidak pernah exhaustive
--      switch) -- lihat #2 di bawah untuk bukti per-consumer.
--   2. Consumer yang diaudit exhaustif terhadap status BARU
--      'pending_owner_approval':
--        - KPI achievement trigger (migration 20260805000001, baris 380)
--          HANYA fire pada NEW.status = 'confirmed' (allow-list, bukan
--          deny-list) -- status baru otomatis TIDAK pernah kredit KPI tanpa
--          perubahan apa pun (kontrak poin 15 "pending/rejected tidak masuk
--          KPI" terpenuhi secara struktural).
--        - confirm_sales_order_atomic (20260822000001:930) hanya mengecek
--          v_old_status = 'confirmed' untuk idempotent short-circuit --
--          SELAIN itu langsung SET status='confirmed' dari status APA PUN.
--          Order tidak bisa mencapai 'pending_owner_approval' di gate ini
--          (lihat #3), jadi ini bukan bypass yang AKTIF hari ini -- dicatat
--          sebagai temuan out-of-scope untuk gate approve/reject berikutnya
--          ("confirm RPC memvalidasinya pada gate berikutnya", sesuai
--          kontrak).
--        - update_sales_order_atomic (20260922000001) sudah draft-only
--          TANPA KECUALI -- tidak tersentuh oleh status baru ini.
--        - cancel_sales_order_atomic, create_order_cancellation_dispute,
--          resolve_order_cancellation_dispute: TIDAK menyentuh status
--          'pending_owner_approval' sama sekali (di luar allow-list masing-
--          masing) -- order pending approval sementara tidak bisa
--          dibatalkan lewat RPC ini; dicatat sebagai temuan out-of-scope,
--          bukan blocker gate ini (tidak diminta kontrak).
--        - sync_sales_order_delivery_status (20260717000001): hanya
--          menyentuh 'confirmed'/'delivering'/'delivered' -- tidak terpapar.
--        - apps/web/src/lib/orders/actions.ts OrderStatus (TS union type):
--          TIDAK diperluas oleh gate ini (tidak ada RPC/UI yang memproduksi
--          nilai ini pada gate ini -- lihat #3) supaya tidak menyiratkan
--          capability yang belum ada; gate approve/reject berikutnya wajib
--          memperbarui union ini.
--   3. DUA jalur direct-client yang bisa menulis sales_orders.status BEBAS
--      (celah PRE-EXISTING, bukan diperkenalkan gate ini) diperketat KHUSUS
--      untuk nilai baru ini (scope sempit -- tidak menyentuh perilaku status
--      lain yang sudah ada, konsisten pola containment 20260824000001/
--      20260825000001):
--        a. RLS sales_orders_insert/sales_orders_update (20260626000004) --
--           TIDAK PERNAH memeriksa status target sama sekali untuk pemegang
--           'orders.manage'. WITH CHECK ditambahkan: status target tidak
--           boleh 'pending_owner_approval' lewat jalur ini.
--        b. update_sales_order_status_atomic (20260822000001, diperluas
--           20260824000001 guard paid, 20260825000001 guard invoiced) --
--           menerima p_new_status APA PUN tanpa allow-list. Guard baru
--           (pola identik guard paid/invoiced existing): p_new_status =
--           'pending_owner_approval' ditolak ('special_price_approval_
--           workflow_required'), status existing = 'pending_owner_approval'
--           dibekukan dari RPC generik ini ('pending_owner_approval_locked').
--      create_sales_order_atomic/create_draft_sales_order_atomic/
--      update_draft_sales_order_atomic selalu hardcode status='draft' --
--      tidak ada parameter status, tidak tersentuh.
--      Hasil: value diterima CHECK constraint (test kontrak #2), tapi TIDAK
--      ADA jalur (direct-client ATAU RPC service-role generik) yang bisa
--      benar-benar menghasilkan order berstatus ini pada gate ini --
--      "boleh menambahkan status, belum boleh membuka cara menetapkannya"
--      sesuai kontrak. RPC submit-proposal (gate berikutnya) akan menjadi
--      SECURITY DEFINER baru yang menulis status ini secara eksplisit --
--      tidak terpengaruh guard di atas (guard ini scoped ke RPC/RLS
--      EXISTING, bukan RPC baru).
--   4. knowledge_discount_policies (20260709000001): scope
--      global/product/customer, max_percentage/max_nominal nullable,
--      is_active. Precedence (product > customer > global) adalah application
--      logic (apps/web/src/lib/sales-orders/discount.ts:findApplicablePolicy)
--      -- gate ini HANYA menyimpan snapshot hasil evaluasi (policy_id +
--      nilai limit pada waktu evaluasi), tidak mengimplementasikan ulang
--      logic evaluasi (itu scope RPC submit-proposal gate berikutnya).
--   5. audit_logs (20260626000003, diperluas 20260819000001): pola
--      append-only kanonis -- REVOKE INSERT/UPDATE/DELETE/TRUNCATE dari
--      authenticated/anon, TANPA policy RLS UPDATE/DELETE. Pola identik
--      diterapkan pada dua tabel baru gate ini.
--   6. Owner canonical: role 'owner' (roles.name, seed system role) dijamin
--      TEPAT SATU per company_id oleh trigger enforce_single_owner_per_company
--      (20260906000001, tidak diubah). Pola pemeriksaan "strictly owner +
--      aktif + tenant sama" mengikuti persis audit_logs_select
--      (20260819000001): EXISTS join users/user_roles/roles dengan
--      u.is_active = TRUE AND r.name = 'owner' -- BUKAN user_has_role()
--      (yang tidak memeriksa is_active).
--
-- Desain: child table terstruktur untuk snapshot line (BUKAN JSONB) --
-- keputusan Owner bergantung pada tiap line (harga master, harga proposed,
-- diskon implied per produk), sehingga referential integrity + constraint
-- per-kolom lebih aman daripada JSONB tervalidasi longgar. Kolom
-- implied_discount_percentage adalah GENERATED ALWAYS ... STORED dari
-- master_unit_price/proposed_unit_price -- TIDAK BISA dipalsukan client
-- ATAU RPC penulis manapun (kontrak poin 12 "discount dihitung server-side"
-- ditegakkan di level tipe data, bukan hanya disiplin kode).
--
-- Invariant lintas tabel (tenant, requester, decider strictly-owner, versi
-- meningkat, snapshot immutable, decision immutable) ditegakkan lewat
-- trigger BEFORE INSERT OR UPDATE -- BUKAN RLS saja, sesuai kontrak poin 16.
-- Trigger ini berlaku untuk SEMUA jalur tulis termasuk service-role/RPC
-- masa depan (pola identik gate_3d_b1_single_owner_enforcement) -- RPC
-- submit-proposal/approve-reject gate berikutnya WAJIB menghasilkan baris
-- yang lolos invariant ini, tidak ada bypass trigger untuk SECURITY DEFINER.
--
-- Tulis (INSERT/UPDATE/DELETE) dari client authenticated/anon di-REVOKE
-- total pada kedua tabel baru -- SATU-SATUNYA jalur tulis yang sah adalah
-- RPC SECURITY DEFINER (service_role) yang akan dibangun gate berikutnya.
-- RLS hanya mengatur SELECT (tenant + Owner-seluruh-tenant + Sales-pemilik-
-- order-sendiri).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. sales_orders.status -- tambah nilai 'pending_owner_approval' (additive,
--    tidak mengubah 8 nilai existing, tidak menyentuh baris existing).
-- -----------------------------------------------------------------------------

ALTER TABLE public.sales_orders
  DROP CONSTRAINT sales_orders_status_check;

ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_status_check
  CHECK (status IN (
    'draft','confirmed','processing','delivering','delivered','invoiced',
    'paid','cancelled','pending_owner_approval'
  ));

COMMENT ON COLUMN public.sales_orders.status IS
  'Gate 3E-D4-C1: menambahkan pending_owner_approval (additive). Tidak ada jalur direct-client atau RPC service-role EXISTING yang bisa menetapkan nilai ini pada gate ini -- lihat guard sales_orders_insert/update dan update_sales_order_status_atomic di migration yang sama. RPC submit-proposal (gate berikutnya) adalah satu-satunya jalur yang dirancang untuk menetapkannya.';

-- -----------------------------------------------------------------------------
-- 2a. Tutup jalur direct-client (RLS) -- sales_orders_insert/update TIDAK
--     PERNAH memeriksa status target untuk pemegang orders.manage (celah
--     pre-existing). Tambahan WITH CHECK di bawah HANYA melarang nilai BARU
--     ini secara spesifik -- perilaku existing untuk status lain TIDAK
--     berubah (celah pre-existing untuk status lain di luar scope gate ini).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "sales_orders_insert" ON public.sales_orders;

CREATE POLICY "sales_orders_insert" ON public.sales_orders
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('orders.create')
    AND status <> 'pending_owner_approval'
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
    AND (
      public.user_has_permission('orders.manage')
      OR (sales_id = auth.uid() AND status = 'draft')
    )
  );

-- -----------------------------------------------------------------------------
-- 2b. Tutup jalur RPC generik (update_sales_order_status_atomic) -- pola
--     IDENTIK guard paid (20260824000001)/invoiced (20260825000001): tidak
--     ada aktor, termasuk owner, yang bisa masuk/keluar dari
--     pending_owner_approval lewat mutation status generik. Guard baru
--     dicek SEBELUM guard paid/invoiced existing (urutan tidak memengaruhi
--     hasil karena status-status ini saling eksklusif, tapi konsisten
--     dengan pola "guard status TERBARU dicek lebih dulu" yang sudah
--     dipakai invoiced->paid).
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

  -- Guard E (Gate 3E-D4-C1): order yang sedang pending_owner_approval
  -- dibekukan dari generic mutation ini -- keluar dari status ini hanya
  -- lewat RPC approve/reject Owner (gate berikutnya), bukan RPC generik.
  IF v_old_status = 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'pending_owner_approval_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard D: order yang sudah invoiced dibekukan dari generic mutation ini
  -- -- tidak ada jalur "koreksi"/reversal invoiced -> status lain (termasuk
  -- -> paid) lewat RPC generik. Koreksi invoice hanya lewat jalur issuance
  -- canonical (issued_documents) pada gate mendatang.
  IF v_old_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoiced_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard B: order yang sudah paid dibekukan dari generic mutation ini --
  -- tidak ada jalur "koreksi" paid -> status lain lewat RPC generik. Payment
  -- correction hanya lewat payment workflow terverifikasi (gate mendatang).
  IF v_old_status = 'paid' THEN
    RETURN QUERY SELECT 'paid_locked'::TEXT;
    RETURN;
  END IF;

  -- Guard F (Gate 3E-D4-C1): tidak ada aktor -- termasuk owner -- yang bisa
  -- membuat order pending_owner_approval lewat generic status mutation.
  -- Status ini hanya boleh berasal dari RPC submit-proposal canonical
  -- (gate berikutnya), bukan klik status generik.
  IF p_new_status = 'pending_owner_approval' THEN
    RETURN QUERY SELECT 'special_price_approval_workflow_required'::TEXT;
    RETURN;
  END IF;

  -- Guard C: tidak ada aktor -- termasuk owner -- yang bisa membuat order
  -- invoiced lewat generic status mutation. Status invoiced hanya boleh
  -- berasal dari jalur issuance canonical (issueInvoiceDocument() /
  -- issued_documents) pada gate mendatang, bukan klik status generik.
  IF p_new_status = 'invoiced' THEN
    RETURN QUERY SELECT 'invoice_issuance_required'::TEXT;
    RETURN;
  END IF;

  -- Guard A: tidak ada aktor -- termasuk owner -- yang bisa membuat order
  -- paid lewat generic status mutation. Status paid hanya boleh berasal dari
  -- payment fact yang sah pada payment workflow mendatang.
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

REVOKE ALL ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_status_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;

-- -----------------------------------------------------------------------------
-- 3. special_price_approval_requests -- entity canonical satu proposal.
-- -----------------------------------------------------------------------------

CREATE TABLE public.special_price_approval_requests (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id      UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  proposal_version    INTEGER       NOT NULL CHECK (proposal_version > 0),
  status              VARCHAR(20)   NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  requested_by        UUID          NOT NULL REFERENCES public.users (id),
  requested_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  reason              TEXT,
  order_snapshot_hash TEXT          NOT NULL CHECK (length(order_snapshot_hash) > 0),
  decided_by          UUID          REFERENCES public.users (id),
  decision_reason     TEXT,
  decided_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spar_decision_consistency CHECK (
    (status = 'PENDING'  AND decided_by IS NULL     AND decided_at IS NULL)
    OR
    (status IN ('APPROVED','REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  UNIQUE (sales_order_id, proposal_version)
);

-- Invariant #6: hanya satu request PENDING aktif per order (race-safe --
-- unique index, bukan EXISTS check yang rentan race dua INSERT konkuren).
CREATE UNIQUE INDEX uq_spar_one_pending_per_order
  ON public.special_price_approval_requests (sales_order_id)
  WHERE status = 'PENDING';

CREATE INDEX idx_spar_company_id ON public.special_price_approval_requests (company_id);
CREATE INDEX idx_spar_order_id   ON public.special_price_approval_requests (sales_order_id);
CREATE INDEX idx_spar_status     ON public.special_price_approval_requests (company_id, status);

COMMENT ON TABLE public.special_price_approval_requests IS
  'Gate 3E-D4-C1: satu baris = satu proposal special price untuk satu sales_order (berlaku untuk SATU order, poin kontrak #2). Tulis hanya lewat RPC SECURITY DEFINER (service_role) -- INSERT/UPDATE/DELETE di-REVOKE dari authenticated/anon. Approval TIDAK mengonfirmasi order -- confirmation tetap lewat confirm_sales_order_atomic (gate berikutnya menambahkan validasi approval pada RPC tsb).';
COMMENT ON COLUMN public.special_price_approval_requests.order_snapshot_hash IS
  'Hash/fingerprint isi order (customer, item, qty, harga) saat proposal dibuat -- dipakai gate berikutnya untuk mendeteksi perubahan order setelah approval (poin kontrak #14: perubahan apa pun membuat approval lama tidak berlaku). Dihitung oleh RPC penulis, bukan gate ini.';
COMMENT ON COLUMN public.special_price_approval_requests.decided_by IS
  'Wajib role owner AKTIF pada tenant yang sama -- ditegakkan trigger trg_spar_enforce_invariants, BUKAN hanya RLS (poin kontrak #16).';

-- -----------------------------------------------------------------------------
-- 4. special_price_approval_lines -- snapshot per line (child table
--    terstruktur, bukan JSONB -- keputusan bergantung pada tiap line).
-- -----------------------------------------------------------------------------

CREATE TABLE public.special_price_approval_lines (
  id                              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id             UUID          NOT NULL REFERENCES public.special_price_approval_requests (id) ON DELETE CASCADE,
  line_number                     INTEGER       NOT NULL CHECK (line_number > 0),
  product_id                      UUID          NOT NULL REFERENCES public.products (id),
  product_name_snapshot           VARCHAR(255)  NOT NULL,
  quantity                        INTEGER       NOT NULL CHECK (quantity > 0),
  master_unit_price               NUMERIC(15,2) NOT NULL CHECK (master_unit_price > 0),
  proposed_unit_price             NUMERIC(15,2) NOT NULL CHECK (proposed_unit_price > 0),
  implied_discount_percentage     NUMERIC(7,4)  GENERATED ALWAYS AS (
                                     ROUND((master_unit_price - proposed_unit_price) / master_unit_price * 100, 4)
                                   ) STORED,
  policy_id                       UUID          REFERENCES public.knowledge_discount_policies (id) ON DELETE SET NULL,
  policy_scope_snapshot           VARCHAR(20)   CHECK (policy_scope_snapshot IS NULL OR policy_scope_snapshot IN ('global','product','customer')),
  policy_max_percentage_snapshot  NUMERIC(5,2),
  policy_max_nominal_snapshot     NUMERIC(15,2),
  effective_floor_unit_price      NUMERIC(15,2) NOT NULL CHECK (effective_floor_unit_price >= 0),
  created_at                      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_spal_price_is_discount CHECK (proposed_unit_price <= master_unit_price),
  UNIQUE (approval_request_id, line_number)
);

CREATE INDEX idx_spal_request_id ON public.special_price_approval_lines (approval_request_id);

COMMENT ON TABLE public.special_price_approval_lines IS
  'Gate 3E-D4-C1: snapshot per-line harga master vs proposed. implied_discount_percentage GENERATED STORED dari master_unit_price/proposed_unit_price -- tidak bisa dipalsukan client/RPC (poin kontrak #12). effective_floor_unit_price = harga minimum yang diizinkan knowledge_discount_policies yang cocok pada waktu evaluasi (0 jika tidak ada policy yang cocok -- fail-closed, poin kontrak #5); dihitung RPC penulis (gate berikutnya), bukan gate ini.';

-- -----------------------------------------------------------------------------
-- 5. Trigger invariant -- special_price_approval_requests (INSERT + UPDATE).
--    Berlaku untuk SEMUA jalur tulis termasuk service-role/RPC masa depan --
--    pola identik enforce_single_owner_per_company (20260906000001).
-- -----------------------------------------------------------------------------

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

    -- Invariant #1: approval request dan order harus company yang sama.
    IF v_order.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'AODP_SPAR_TENANT_MISMATCH: company_id request harus sama dengan company_id order'
        USING ERRCODE = '23514';
    END IF;

    -- Invariant #2: requester tenant sama DAN merupakan Sales pemilik order.
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

    -- Invariant #7: versi unik DAN meningkat per order (UNIQUE constraint
    -- menolak duplikat; pemeriksaan berikut menolak versi mundur/lompat
    -- turun walau belum terpakai, mis. insert version=1 setelah version=3).
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
    -- Invariant #9: keputusan final tidak dapat diubah/dibalik.
    IF OLD.status <> 'PENDING' THEN
      RAISE EXCEPTION 'AODP_SPAR_DECISION_IMMUTABLE: keputusan final (APPROVED/REJECTED) tidak dapat diubah'
        USING ERRCODE = '23514';
    END IF;

    -- Invariant #8: snapshot proposal yang sudah dibuat tidak dapat diedit
    -- -- HANYA status/decided_by/decided_at/decision_reason boleh berubah
    -- dari transisi PENDING -> APPROVED/REJECTED.
    IF NEW.company_id          IS DISTINCT FROM OLD.company_id
       OR NEW.sales_order_id   IS DISTINCT FROM OLD.sales_order_id
       OR NEW.proposal_version IS DISTINCT FROM OLD.proposal_version
       OR NEW.requested_by     IS DISTINCT FROM OLD.requested_by
       OR NEW.requested_at     IS DISTINCT FROM OLD.requested_at
       OR NEW.reason           IS DISTINCT FROM OLD.reason
       OR NEW.order_snapshot_hash IS DISTINCT FROM OLD.order_snapshot_hash
       OR NEW.created_at       IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'AODP_SPAR_SNAPSHOT_IMMUTABLE: isi proposal tidak dapat diubah setelah dibuat'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status NOT IN ('APPROVED','REJECTED') THEN
      RAISE EXCEPTION 'AODP_SPAR_INVALID_TRANSITION: transisi status hanya PENDING->APPROVED atau PENDING->REJECTED'
        USING ERRCODE = '23514';
    END IF;

    -- Invariant #3: decider tenant sama DAN strictly role owner AKTIF --
    -- pola identik audit_logs_select (20260819000001), BUKAN user_has_role()
    -- (tidak memeriksa is_active).
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

COMMENT ON FUNCTION public.enforce_special_price_approval_request_invariants() IS
  'Gate 3E-D4-C1: menegakkan tenant match, requester = sales pemilik order, versi meningkat, status awal PENDING (INSERT); snapshot immutable, keputusan final immutable, decider strictly owner aktif tenant sama (UPDATE). Berlaku untuk semua jalur tulis termasuk service-role.';

DROP TRIGGER IF EXISTS trg_spar_enforce_invariants ON public.special_price_approval_requests;
CREATE TRIGGER trg_spar_enforce_invariants
  BEFORE INSERT OR UPDATE ON public.special_price_approval_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_special_price_approval_request_invariants();

-- -----------------------------------------------------------------------------
-- 6. Trigger invariant -- special_price_approval_lines. INSERT: validasi
--    tenant produk/policy terhadap company request induk. UPDATE: blokir
--    total (baris snapshot sepenuhnya immutable -- koreksi = proposal versi
--    baru, bukan edit in-place, pola identik sales_order_items yang selalu
--    DELETE+INSERT ulang, bukan UPDATE in-place).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_special_price_approval_line_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_company_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AODP_SPAL_IMMUTABLE: baris snapshot proposal tidak dapat diubah setelah dibuat -- buat proposal versi baru'
      USING ERRCODE = '23514';
  END IF;

  SELECT company_id INTO v_company_id
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

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_special_price_approval_line_invariants() IS
  'Gate 3E-D4-C1: INSERT -- product_id/policy_id (jika ada) wajib tenant sama dengan approval request induk. UPDATE -- diblokir total, baris snapshot immutable.';

DROP TRIGGER IF EXISTS trg_spal_enforce_invariants ON public.special_price_approval_lines;
CREATE TRIGGER trg_spal_enforce_invariants
  BEFORE INSERT OR UPDATE ON public.special_price_approval_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_special_price_approval_line_invariants();

-- -----------------------------------------------------------------------------
-- 7. RLS -- SELECT tenant-scoped (Owner: seluruh tenant; Sales: proposal
--    order miliknya sendiri). Tidak ada policy INSERT/UPDATE/DELETE --
--    dikombinasikan dengan REVOKE eksplisit di bawah (pola identik
--    audit_logs, 20260819000001) supaya append-only tidak bergantung pada
--    "kebetulan tidak ada policy". Tulis hanya lewat RPC SECURITY DEFINER
--    (service_role, bypass RLS total) pada gate berikutnya.
-- -----------------------------------------------------------------------------

ALTER TABLE public.special_price_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.special_price_approval_lines     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "spar_select" ON public.special_price_approval_requests
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      EXISTS (
        SELECT 1
        FROM public.users u
        JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
        JOIN public.roles r ON r.id = ur.role_id
        WHERE u.id = auth.uid()
          AND u.company_id = public.get_user_company_id()
          AND u.is_active = TRUE
          AND r.name = 'owner'
      )
      OR requested_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.sales_orders o
        WHERE o.id = sales_order_id AND o.sales_id = auth.uid()
      )
    )
  );

CREATE POLICY "spal_select" ON public.special_price_approval_lines
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.special_price_approval_requests req
      WHERE req.id = approval_request_id
        AND req.company_id = public.get_user_company_id()
        AND (
          EXISTS (
            SELECT 1
            FROM public.users u
            JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
            JOIN public.roles r ON r.id = ur.role_id
            WHERE u.id = auth.uid()
              AND u.company_id = public.get_user_company_id()
              AND u.is_active = TRUE
              AND r.name = 'owner'
          )
          OR req.requested_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.sales_orders o
            WHERE o.id = req.sales_order_id AND o.sales_id = auth.uid()
          )
        )
    )
  );

REVOKE INSERT, UPDATE, DELETE ON TABLE public.special_price_approval_requests FROM authenticated, anon;
REVOKE TRUNCATE             ON TABLE public.special_price_approval_requests FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.special_price_approval_lines     FROM authenticated, anon;
REVOKE TRUNCATE             ON TABLE public.special_price_approval_lines     FROM authenticated, anon;
