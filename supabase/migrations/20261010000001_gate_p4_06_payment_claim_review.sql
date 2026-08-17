-- =============================================================================
-- Gate P4.06 -- Klaim Pembayaran sales/driver "all-in" + review Finance/Owner.
--
-- Keputusan Founder 2026-08-17 (bundel 5 keputusan bisnis): sales/driver yang
-- terima order + antar barang + tagih/terima cash sendiri (kasus Pak Waluyo)
-- tidak punya jalur apa pun mencatat pembayaran yang diterimanya --
-- `payment.record` (RPC `record_verified_payment_atomic`, Gate 2D,
-- `20260829000001`) SENGAJA hanya owner/finance, dan RPC itu langsung
-- mengkredit `receivable_ledger` secara atomic + immutable begitu dipanggil
-- (didesain sebagai jalur "SUDAH terverifikasi", TANPA tahap review).
-- Memberi sales/driver akses LANGSUNG ke RPC itu akan menghilangkan makna
-- "terverifikasi" itu sendiri -- BUKAN guardrail yang diminta Founder,
-- justru sebaliknya (instruksi eksplisit Founder: "jangan kasih ruang gerak
-- sales untuk berbuat curang thd owner").
--
-- Desain (baru, additive -- RPC/tabel Gate 2D TIDAK disentuh/diubah sama
-- sekali, hanya dipanggil sebagai komposisi):
--   sales/driver submit_payment_claim_atomic() -> status PENDING, TIDAK
--   menyentuh receivable_ledger/payment_receipts sama sekali (murni laporan,
--   sama semangatnya dengan collection_activities Gate 2C -- "klaim TIDAK
--   PERNAH menyentuh ledger") -> owner/finance
--   approve_payment_claim_atomic() (memanggil record_verified_payment_atomic
--   yang sudah locked, TIDAK diduplikasi logicnya) ATAU
--   reject_payment_claim_atomic() (murni ubah status, ledger tidak tersentuh).
--
-- Prinsip anti-kecurangan (instruksi eksplisit Founder) yang ditegakkan di
-- desain ini:
--   1. Klaim sales/driver TIDAK PERNAH otomatis jadi kredit ledger -- HANYA
--      approve_payment_claim_atomic (permission payment.record, tetap
--      owner/finance saja, TIDAK diperluas) yang bisa membuat itu terjadi.
--   2. Nominal & metode pada klaim TERKUNCI sejak submit (trigger guard,
--      berlaku bahkan utk service_role) -- sales tidak bisa mengubah
--      klaimnya sendiri setelah dikirim untuk "menyesuaikan" cerita.
--   3. Bukti verifikasi SAAT APPROVE (p_proofs di approve_payment_claim_atomic)
--      TETAP WAJIB minimal 1 (mewarisi PROOF_REQUIRED dari
--      record_verified_payment_atomic, tidak dilonggarkan) -- Finance-lah
--      yang membubuhkan bukti verifikasi sungguhan (cocokkan ke rekening/
--      hitung cash fisik) sebelum uang benar-benar diakui, bukan sekadar
--      percaya laporan sales.
--   4. Klaim TIDAK BISA diputuskan dua kali (PENDING->APPROVED/REJECTED,
--      sekali, tidak bisa dibalik) -- trigger guard independen dari RLS,
--      pola sama seperti immutability Gate 2D.
--   5. Setiap submit/approve/reject tercatat audit_logs -- termasuk siapa
--      approve/reject dan kapan, sehingga ada jejak penuh dari klaim sampai
--      keputusan.
--
-- KEPUTUSAN SEMENTARA (2026-08-17, ditinjau ulang setelah Pak Waluyo
-- dikonfirmasi langsung): bukti (proof) pada SISI KLAIM (submit) dibuat
-- OPSIONAL -- TIDAK ada PROOF_REQUIRED di submit_payment_claim_atomic,
-- beda dari record_verified_payment_atomic (Gate 2D) yang mewajibkan
-- minimal 1 proof. Ini permintaan eksplisit Founder ("jadikan optional
-- dulu sebelum dapat keputusan dari Pak Waluyo langsung") -- bukti WAJIB
-- tetap ditegakkan di titik approve (lihat prinsip #3 di atas), jadi tidak
-- ada uang yang benar-benar masuk ledger tanpa bukti sama sekali,
-- hanya SUMBER pengambil bukti pertama yang belum final.
--
-- Amount pada saat approve TIDAK BISA diubah oleh Finance dari nominal yang
-- diklaim sales (sengaja, mencegah silent adjustment tanpa jejak) -- kalau
-- Finance menemukan selisih, jalur yang benar adalah REJECT dengan alasan,
-- bukan approve dengan angka berbeda. Sales lapor ulang kalau perlu.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. payment_claims -- laporan pembayaran dari sales/driver, PENDING sampai
--    diputuskan Owner/Finance. TIDAK PERNAH menyentuh receivable_ledger.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_claims (
  id                            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                    UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id                   UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  method                        VARCHAR(20)   NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  amount                        NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  transfer_reference            TEXT          CHECK (transfer_reference IS NULL OR length(trim(transfer_reference)) > 0),
  note                          TEXT          CHECK (note IS NULL OR length(trim(note)) > 0),
  claimed_by                    UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  claimed_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  status                        VARCHAR(20)   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reviewed_by                   UUID          REFERENCES public.users (id) ON DELETE RESTRICT,
  reviewed_at                   TIMESTAMPTZ,
  rejection_reason              TEXT          CHECK (rejection_reason IS NULL OR length(trim(rejection_reason)) > 0),
  approved_payment_receipt_id   UUID          REFERENCES public.payment_receipts (id) ON DELETE RESTRICT,
  request_payload               JSONB         NOT NULL,
  idempotency_key                TEXT,
  created_at                    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, idempotency_key),
  -- Konsistensi status<->kolom review, ditegakkan di level tabel (bukan
  -- hanya RPC) -- backstop kedua di atas trigger guard section 4.
  CONSTRAINT chk_payment_claims_review_consistency CHECK (
    (status = 'PENDING'  AND reviewed_by IS NULL     AND reviewed_at IS NULL     AND approved_payment_receipt_id IS NULL AND rejection_reason IS NULL) OR
    (status = 'APPROVED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND approved_payment_receipt_id IS NOT NULL AND rejection_reason IS NULL) OR
    (status = 'REJECTED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NOT NULL AND approved_payment_receipt_id IS NULL)
  )
);

CREATE INDEX idx_payment_claims_company_status ON public.payment_claims (company_id, status, claimed_at DESC);
CREATE INDEX idx_payment_claims_claimed_by     ON public.payment_claims (claimed_by);
CREATE INDEX idx_payment_claims_customer_id    ON public.payment_claims (customer_id);

COMMENT ON TABLE public.payment_claims IS
  'Gate P4.06: laporan pembayaran dari sales/driver "all-in" (belum terverifikasi) -- TIDAK PERNAH menyentuh receivable_ledger secara langsung. PENDING sampai owner/finance approve (record_verified_payment_atomic dipanggil, ledger benar-benar kredit) atau reject (ledger tidak tersentuh). Kolom inti terkunci setelah dibuat (trg_payment_claims_review_guard) -- sales tidak bisa mengedit klaimnya sendiri.';
COMMENT ON COLUMN public.payment_claims.request_payload IS
  'Snapshot kanonik request submit (utk perbandingan idempotency_key retry dengan payload berbeda, pola sama payment_receipts.request_payload).';

-- ---------------------------------------------------------------------------
-- 2. payment_claim_proofs -- bukti OPSIONAL sisi klaim (lihat catatan
--    "KEPUTUSAN SEMENTARA" di header). Struktur identik payment_proofs.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_claim_proofs (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_claim_id  UUID          NOT NULL REFERENCES public.payment_claims (id) ON DELETE CASCADE,
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  proof_type        TEXT          NOT NULL CHECK (length(trim(proof_type)) > 0),
  object_reference  TEXT          NOT NULL CHECK (length(trim(object_reference)) > 0),
  metadata          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by       UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_claim_proofs_claim_id ON public.payment_claim_proofs (payment_claim_id);

COMMENT ON TABLE public.payment_claim_proofs IS
  'Bukti OPSIONAL yang dilampirkan sales/driver saat submit klaim (foto struk/transfer, dsb) -- TIDAK diwajibkan minimal 1 (beda dari payment_proofs Gate 2D), keputusan sementara sampai Pak Waluyo mengonfirmasi. Bukti WAJIB tetap ditegakkan di titik approve lewat record_verified_payment_atomic.';

-- ---------------------------------------------------------------------------
-- 3. Immutability -- kolom inti + DELETE terkunci, independen dari RLS/
--    kepercayaan service_role (pola sama Gate 2D "Independen dari RLS").
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_payment_claim_review_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.transfer_reference IS DISTINCT FROM OLD.transfer_reference
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
     OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_CORE_IMMUTABLE: kolom klaim inti (customer/metode/nominal/pelapor) tidak dapat diubah setelah dibuat, klaim %', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_ALREADY_DECIDED: klaim % sudah diputuskan (%), tidak dapat diubah lagi', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_INVALID_TRANSITION: status tujuan harus APPROVED atau REJECTED, dapat %', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.guard_payment_claim_review_transition IS
  'BEFORE UPDATE guard payment_claims: kolom inti tidak pernah berubah, status hanya boleh PENDING->APPROVED atau PENDING->REJECTED (sekali, tidak bisa dibalik/diubah lagi). Berlaku utk siapa pun termasuk service_role.';

DROP TRIGGER IF EXISTS trg_payment_claims_review_guard ON public.payment_claims;
CREATE TRIGGER trg_payment_claims_review_guard
  BEFORE UPDATE ON public.payment_claims
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_claim_review_transition();

CREATE OR REPLACE FUNCTION public.prevent_payment_claim_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'PAYMENT_CLAIM_IMMUTABLE: payment_claim % tidak dapat dihapus', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_claims_no_delete ON public.payment_claims;
CREATE TRIGGER trg_payment_claims_no_delete
  BEFORE DELETE ON public.payment_claims
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_claim_delete();

CREATE OR REPLACE FUNCTION public.prevent_payment_claim_proof_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_PROOF_IMMUTABLE: payment_claim_proof % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'PAYMENT_CLAIM_PROOF_IMMUTABLE: payment_claim_proof % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_claim_proofs_immutable ON public.payment_claim_proofs;
CREATE TRIGGER trg_payment_claim_proofs_immutable
  BEFORE UPDATE OR DELETE ON public.payment_claim_proofs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_claim_proof_mutation();

-- ---------------------------------------------------------------------------
-- 4. Tenant consistency (BEFORE INSERT) -- pola sama Gate 2D.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_payment_claim_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_customer_company_id UUID;
BEGIN
  SELECT company_id INTO v_customer_company_id FROM public.customers WHERE id = NEW.customer_id;
  IF v_customer_company_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', NEW.customer_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_customer_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: customer % bukan milik company %', NEW.customer_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_claims_tenant ON public.payment_claims;
CREATE TRIGGER trg_payment_claims_tenant
  BEFORE INSERT ON public.payment_claims
  FOR EACH ROW EXECUTE FUNCTION public.validate_payment_claim_tenant();

CREATE OR REPLACE FUNCTION public.validate_payment_claim_proof_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_claim_company_id UUID;
BEGIN
  SELECT company_id INTO v_claim_company_id FROM public.payment_claims WHERE id = NEW.payment_claim_id;
  IF v_claim_company_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_CLAIM_NOT_FOUND: %', NEW.payment_claim_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_claim_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: payment_claim % bukan milik company %', NEW.payment_claim_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_claim_proofs_tenant ON public.payment_claim_proofs;
CREATE TRIGGER trg_payment_claim_proofs_tenant
  BEFORE INSERT ON public.payment_claim_proofs
  FOR EACH ROW EXECUTE FUNCTION public.validate_payment_claim_proof_tenant();

-- ---------------------------------------------------------------------------
-- 5. Permission + RLS.
--    payment.claim: HANYA sales & driver (yang butuh jalur lapor ini --
--    owner/finance sudah punya payment.record, tidak perlu klaim).
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('payment.claim', 'payment', 'claim', 'Melaporkan (klaim) pembayaran yang diterima langsung dari customer -- belum terverifikasi, menunggu approve/reject Owner/Finance')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('sales', 'driver')
  AND p.name = 'payment.claim'
ON CONFLICT DO NOTHING;

ALTER TABLE public.payment_claims       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_claim_proofs ENABLE ROW LEVEL SECURITY;

-- SELECT: pelapor lihat klaim miliknya sendiri; owner/finance (payment.record)
-- lihat semua klaim tenant (perlu utk antrian review).
CREATE POLICY "payment_claims_select" ON public.payment_claims
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (claimed_by = auth.uid() OR public.user_has_permission('payment.record'))
  );

CREATE POLICY "payment_claim_proofs_select" ON public.payment_claim_proofs
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (uploaded_by = auth.uid() OR public.user_has_permission('payment.record'))
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payment_claims, public.payment_claim_proofs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_claims, public.payment_claim_proofs TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC -- submit_payment_claim_atomic(). Permission payment.claim.
--    p_proofs OPSIONAL (default '[]'::jsonb, lihat catatan header).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_payment_claim_atomic(
  p_company_id          UUID,
  p_actor_id            UUID,
  p_customer_id         UUID,
  p_method              TEXT,
  p_amount              NUMERIC,
  p_transfer_reference  TEXT DEFAULT NULL,
  p_note                TEXT DEFAULT NULL,
  p_proofs              JSONB DEFAULT '[]'::jsonb,
  p_idempotency_key     TEXT DEFAULT NULL
) RETURNS TABLE(
  out_claim_id       UUID,
  out_already_exists BOOLEAN,
  out_status         TEXT
) AS $$
DECLARE
  v_transfer_reference TEXT;
  v_note               TEXT;
  v_proofs             JSONB;
  v_request_payload    JSONB;
  v_existing            public.payment_claims%ROWTYPE;
  v_actor_allowed       BOOLEAN;
  v_customer_company_id UUID;
  v_claim_id            UUID;
  v_proof_elem          JSONB;
  v_proof_count         INTEGER;
BEGIN
  IF p_method NOT IN ('cash', 'bank_transfer') THEN
    RAISE EXCEPTION 'INVALID_METHOD: %', p_method USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: % harus lebih dari 0', p_amount USING ERRCODE = 'check_violation';
  END IF;

  v_proofs := COALESCE(p_proofs, '[]'::jsonb);
  IF jsonb_typeof(v_proofs) <> 'array' THEN
    RAISE EXCEPTION 'INVALID_PROOFS: p_proofs harus berupa array (boleh kosong)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_proofs) elem
    WHERE elem->>'proof_type' IS NULL OR length(trim(elem->>'proof_type')) = 0
       OR elem->>'object_reference' IS NULL OR length(trim(elem->>'object_reference')) = 0
  ) THEN
    RAISE EXCEPTION 'INVALID_PROOF: setiap proof yang dilampirkan wajib memiliki proof_type dan object_reference' USING ERRCODE = 'check_violation';
  END IF;

  v_transfer_reference := NULLIF(trim(COALESCE(p_transfer_reference, '')), '');
  v_note := NULLIF(trim(COALESCE(p_note, '')), '');

  v_request_payload := jsonb_build_object(
    'customerId', p_customer_id,
    'method', p_method,
    'amount', p_amount,
    'transferReference', v_transfer_reference,
    'note', v_note,
    'proofs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'proofType', elem->>'proof_type',
        'objectReference', elem->>'object_reference',
        'metadata', COALESCE(elem->'metadata', '{}'::jsonb)
      ) ORDER BY elem->>'object_reference')
      FROM jsonb_array_elements(v_proofs) elem
    ), '[]'::jsonb)
  );

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payment_claims
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: idempotency_key % sudah dipakai dengan payload berbeda', p_idempotency_key
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN QUERY SELECT v_existing.id, TRUE, v_existing.status;
      RETURN;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'payment.claim'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.claim pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT company_id INTO v_customer_company_id FROM public.customers WHERE id = p_customer_id;
  IF v_customer_company_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', p_customer_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_customer_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: customer % bukan milik company %', p_customer_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.payment_claims (
    company_id, customer_id, method, amount, transfer_reference, note,
    claimed_by, request_payload, idempotency_key
  ) VALUES (
    p_company_id, p_customer_id, p_method, p_amount, v_transfer_reference, v_note,
    p_actor_id, v_request_payload, p_idempotency_key
  ) RETURNING id INTO v_claim_id;

  FOR v_proof_elem IN SELECT * FROM jsonb_array_elements(v_proofs) LOOP
    INSERT INTO public.payment_claim_proofs (payment_claim_id, company_id, proof_type, object_reference, metadata, uploaded_by)
    VALUES (v_claim_id, p_company_id, v_proof_elem->>'proof_type', v_proof_elem->>'object_reference', COALESCE(v_proof_elem->'metadata', '{}'::jsonb), p_actor_id);
  END LOOP;

  SELECT COUNT(*) INTO v_proof_count FROM public.payment_claim_proofs WHERE payment_claim_id = v_claim_id;
  IF v_proof_count <> jsonb_array_length(v_proofs) THEN
    RAISE EXCEPTION 'PROOF_MATERIALIZATION_INCOMPLETE: payment_claim % mengharapkan % proof, hanya % ter-insert', v_claim_id, jsonb_array_length(v_proofs), v_proof_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'payment.claim_submitted', 'payment_claims', v_claim_id,
    jsonb_build_object(
      'customer_id', p_customer_id, 'method', p_method, 'amount', p_amount,
      'transfer_reference', v_transfer_reference, 'proof_count', v_proof_count,
      'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_claim_id, FALSE, 'PENDING'::TEXT;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.submit_payment_claim_atomic IS
  'Gate P4.06: sales/driver melaporkan pembayaran yang diterima -- status PENDING, TIDAK menyentuh receivable_ledger/payment_receipts sama sekali. Proof OPSIONAL (keputusan sementara, lihat header migration). Permission payment.claim (sales/driver). Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.submit_payment_claim_atomic(UUID, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_payment_claim_atomic(UUID, UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, JSONB, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC -- approve_payment_claim_atomic(). Permission payment.record
--    (TIDAK diperluas -- tetap owner/finance saja). Bukti WAJIB (>=1) di
--    sini, mewarisi PROOF_REQUIRED dari record_verified_payment_atomic yang
--    dipanggil langsung (bukan diduplikasi) -- prinsip anti-kecurangan #3.
--    Nominal/metode/customer TERKUNCI dari klaim asal (Finance tidak bisa
--    diam-diam mengubah angka -- prinsip di atas).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_payment_claim_atomic(
  p_company_id   UUID,
  p_actor_id     UUID,
  p_claim_id     UUID,
  p_proofs       JSONB,
  p_allocations  JSONB
) RETURNS TABLE(
  out_outcome            TEXT,
  out_payment_receipt_id UUID
) AS $$
DECLARE
  v_claim               public.payment_claims%ROWTYPE;
  v_actor_allowed        BOOLEAN;
  v_mismatched_customer  UUID;
  v_receipt_id           UUID;
  v_already_exists        BOOLEAN;
BEGIN
  SELECT * INTO v_claim FROM public.payment_claims
  WHERE id = p_claim_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_claim.status <> 'PENDING' THEN
    RETURN QUERY SELECT 'already_decided'::TEXT, v_claim.approved_payment_receipt_id;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'payment.record'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.record pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Setiap invoice pada alokasi WAJIB milik customer YANG SAMA dengan
  -- klaim asal -- mencegah approval "tersesat" mengkredit customer lain.
  SELECT (elem->>'invoice_id')::UUID INTO v_mismatched_customer
  FROM jsonb_array_elements(p_allocations) elem
  JOIN public.invoices i ON i.id = (elem->>'invoice_id')::UUID
  WHERE i.customer_id <> v_claim.customer_id
  LIMIT 1;

  IF v_mismatched_customer IS NOT NULL THEN
    RAISE EXCEPTION 'ALLOCATION_CUSTOMER_MISMATCH: invoice % pada alokasi bukan milik customer % (customer pada klaim asal)', v_mismatched_customer, v_claim.customer_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Delegasi PENUH ke RPC canonical Gate 2D yang sudah locked -- nominal,
  -- metode, transfer_reference DIAMBIL DARI KLAIM (tidak menerima parameter
  -- baru dari Finance), idempotency_key diturunkan dari claim id (retry-safe,
  -- konsisten walau approve_payment_claim_atomic dipanggil ulang).
  SELECT rp.out_payment_receipt_id, rp.out_already_exists
  INTO v_receipt_id, v_already_exists
  FROM public.record_verified_payment_atomic(
    p_company_id, p_actor_id, v_claim.method, v_claim.amount,
    p_proofs, p_allocations, v_claim.transfer_reference,
    'claim-approval:' || p_claim_id::TEXT
  ) rp;

  UPDATE public.payment_claims
  SET status = 'APPROVED',
      reviewed_by = p_actor_id,
      reviewed_at = NOW(),
      approved_payment_receipt_id = v_receipt_id
  WHERE id = p_claim_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'payment.claim_approved', 'payment_claims', p_claim_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', 'APPROVED', 'payment_receipt_id', v_receipt_id, 'claimed_by', v_claim.claimed_by),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT 'approved'::TEXT, v_receipt_id;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.approve_payment_claim_atomic IS
  'Gate P4.06: Owner/Finance (payment.record) menyetujui klaim -- delegasi PENUH ke record_verified_payment_atomic (Gate 2D, tidak diduplikasi/diubah), bukti WAJIB minimal 1 di sini (Finance yang membuktikan verifikasi, bukan sales). Nominal/metode/customer terkunci dari klaim asal. Idempotent per claim_id (retry aman, tidak menggandakan receipt).';

REVOKE ALL ON FUNCTION public.approve_payment_claim_atomic(UUID, UUID, UUID, JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payment_claim_atomic(UUID, UUID, UUID, JSONB, JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC -- reject_payment_claim_atomic(). Permission payment.record.
--    Ledger TIDAK PERNAH tersentuh -- murni ubah status + alasan wajib.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reject_payment_claim_atomic(
  p_company_id        UUID,
  p_actor_id          UUID,
  p_claim_id          UUID,
  p_rejection_reason  TEXT
) RETURNS TABLE(out_outcome TEXT) AS $$
DECLARE
  v_claim         public.payment_claims%ROWTYPE;
  v_actor_allowed BOOLEAN;
  v_reason        TEXT;
BEGIN
  v_reason := NULLIF(trim(COALESCE(p_rejection_reason, '')), '');
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: alasan penolakan wajib diisi (minimal 3 karakter)' USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT * INTO v_claim FROM public.payment_claims
  WHERE id = p_claim_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF v_claim.status <> 'PENDING' THEN
    RETURN QUERY SELECT 'already_decided'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'payment.record'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.record pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.payment_claims
  SET status = 'REJECTED',
      reviewed_by = p_actor_id,
      reviewed_at = NOW(),
      rejection_reason = v_reason
  WHERE id = p_claim_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'payment.claim_rejected', 'payment_claims', p_claim_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', 'REJECTED', 'rejection_reason', v_reason, 'claimed_by', v_claim.claimed_by),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT 'rejected'::TEXT;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.reject_payment_claim_atomic IS
  'Gate P4.06: Owner/Finance (payment.record) menolak klaim dengan alasan wajib -- ledger TIDAK PERNAH tersentuh. Idempotent (already_decided kalau dipanggil ulang setelah diputuskan).';

REVOKE ALL ON FUNCTION public.reject_payment_claim_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payment_claim_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;
