-- =============================================================================
-- Migration: Customer Credit Ledger & Refund (Gate 2H.1)
--
-- Menutup residual customer credit yang lahir dari Gate 2F (Retur & Credit
-- Note) -- nilai credit_notes.customer_credit_amount yang TIDAK PERNAH
-- terpakai/terlihat setelah Gate 2F selesai (LIMITATION dicatat eksplisit di
-- migration 20260831000001, komentar desain: "tidak ada mekanisme konsumsi
-- yang perlu dibatalkan secara aktif karena tidak pernah dibuat di tempat
-- lain"). Gate 2H membuat mekanisme itu: Customer Credit Ledger (append-only,
-- terpisah TOTAL dari receivable_ledger) + Refund lifecycle
-- (requested -> approved|rejected) yang mencatat dan memverifikasi
-- pengembalian nilai tersebut ke customer -- TANPA mengeksekusi transfer
-- bank/cash (AODP hanya mencatat & memverifikasi, lihat kontrak §4.2/§8).
--
-- Kontrak acuan (FREEZE, tidak diubah gate ini):
--   docs/product/finance/AODP_GATE_2H_CUSTOMER_CREDIT_REFUND_CONTRACT.md
--   docs/product/finance/AODP_GATE_2H_CUSTOMER_CREDIT_REFUND (test matrix doc)
--
-- Dua tabel baru:
--   1. customer_credit_ledger -- buku besar BARU, append-only, TERPISAH TOTAL
--                                 dari receivable_ledger (kontrak §5). Setiap
--                                 baris terikat tepat satu credit_note_id
--                                 (kontrak §3 poin 1) -- "Customer Credit
--                                 Bucket". Tiga entry_type: credit_note_origin
--                                 (kredit, nominal == credit_notes.
--                                 customer_credit_amount, SATU baris per
--                                 credit_note -- partial UNIQUE index),
--                                 refund (debit, dari refund approved, SATU
--                                 baris per refund_id -- partial UNIQUE
--                                 index), reversal (debit compensating, dari
--                                 perluasan reverse_credit_note_atomic §6).
--   2. refund_requests        -- request header, transisi status TERBATAS
--                                 (requested -> approved|rejected), pola sama
--                                 returns (Gate 2F)/order_cancellations
--                                 (Gate 2G). ledger_entry_id diisi HANYA saat
--                                 approved (menunjuk baris debit
--                                 customer_credit_ledger yang bersangkutan).
--
-- Keputusan desain (kontrak §9 -- pertanyaan implementasi yang sengaja
-- dibiarkan terbuka, BUKAN keputusan bisnis baru):
--
--   - Baris kredit awal (credit_note_origin) dibuat LAZY -- pada saat
--     credit_note_id tersebut pertama kali "disentuh" Gate 2H (request_
--     refund_atomic ATAU perluasan reverse_credit_note_atomic), BUKAN eager
--     lewat RPC terpisah setelah verify_return_atomic. Nominalnya SELALU
--     == credit_notes.customer_credit_amount (tidak pernah dihitung ulang
--     dari return_items/invoice/payment/outstanding -- kontrak §2 poin 2),
--     dan HANYA dibuat jika customer_credit_amount > 0 (analog pola Gate 2F:
--     tidak ada ledger nol/palsu). UNIQUE partial index (credit_note_id)
--     WHERE entry_type='credit_note_origin' mencegah origin credit dibuat
--     dua kali secara STRUKTURAL (bukan hanya dicegah di RPC).
--   - Saldo SELALU derived: ledger_balance(cn) = SUM(kredit) - SUM(debit)
--     dari customer_credit_ledger; available_balance(cn) = ledger_balance(cn)
--     - SUM(refund_requests.amount WHERE status='requested') -- reservation
--     pending, dihitung ulang DI DALAM lock credit_notes (FOR UPDATE) pada
--     request_refund_atomic, pola identik verify_return_atomic mengunci
--     invoice (Gate 2F). Tidak ada kolom saldo bebas edit di mana pun.
--   - Refund TIDAK PERNAH menyentuh receivable_ledger/invoice/sales_order/
--     delivery/payment/return/credit_note Gate 2F (kontrak §5/§8) -- HANYA
--     customer_credit_ledger + refund_requests + audit_logs.
--   - Retry approve idempotent STRUKTURAL (kontrak §4.4 poin 5, pola identik
--     reverse_credit_note_atomic Gate 2F): refund_requests dikunci FOR UPDATE
--     sebelum transisi; jika status SUDAH 'approved' DAN p_decision='approve',
--     RPC mengembalikan hasil approval PERTAMA (ledger_entry_id/amount
--     tersimpan) TANPA menulis ledger/audit lagi -- TIDAK RAISE. Kombinasi
--     lain pada status final (reject->reject, reject->approve, approve->
--     reject) SELALU ditolak REFUND_ALREADY_RESOLVED (pola identik
--     RETURN_ALREADY_RESOLVED/ORDER_CANCELLATION_ALREADY_RESOLVED) -- hanya
--     retry APPROVE murni yang idempotent, bukan status final yang "dibuka
--     ulang" ke jalur lain.
--   - Idempotency struktural KEDUA (independen dari cek status di atas):
--     customer_credit_ledger.refund_id UNIQUE partial index -- bahkan jika
--     RPC punya bug yang mencoba insert debit kedua untuk refund_id yang
--     sama, constraint database menolaknya (kontrak §4.4 poin 6).
--   - Partial UNIQUE index BARU pada audit_logs (entity_id) WHERE
--     action='customer_credit.refund_approved' -- invariant produksi genuin
--     "maksimal satu audit refund_approved per refund_id" (mencegah audit
--     trail duplikat untuk keputusan finansial yang sama, konsisten dengan
--     "audit dan mutation bisnis harus atomik"). Index ini SEKALIGUS menjadi
--     titik uji NATURAL (bukan trigger test-only) untuk membuktikan kegagalan
--     insert audit_logs me-rollback SELURUH transaksi (ledger debit + status
--     approved) -- lihat integration test skenario "audit failure rollback".
--   - Method refund dibatasi ('cash','bank_transfer') -- identik domain
--     payment_receipts.method (Gate 2D), arah berlawanan (kas/transfer
--     KELUAR, bukan masuk).
--   - Permission 'refund.request': owner/finance (BUKAN manager/admin/
--     super_admin/sales) -- LEBIH SEMPIT dari return.request/order_
--     cancellation.request (instruksi kontrak eksplisit §4.3, dampak
--     finansial langsung ke kas keluar). 'refund.approve': HANYA owner --
--     pola identik return.verify/credit_note.reverse/order_cancellation.
--     approve (Gate 2F/2G).
--
-- Perluasan reverse_credit_note_atomic (Gate 2F, migration 20260831000001,
-- commit 5c919d2) -- CREATE OR REPLACE FUNCTION (BUKAN ALTER migration lama,
-- sesuai catatan kompatibilitas kontrak §6): signature IDENTIK, seluruh
-- perilaku existing DIPERTAHANKAN PERSIS untuk credit note yang tidak pernah
-- disentuh refund. Dua pemeriksaan BARU ditambahkan (setelah idempotency
-- check, sebelum compensating debit receivable_ledger):
--   (a) PENDING_REFUND_EXISTS -- refund_requests status='requested' pada
--       credit_note_id tsb menolak reversal (kontrak §6 poin 2).
--   (b) REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN -- refund_requests
--       status='approved' pada credit_note_id tsb menolak reversal SELURUHNYA
--       (bukan parsial) -- refund approved TIDAK PERNAH dihapus/diubah,
--       saldo customer credit TIDAK PERNAH negatif (kontrak §6 poin 4).
-- Jika customer_credit_amount > 0 DAN kedua pemeriksaan di atas lolos (belum
-- pernah disentuh refund sama sekali), reversal SEKARANG JUGA menulis debit
-- kompensasi customer_credit_ledger (entry_type='reversal', nominal PENUH ==
-- customer_credit_amount -- dijamin penuh karena precondition (b) menjamin
-- belum ada debit apa pun) + audit customer_credit.credit_reversed (kontrak
-- §6 poin 3, §7.1) -- menutup LIMITATION yang dicatat eksplisit di migration
-- Gate 2F.
--
-- DEFERRED (tidak dikerjakan di sini, lihat laporan akhir):
--   UI/dashboard, carry-forward/allocation customer credit ke invoice lain,
--   refund lintas bucket/multi-credit-note, transfer bank/cash otomatis,
--   Telegram/WhatsApp, cloud migration/deploy/push, Gate 2H.2+.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. customer_credit_ledger -- buku besar BARU, append-only, TERPISAH TOTAL
--    dari receivable_ledger. FK ke refund_requests ditambahkan lewat ALTER
--    di bawah (dependency melingkar dengan refund_requests.ledger_entry_id).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.customer_credit_ledger (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  credit_note_id  UUID          NOT NULL REFERENCES public.credit_notes (id) ON DELETE RESTRICT,
  customer_id     UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  entry_type      VARCHAR(20)   NOT NULL CHECK (entry_type IN ('credit_note_origin', 'refund', 'reversal')),
  direction       VARCHAR(10)   NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount          NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  refund_id       UUID,
  created_by      UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (
    (entry_type = 'credit_note_origin' AND direction = 'credit') OR
    (entry_type = 'refund'             AND direction = 'debit')  OR
    (entry_type = 'reversal'           AND direction = 'debit')
  ),
  CHECK ((entry_type = 'refund') = (refund_id IS NOT NULL))
);

-- Invariant struktural "satu credit note hanya satu bucket/origin entry"
-- (kontrak §3 poin 1) -- origin credit tidak dapat dibuat dua kali.
CREATE UNIQUE INDEX uq_customer_credit_ledger_one_origin_per_note
  ON public.customer_credit_ledger (credit_note_id)
  WHERE entry_type = 'credit_note_origin';

-- Idempotency struktural KEDUA -- satu refund_id hanya boleh menghasilkan
-- SATU baris debit, independen dari cek status refund_requests di RPC.
CREATE UNIQUE INDEX uq_customer_credit_ledger_one_debit_per_refund
  ON public.customer_credit_ledger (refund_id)
  WHERE refund_id IS NOT NULL;

CREATE INDEX idx_customer_credit_ledger_credit_note_id ON public.customer_credit_ledger (credit_note_id);
CREATE INDEX idx_customer_credit_ledger_company_id     ON public.customer_credit_ledger (company_id, created_at DESC);

COMMENT ON TABLE public.customer_credit_ledger IS
  'Customer Credit Ledger (Gate 2H) -- append-only, TERPISAH TOTAL dari receivable_ledger (kontrak §5), immutable penuh (trg_customer_credit_ledger_immutable). Setiap baris terikat TEPAT SATU credit_note_id. entry_type=credit_note_origin: kredit awal, nominal == credit_notes.customer_credit_amount, SATU baris per credit_note (uq_customer_credit_ledger_one_origin_per_note), dibuat LAZY (lihat request_refund_atomic/reverse_credit_note_atomic). entry_type=refund: debit dari refund approved, SATU baris per refund_id (uq_customer_credit_ledger_one_debit_per_refund). entry_type=reversal: debit compensating dari perluasan reverse_credit_note_atomic (kontrak §6 poin 3). Saldo SELALU derived: SUM(kredit)-SUM(debit), tidak ada kolom saldo bebas edit.';

-- ---------------------------------------------------------------------------
-- 2. refund_requests -- request header refund. Transisi status TERBATAS
--    (requested -> approved|rejected), pola sama returns (Gate 2F)/
--    order_cancellations (Gate 2G).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.refund_requests (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  credit_note_id    UUID          NOT NULL REFERENCES public.credit_notes (id) ON DELETE RESTRICT,
  customer_id       UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  amount            NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  method            VARCHAR(20)   NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  proof_reference   TEXT          NOT NULL CHECK (length(trim(proof_reference)) > 0),
  transaction_date  DATE          NOT NULL,
  status            VARCHAR(10)   NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected')),
  requested_by      UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  requested_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  decided_by        UUID          REFERENCES public.users (id) ON DELETE RESTRICT,
  decided_at        TIMESTAMPTZ,
  ledger_entry_id   UUID          UNIQUE REFERENCES public.customer_credit_ledger (id) ON DELETE RESTRICT,
  request_payload   JSONB         NOT NULL,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK ((status = 'requested') = (decided_by IS NULL)),
  CHECK ((status = 'requested') = (decided_at IS NULL)),
  CHECK ((status = 'approved') = (ledger_entry_id IS NOT NULL)),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_refund_requests_company_id     ON public.refund_requests (company_id, created_at DESC);
CREATE INDEX idx_refund_requests_credit_note_id ON public.refund_requests (credit_note_id);
CREATE INDEX idx_refund_requests_status         ON public.refund_requests (company_id, status);

COMMENT ON TABLE public.refund_requests IS
  'Refund request header (Gate 2H). status requested->approved|rejected TERBATAS (trg_refund_requests_immutable). credit_note_id WAJIB NOT NULL tunggal -- satu refund hanya memakai satu bucket (kontrak §3 poin 3), tidak ada mekanisme multi-credit-note. ledger_entry_id diisi HANYA saat approved (menunjuk baris debit customer_credit_ledger). customer_id diturunkan server-side dari credit_notes.customer_id, bukan parameter caller yang dipercaya.';

-- FK melingkar customer_credit_ledger.refund_id -> refund_requests(id),
-- ditambahkan setelah kedua tabel ada.
ALTER TABLE public.customer_credit_ledger
  ADD CONSTRAINT fk_customer_credit_ledger_refund_id
  FOREIGN KEY (refund_id) REFERENCES public.refund_requests (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Immutability.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_customer_credit_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_LEDGER_IMMUTABLE: customer_credit_ledger % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'CUSTOMER_CREDIT_LEDGER_IMMUTABLE: customer_credit_ledger % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_customer_credit_ledger_immutable ON public.customer_credit_ledger;
CREATE TRIGGER trg_customer_credit_ledger_immutable
  BEFORE UPDATE OR DELETE ON public.customer_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.prevent_customer_credit_ledger_mutation();

CREATE OR REPLACE FUNCTION public.prevent_refund_request_invalid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'REFUND_REQUEST_IMMUTABLE: refund_request % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.company_id       IS DISTINCT FROM OLD.company_id
     OR NEW.credit_note_id   IS DISTINCT FROM OLD.credit_note_id
     OR NEW.customer_id         IS DISTINCT FROM OLD.customer_id
     OR NEW.amount                  IS DISTINCT FROM OLD.amount
     OR NEW.method                     IS DISTINCT FROM OLD.method
     OR NEW.proof_reference               IS DISTINCT FROM OLD.proof_reference
     OR NEW.transaction_date                 IS DISTINCT FROM OLD.transaction_date
     OR NEW.requested_by                        IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at                           IS DISTINCT FROM OLD.requested_at
     OR NEW.request_payload                           IS DISTINCT FROM OLD.request_payload
     OR NEW.idempotency_key                              IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at                                      IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'REFUND_REQUEST_TERMS_IMMUTABLE: data refund_request % tidak dapat diubah setelah dibuat -- hanya status/decided_by/decided_at/ledger_entry_id yang boleh bertransisi', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'REFUND_ALREADY_RESOLVED: refund_request % sudah berstatus % (final), tidak dapat diputuskan lagi', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'REFUND_INVALID_TRANSITION: transisi status % -> % tidak diizinkan', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'REFUND_DECISION_METADATA_REQUIRED: decided_by/decided_at wajib diisi saat memutuskan refund_request %', OLD.id
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_refund_requests_immutable ON public.refund_requests;
CREATE TRIGGER trg_refund_requests_immutable
  BEFORE UPDATE OR DELETE ON public.refund_requests
  FOR EACH ROW EXECUTE FUNCTION public.prevent_refund_request_invalid_mutation();

-- ---------------------------------------------------------------------------
-- 4. Tenant/consistency validation (BEFORE INSERT) -- lapisan kedua,
--    independen dari kebenaran RPC (pola sama dengan Gate 2A-2G).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_customer_credit_ledger_entry()
RETURNS TRIGGER AS $$
DECLARE
  v_credit_note   public.credit_notes%ROWTYPE;
  v_refund        public.refund_requests%ROWTYPE;
  v_current_bal   NUMERIC(15,2);
BEGIN
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = NEW.credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', NEW.credit_note_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_credit_note.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: credit_note % bukan milik company %', NEW.credit_note_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_credit_note.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_CREDIT_LEDGER_CUSTOMER_MISMATCH: customer_id % harus sama dengan credit_notes.customer_id %', NEW.customer_id, v_credit_note.customer_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.entry_type = 'credit_note_origin' THEN
    IF v_credit_note.customer_credit_amount <= 0 THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_ORIGIN_REQUIRES_POSITIVE_AMOUNT: credit_note % memiliki customer_credit_amount %', NEW.credit_note_id, v_credit_note.customer_credit_amount
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.amount <> v_credit_note.customer_credit_amount THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_ORIGIN_AMOUNT_MISMATCH: amount % harus sama dengan credit_notes.customer_credit_amount %', NEW.amount, v_credit_note.customer_credit_amount
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- Lapis kedua independen dari RPC -- debit (refund/reversal) tidak boleh
  -- melebihi saldo ledger SAAT INI (kontrak §4.4 poin 6).
  IF NEW.entry_type IN ('refund', 'reversal') THEN
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)
    INTO v_current_bal
    FROM public.customer_credit_ledger WHERE credit_note_id = NEW.credit_note_id;
    IF NEW.amount > v_current_bal THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_DEBIT_EXCEEDS_BALANCE: debit % melebihi saldo ledger % pada credit_note %', NEW.amount, v_current_bal, NEW.credit_note_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.entry_type = 'refund' THEN
    SELECT * INTO v_refund FROM public.refund_requests WHERE id = NEW.refund_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REFUND_REQUEST_NOT_FOUND: %', NEW.refund_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_refund.company_id <> NEW.company_id OR v_refund.credit_note_id <> NEW.credit_note_id THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_LEDGER_REFUND_MISMATCH: refund_request % tidak terkait credit_note %', NEW.refund_id, NEW.credit_note_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_refund.amount <> NEW.amount THEN
      RAISE EXCEPTION 'CUSTOMER_CREDIT_LEDGER_REFUND_AMOUNT_MISMATCH: amount % tidak sama dengan refund_requests.amount %', NEW.amount, v_refund.amount
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_customer_credit_ledger_tenant ON public.customer_credit_ledger;
CREATE TRIGGER trg_customer_credit_ledger_tenant
  BEFORE INSERT ON public.customer_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.validate_customer_credit_ledger_entry();

CREATE OR REPLACE FUNCTION public.validate_refund_request_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_credit_note        public.credit_notes%ROWTYPE;
  v_requester_company  UUID;
BEGIN
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = NEW.credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', NEW.credit_note_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_credit_note.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: credit_note % bukan milik company %', NEW.credit_note_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_credit_note.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'REFUND_CUSTOMER_MISMATCH: customer_id harus sama dengan credit_notes.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id INTO v_requester_company FROM public.users WHERE id = NEW.requested_by;
  IF v_requester_company IS NULL THEN
    RAISE EXCEPTION 'REQUESTER_NOT_FOUND: %', NEW.requested_by USING ERRCODE = 'no_data_found';
  END IF;
  IF v_requester_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: requester % bukan milik company %', NEW.requested_by, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_refund_requests_tenant ON public.refund_requests;
CREATE TRIGGER trg_refund_requests_tenant
  BEFORE INSERT ON public.refund_requests
  FOR EACH ROW EXECUTE FUNCTION public.validate_refund_request_tenant();

-- ---------------------------------------------------------------------------
-- 4b. Invariant produksi genuin: maksimal SATU audit event
--     customer_credit.refund_approved per refund_id (entity_id). Mencegah
--     audit trail duplikat untuk keputusan finansial yang sama -- SEKALIGUS
--     titik uji NATURAL untuk membuktikan kegagalan insert audit_logs
--     me-rollback seluruh transaksi approve_refund_atomic (ledger debit +
--     transisi status), lihat integration test.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_refund_approved_dedup
  ON public.audit_logs (entity_id)
  WHERE action = 'customer_credit.refund_approved';

COMMENT ON INDEX public.idx_audit_logs_refund_approved_dedup IS
  'Gate 2H -- maksimal satu audit customer_credit.refund_approved per refund_id (entity_id). Invariant produksi (audit trail tidak boleh duplikat untuk satu keputusan finansial) yang juga menjadi titik uji natural rollback approve_refund_atomic.';

-- ---------------------------------------------------------------------------
-- 5. Derived read model -- saldo ledger dan saldo tersedia per credit note.
--    security_invoker: view berjalan dengan privilege+RLS pemanggil.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.customer_credit_balances
WITH (security_invoker = true) AS
SELECT
  cn.id                     AS credit_note_id,
  cn.company_id             AS company_id,
  cn.customer_id            AS customer_id,
  cn.customer_credit_amount AS customer_credit_amount,
  COALESCE(led.total_credit, 0) AS total_credit,
  COALESCE(led.total_debit, 0)  AS total_debit,
  (COALESCE(led.total_credit, 0) - COALESCE(led.total_debit, 0)) AS ledger_balance,
  COALESCE(pend.total_pending, 0) AS pending_reserved,
  (COALESCE(led.total_credit, 0) - COALESCE(led.total_debit, 0) - COALESCE(pend.total_pending, 0)) AS available_balance
FROM public.credit_notes cn
LEFT JOIN (
  SELECT
    credit_note_id,
    SUM(amount) FILTER (WHERE direction = 'credit') AS total_credit,
    SUM(amount) FILTER (WHERE direction = 'debit')  AS total_debit
  FROM public.customer_credit_ledger
  GROUP BY credit_note_id
) led ON led.credit_note_id = cn.id
LEFT JOIN (
  SELECT credit_note_id, SUM(amount) AS total_pending
  FROM public.refund_requests WHERE status = 'requested'
  GROUP BY credit_note_id
) pend ON pend.credit_note_id = cn.id;

COMMENT ON VIEW public.customer_credit_balances IS
  'Derived read model (Gate 2H kontrak §4.4) -- ledger_balance = SUM(kredit)-SUM(debit) customer_credit_ledger (saldo historis/audit); available_balance = ledger_balance - pending_reserved (refund_requests status=requested, reservation logis). Tidak pernah disimpan sebagai kolom independen. security_invoker=true -- tenant isolation mengikuti RLS credit_notes/customer_credit_ledger/refund_requests milik pemanggil.';

-- ---------------------------------------------------------------------------
-- 6. Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('refund.request', 'refund', 'request', 'Mengajukan refund customer credit dari credit note milik company sendiri -- Owner/Finance'),
  ('refund.approve', 'refund', 'approve', 'Memverifikasi (approve/reject) refund customer credit -- Owner only')
ON CONFLICT (name) DO NOTHING;

-- refund.request LEBIH SEMPIT dari return.request/order_cancellation.request
-- (Gate 2F/2G) -- owner/finance SAJA, BUKAN manager/admin/super_admin/sales
-- (instruksi kontrak eksplisit §4.3, dampak finansial langsung ke kas keluar).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'finance')
  AND p.name = 'refund.request'
ON CONFLICT DO NOTHING;

-- refund.approve: HANYA owner -- pola identik return.verify/credit_note.
-- reverse/order_cancellation.approve (Gate 2F/2G).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name = 'owner'
  AND p.name = 'refund.approve'
ON CONFLICT DO NOTHING;

ALTER TABLE public.customer_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_requests        ENABLE ROW LEVEL SECURITY;

-- SELECT-only, reuse 'receivable.view' (Gate 2A) -- pola sama Gate 2C-2G.
-- Tidak ada policy INSERT/UPDATE/DELETE untuk siapa pun, diperkuat REVOKE
-- eksplisit di bawah.
CREATE POLICY "customer_credit_ledger_select" ON public.customer_credit_ledger
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "refund_requests_select" ON public.refund_requests
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.customer_credit_ledger, public.refund_requests
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_credit_ledger, public.refund_requests TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. RPC canonical -- request_refund_atomic().
--    Satu-satunya jalur resmi mengajukan refund (status=requested). Lazy-
--    create origin credit (jika belum ada dan customer_credit_amount>0),
--    hitung ulang saldo tersedia DI DALAM lock credit_notes (FOR UPDATE),
--    TIDAK PERNAH menyentuh receivable_ledger/invoice/return/credit_note.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_refund_atomic(
  p_company_id        UUID,
  p_actor_id          UUID,
  p_credit_note_id    UUID,
  p_amount            NUMERIC,
  p_method            TEXT,
  p_proof_reference   TEXT,
  p_transaction_date  DATE,
  p_idempotency_key   TEXT DEFAULT NULL
) RETURNS TABLE(
  out_refund_id       UUID,
  out_status          VARCHAR,
  out_already_exists  BOOLEAN
) AS $$
DECLARE
  v_request_payload  JSONB;
  v_existing         public.refund_requests%ROWTYPE;
  v_actor_allowed    BOOLEAN;
  v_credit_note      public.credit_notes%ROWTYPE;
  v_origin_exists    BOOLEAN;
  v_ledger_balance   NUMERIC(15,2);
  v_pending_reserved NUMERIC(15,2);
  v_available        NUMERIC(15,2);
  v_refund_id        UUID;
BEGIN
  -- -------------------------------------------------------------------------
  -- A. Validasi struktural.
  -- -------------------------------------------------------------------------
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_REFUND_AMOUNT: % harus lebih dari 0', p_amount USING ERRCODE = 'check_violation';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'bank_transfer') THEN
    RAISE EXCEPTION 'INVALID_METHOD: %', p_method USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_proof_reference IS NULL OR length(trim(p_proof_reference)) = 0 THEN
    RAISE EXCEPTION 'PROOF_REQUIRED: refund wajib menyertakan proof_reference' USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_transaction_date IS NULL THEN
    RAISE EXCEPTION 'TRANSACTION_DATE_REQUIRED: refund wajib menyertakan transaction_date' USING ERRCODE = 'not_null_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Snapshot request kanonik -- idempotency payload.
  -- -------------------------------------------------------------------------
  v_request_payload := jsonb_build_object(
    'creditNoteId', p_credit_note_id, 'amount', p_amount, 'method', p_method,
    'proofReference', p_proof_reference, 'transactionDate', p_transaction_date
  );

  -- -------------------------------------------------------------------------
  -- C. Idempotency.
  -- -------------------------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.refund_requests
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.request_payload IS DISTINCT FROM v_request_payload THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: idempotency_key % sudah dipakai dengan payload berbeda', p_idempotency_key
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN QUERY SELECT v_existing.id, v_existing.status, TRUE;
      RETURN;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- D. Actor/permission -- owner/finance (LEBIH SEMPIT dari return.request).
  -- -------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'refund.request'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission refund.request pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- E. Lock credit_note -- menyerialisasi request paralel pada bucket sama
  --    (kontrak §4.4 poin 3, pola identik verify_return_atomic mengunci
  --    invoice).
  -- -------------------------------------------------------------------------
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = p_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', p_credit_note_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_credit_note.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: credit_note % bukan milik company %', p_credit_note_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- F. Credit note yang sudah reversed tidak boleh jadi sumber refund
  --    (kontrak §6 poin 1).
  -- -------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.credit_note_reversals WHERE credit_note_id = p_credit_note_id) THEN
    RAISE EXCEPTION 'CREDIT_NOTE_REVERSED: credit_note % sudah direverse, tidak dapat menjadi sumber refund', p_credit_note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- G. Lazy-create origin credit -- HANYA jika belum ada DAN
  --    customer_credit_amount > 0 (kontrak §9).
  -- -------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1 FROM public.customer_credit_ledger WHERE credit_note_id = p_credit_note_id AND entry_type = 'credit_note_origin'
  ) INTO v_origin_exists;
  IF NOT v_origin_exists AND v_credit_note.customer_credit_amount > 0 THEN
    INSERT INTO public.customer_credit_ledger (company_id, credit_note_id, customer_id, entry_type, direction, amount, created_by)
    VALUES (p_company_id, p_credit_note_id, v_credit_note.customer_id, 'credit_note_origin', 'credit', v_credit_note.customer_credit_amount, p_actor_id);
  END IF;

  -- -------------------------------------------------------------------------
  -- H. Hitung ulang saldo tersedia DI DALAM lock (kontrak §4.4 poin 2).
  -- -------------------------------------------------------------------------
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)
  INTO v_ledger_balance
  FROM public.customer_credit_ledger WHERE credit_note_id = p_credit_note_id;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending_reserved
  FROM public.refund_requests WHERE credit_note_id = p_credit_note_id AND status = 'requested';

  v_available := v_ledger_balance - v_pending_reserved;

  IF p_amount > v_available THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_AVAILABLE_BALANCE: amount % melebihi saldo tersedia % pada credit_note %', p_amount, v_available, p_credit_note_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- I. Insert refund_requests.
  -- -------------------------------------------------------------------------
  INSERT INTO public.refund_requests (
    company_id, credit_note_id, customer_id, amount, method, proof_reference, transaction_date, requested_by, request_payload, idempotency_key
  ) VALUES (
    p_company_id, p_credit_note_id, v_credit_note.customer_id, p_amount, p_method, p_proof_reference, p_transaction_date, p_actor_id, v_request_payload, p_idempotency_key
  ) RETURNING id INTO v_refund_id;

  -- -------------------------------------------------------------------------
  -- J. Audit canonical.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'customer_credit.refund_requested', 'refund_requests', v_refund_id,
    jsonb_build_object(
      'refund_id', v_refund_id, 'credit_note_id', p_credit_note_id, 'customer_id', v_credit_note.customer_id,
      'amount', p_amount, 'method', p_method, 'proof_reference', p_proof_reference, 'transaction_date', p_transaction_date,
      'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_refund_id, 'requested'::VARCHAR, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.request_refund_atomic IS
  'Satu-satunya jalur resmi mengajukan refund (status=requested). Atomic: lazy-create origin credit (jika perlu) + refund_requests + audit dalam SATU transaksi. Lock credit_notes FOR UPDATE menyerialisasi request paralel pada bucket sama. Menolak: INVALID_REFUND_AMOUNT, INVALID_METHOD, PROOF_REQUIRED, TRANSACTION_DATE_REQUIRED, IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, FORBIDDEN (permission refund.request, owner/finance), CREDIT_NOTE_NOT_FOUND, TENANT_CONTEXT_MISMATCH, CREDIT_NOTE_REVERSED, REFUND_EXCEEDS_AVAILABLE_BALANCE. TIDAK PERNAH menyentuh receivable_ledger/invoice/sales_order/delivery/payment/return/credit_note. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.request_refund_atomic(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, DATE, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_refund_atomic(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, DATE, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC canonical -- approve_refund_atomic().
--    Owner-only. p_decision IN ('approve','reject'). Reject: status='rejected'
--    TANPA efek ledger apa pun (reservation dilepas). Approve: lock
--    refund_requests + credit_notes, INSERT debit customer_credit_ledger,
--    UPDATE refund_requests (status+ledger_entry_id dalam SATU statement,
--    memenuhi CHECK constraint), INSERT audit -- dalam SATU transaksi.
--    Retry approve pada refund yang SUDAH approved: idempotent, mengembalikan
--    hasil PERTAMA tanpa menulis ledger/audit lagi.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_refund_atomic(
  p_company_id  UUID,
  p_actor_id    UUID,
  p_refund_id   UUID,
  p_decision    TEXT
) RETURNS TABLE(
  out_refund_id        UUID,
  out_status           VARCHAR,
  out_ledger_entry_id  UUID,
  out_amount           NUMERIC,
  out_already_exists   BOOLEAN
) AS $$
DECLARE
  v_actor_allowed  BOOLEAN;
  v_refund         public.refund_requests%ROWTYPE;
  v_credit_note    public.credit_notes%ROWTYPE;
  v_ledger_id      UUID;
BEGIN
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'INVALID_DECISION: %', p_decision USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- -------------------------------------------------------------------------
  -- A. Actor -- Owner-only (instruksi kontrak eksplisit §4.3).
  -- -------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'refund.approve'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission refund.approve pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Lock refund_requests -- menyerialisasi double/concurrent decision
  --    pada refund_id yang SAMA.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_refund FROM public.refund_requests WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REFUND_NOT_FOUND: %', p_refund_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_refund.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: refund % bukan milik company %', p_refund_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- C. Retry approve idempotent STRUKTURAL (kontrak §4.4 poin 5) -- HANYA
  --    approve->approve pada refund yang SUDAH approved. Kombinasi lain pada
  --    status final SELALU ditolak (status final tidak dapat dibuka ulang).
  -- -------------------------------------------------------------------------
  IF v_refund.status = 'approved' THEN
    IF p_decision = 'approve' THEN
      RETURN QUERY SELECT v_refund.id, v_refund.status, v_refund.ledger_entry_id, v_refund.amount, TRUE;
      RETURN;
    END IF;
    RAISE EXCEPTION 'REFUND_ALREADY_RESOLVED: refund % sudah approved, tidak dapat direject', p_refund_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_refund.status <> 'requested' THEN
    RAISE EXCEPTION 'REFUND_ALREADY_RESOLVED: refund % sudah berstatus %', p_refund_id, v_refund.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- D. Reject -- lepaskan reservation, TANPA efek ledger apa pun.
  -- -------------------------------------------------------------------------
  IF p_decision = 'reject' THEN
    UPDATE public.refund_requests SET status = 'rejected', decided_by = p_actor_id, decided_at = NOW() WHERE id = p_refund_id;

    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, old_data, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'customer_credit.refund_rejected', 'refund_requests', p_refund_id,
      jsonb_build_object('status', 'requested'),
      jsonb_build_object('status', 'rejected', 'refund_id', p_refund_id, 'credit_note_id', v_refund.credit_note_id),
      NULL, 'audit', 'finance', 'web', 'success'
    );

    RETURN QUERY SELECT p_refund_id, 'rejected'::VARCHAR, NULL::UUID, NULL::NUMERIC, FALSE;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- E. Approve -- lock credit_note (bucket), reservation menjadi debit final.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = v_refund.credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', v_refund.credit_note_id USING ERRCODE = 'no_data_found';
  END IF;

  -- INSERT ledger SEBELUM UPDATE refund_requests -- jika INSERT gagal (mis.
  -- trigger validate_customer_credit_ledger_entry menolak), UPDATE status di
  -- bawah tidak pernah tereksekusi (tidak ada apa pun untuk dirollback).
  INSERT INTO public.customer_credit_ledger (
    company_id, credit_note_id, customer_id, entry_type, direction, amount, refund_id, created_by
  ) VALUES (
    p_company_id, v_refund.credit_note_id, v_refund.customer_id, 'refund', 'debit', v_refund.amount, p_refund_id, p_actor_id
  ) RETURNING id INTO v_ledger_id;

  -- Status + ledger_entry_id diubah dalam SATU statement (memenuhi CHECK
  -- constraint refund_requests_status_ledger_check tanpa status antara yang
  -- invalid).
  UPDATE public.refund_requests
  SET status = 'approved', decided_by = p_actor_id, decided_at = NOW(), ledger_entry_id = v_ledger_id
  WHERE id = p_refund_id;

  -- -------------------------------------------------------------------------
  -- F. Audit canonical -- jika INSERT ini gagal (mis. constraint audit_logs),
  --    SELURUH transaksi (ledger debit + UPDATE status di atas) rollback --
  --    tidak ada blok EXCEPTION yang menelan kegagalan (kontrak §7.2).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'customer_credit.refund_approved', 'refund_requests', p_refund_id,
    jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', 'approved', 'refund_id', p_refund_id, 'credit_note_id', v_refund.credit_note_id, 'amount', v_refund.amount, 'ledger_entry_id', v_ledger_id),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT p_refund_id, 'approved'::VARCHAR, v_ledger_id, v_refund.amount, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.approve_refund_atomic IS
  'Owner-only. Reject: tandai refund_requests.status=rejected, TANPA efek ledger apa pun (reservation dilepas). Approve: lock refund_requests (serialize -- REFUND_ALREADY_RESOLVED pada kombinasi status-final selain retry approve->approve) + lock credit_notes, INSERT debit customer_credit_ledger, UPDATE status+ledger_entry_id (satu statement), INSERT audit -- dalam SATU transaksi. Retry approve->approve pada refund yang SUDAH approved: idempotent (out_already_exists=TRUE), TIDAK menulis ledger/audit lagi. Menolak: INVALID_DECISION, FORBIDDEN (permission refund.approve, HANYA owner), REFUND_NOT_FOUND, TENANT_CONTEXT_MISMATCH, REFUND_ALREADY_RESOLVED. TIDAK PERNAH menyentuh receivable_ledger/invoice/sales_order/delivery/payment/return/credit_note. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.approve_refund_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_refund_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Perluasan reverse_credit_note_atomic (Gate 2F, migration 20260831000001)
--    -- CREATE OR REPLACE FUNCTION, signature IDENTIK. Seluruh perilaku
--    existing DIPERTAHANKAN PERSIS untuk credit note yang tidak pernah
--    disentuh refund. Dua pemeriksaan BARU (setelah idempotency check,
--    sebelum compensating debit receivable_ledger): PENDING_REFUND_EXISTS
--    dan REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN (kontrak §6 poin 2/4).
--    Jika customer_credit_amount>0 dan kedua pemeriksaan lolos, reversal
--    SEKARANG JUGA menulis debit compensating customer_credit_ledger
--    (entry_type='reversal') + audit customer_credit.credit_reversed
--    (kontrak §6 poin 3, §7.1) -- menutup LIMITATION Gate 2F.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_credit_note_atomic(
  p_company_id      UUID,
  p_actor_id        UUID,
  p_credit_note_id  UUID,
  p_reason          TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE(
  out_reversal_id                    UUID,
  out_credit_note_id                 UUID,
  out_reversed_amount                NUMERIC,
  out_customer_credit_voided_amount  NUMERIC,
  out_already_exists                 BOOLEAN
) AS $$
DECLARE
  v_actor_allowed     BOOLEAN;
  v_credit_note       public.credit_notes%ROWTYPE;
  v_existing          public.credit_note_reversals%ROWTYPE;
  v_invoice           public.invoices%ROWTYPE;
  v_ledger_id         UUID;
  v_reversal_id       UUID;
  v_balance_before    NUMERIC(15,2);
  v_balance_after     NUMERIC(15,2);
  v_cc_origin_exists  BOOLEAN;
  v_cc_ledger_id      UUID;
BEGIN
  -- -------------------------------------------------------------------------
  -- A. Actor -- Owner-only.
  -- -------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'credit_note.reverse'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission credit_note.reverse pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Lock credit_note.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = p_credit_note_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', p_credit_note_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_credit_note.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: credit_note % bukan milik company %', p_credit_note_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- C. Idempotency STRUKTURAL -- credit_note_id UNIQUE pada credit_note_
  --    reversals. Percobaan kedua (dengan/tanpa idempotency_key) SELALU
  --    mengembalikan hasil reversal PERTAMA, tidak pernah menulis lagi.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_existing FROM public.credit_note_reversals WHERE credit_note_id = p_credit_note_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, p_credit_note_id, v_existing.reversed_amount, v_existing.customer_credit_voided_amount, TRUE;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- C2. [Gate 2H] Perluasan kontrak §6 poin 2/4 -- credit note tidak boleh
  --     direverse selama masih ada refund PENDING, dan TIDAK BOLEH direverse
  --     SAMA SEKALI jika sudah pernah ada refund APPROVED (bukan reversal
  --     parsial -- refund approved tidak pernah dihapus/diubah).
  -- -------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.refund_requests WHERE credit_note_id = p_credit_note_id AND status = 'requested') THEN
    RAISE EXCEPTION 'PENDING_REFUND_EXISTS: credit_note % memiliki refund yang masih requested, tidak dapat direverse', p_credit_note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.refund_requests WHERE credit_note_id = p_credit_note_id AND status = 'approved') THEN
    RAISE EXCEPTION 'REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN: credit_note % sudah memiliki refund approved, reversal ditolak seluruhnya', p_credit_note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- D. Compensating debit receivable_ledger -- HANYA jika applied_amount > 0
  --    (kalau tidak, tidak pernah ada ledger credit untuk dibalik). Perilaku
  --    IDENTIK Gate 2F, tidak diubah.
  -- -------------------------------------------------------------------------
  IF v_credit_note.applied_amount > 0 THEN
    SELECT * INTO v_invoice FROM public.invoices WHERE id = v_credit_note.invoice_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', v_credit_note.invoice_id USING ERRCODE = 'no_data_found';
    END IF;

    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO v_balance_before
    FROM public.receivable_ledger WHERE invoice_id = v_invoice.id;
    v_balance_after := v_balance_before + v_credit_note.applied_amount;

    INSERT INTO public.receivable_ledger (company_id, invoice_id, entry_type, direction, amount, created_by)
    VALUES (p_company_id, v_invoice.id, 'credit_note_reversal', 'debit', v_credit_note.applied_amount, p_actor_id)
    RETURNING id INTO v_ledger_id;
  ELSE
    v_ledger_id := NULL;
    v_balance_before := 0;
    v_balance_after := 0;
  END IF;

  INSERT INTO public.credit_note_reversals (
    company_id, credit_note_id, receivable_ledger_id, reversed_amount, customer_credit_voided_amount, actor_id, reason, idempotency_key
  ) VALUES (
    p_company_id, p_credit_note_id, v_ledger_id, v_credit_note.applied_amount, v_credit_note.customer_credit_amount, p_actor_id, p_reason, p_idempotency_key
  ) RETURNING id INTO v_reversal_id;

  -- -------------------------------------------------------------------------
  -- E. [Gate 2H] Compensating debit customer_credit_ledger -- HANYA jika
  --    customer_credit_amount > 0. Precondition C2 di atas menjamin belum
  --    ada refund approved SAMA SEKALI, sehingga saldo ledger SELALU penuh
  --    == customer_credit_amount (tidak pernah parsial, kontrak §6 poin 3).
  --    Lazy-create origin credit dulu jika belum pernah disentuh Gate 2H.
  -- -------------------------------------------------------------------------
  IF v_credit_note.customer_credit_amount > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.customer_credit_ledger WHERE credit_note_id = p_credit_note_id AND entry_type = 'credit_note_origin'
    ) INTO v_cc_origin_exists;
    IF NOT v_cc_origin_exists THEN
      INSERT INTO public.customer_credit_ledger (company_id, credit_note_id, customer_id, entry_type, direction, amount, created_by)
      VALUES (p_company_id, p_credit_note_id, v_credit_note.customer_id, 'credit_note_origin', 'credit', v_credit_note.customer_credit_amount, p_actor_id);
    END IF;

    INSERT INTO public.customer_credit_ledger (company_id, credit_note_id, customer_id, entry_type, direction, amount, created_by)
    VALUES (p_company_id, p_credit_note_id, v_credit_note.customer_id, 'reversal', 'debit', v_credit_note.customer_credit_amount, p_actor_id)
    RETURNING id INTO v_cc_ledger_id;

    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'customer_credit.credit_reversed', 'customer_credit_ledger', v_cc_ledger_id,
      jsonb_build_object(
        'credit_note_id', p_credit_note_id, 'reversal_id', v_reversal_id, 'customer_credit_voided_amount', v_credit_note.customer_credit_amount,
        'ledger_entry_id', v_cc_ledger_id
      ),
      NULL, 'audit', 'finance', 'web', 'success'
    );
  END IF;

  -- -------------------------------------------------------------------------
  -- F. Audit canonical Gate 2F (TIDAK diubah).
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'credit_note.reversed', 'credit_note_reversals', v_reversal_id,
    jsonb_build_object(
      'credit_note_id', p_credit_note_id, 'reversal_id', v_reversal_id, 'reversed_amount', v_credit_note.applied_amount,
      'customer_credit_voided_amount', v_credit_note.customer_credit_amount, 'reason', p_reason
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  IF v_credit_note.applied_amount > 0 THEN
    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'receivable.adjusted', 'receivable_ledger', v_ledger_id,
      jsonb_build_object(
        'invoice_id', v_credit_note.invoice_id, 'entry_type', 'credit_note_reversal', 'amount', v_credit_note.applied_amount,
        'balance_before', v_balance_before, 'balance_after', v_balance_after, 'reversal_reference', v_reversal_id
      ),
      NULL, 'audit', 'finance', 'web', 'success'
    );
  END IF;

  RETURN QUERY SELECT v_reversal_id, p_credit_note_id, v_credit_note.applied_amount, v_credit_note.customer_credit_amount, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.reverse_credit_note_atomic IS
  'Owner-only dan idempotent (credit_note_reversals.credit_note_id UNIQUE -- percobaan kedua SELALU kembalikan hasil pertama). [Gate 2F] TIDAK PERNAH menghapus/mengubah credit_notes/receivable_ledger lama -- compensating debit baru (entry_type=credit_note_reversal) sebesar applied_amount (jika >0). [Gate 2H] Menolak PENDING_REFUND_EXISTS (refund requested aktif) dan REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN (refund approved SUDAH ada -- reversal ditolak SELURUHNYA, bukan parsial). Jika lolos dan customer_credit_amount>0: compensating debit customer_credit_ledger (entry_type=reversal, PENUH) + audit customer_credit.credit_reversed. Menolak juga: FORBIDDEN (permission credit_note.reverse, HANYA owner), CREDIT_NOTE_NOT_FOUND, TENANT_CONTEXT_MISMATCH. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.reverse_credit_note_atomic(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_credit_note_atomic(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;
