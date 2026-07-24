-- =============================================================================
-- Migration: Payment Reconciliation & Exception Handling (Gate 2E)
--
-- Membangun rekonsiliasi CANONICAL antara verified payment (payment_receipts,
-- Gate 2D), payment_allocations, invoice, dan receivable_ledger -- serta
-- proyeksi exception yang dapat masuk human review. Alur gate ini:
--   Verified payment (Gate 2D) -> Reconciliation event (baca ulang fakta DB) ->
--   Exception projection (non-matched, human review)
-- BUKAN:
--   Bank statement/CSV matching, cash custody/handover settlement, payment
--   reversal/refund, retur/credit note, notifikasi -- lihat DEFERRED di bawah.
--
-- Satu tabel baru:
--   1. payment_reconciliations -- event rekonsiliasi, append-only PENUH (tidak
--      ada transisi status seperti promises_to_pay -- setiap "koreksi" adalah
--      baris baru yang menaut previous_reconciliation_id, baris lama tidak
--      pernah berubah).
-- Plus: view read-only payment_reconciliation_exceptions (latest-state
-- projection per payment_receipt_id, non-matched saja, security_invoker).
--
-- Keputusan desain (audit Gate 2A-2D, BUKAN keputusan bisnis baru):
--
--   - "Verified payment" TIDAK diwakili kolom boolean terpisah -- payment_
--     receipts (Gate 2D) HANYA PERNAH berisi pembayaran TERVERIFIKASI (tidak
--     ada tabel "pending payment" lain di codebase ini). Validasi "payment
--     wajib verified" cukup ditegakkan dengan mensyaratkan p_payment_receipt_id
--     merujuk baris NYATA di payment_receipts (PAYMENT_RECEIPT_NOT_FOUND jika
--     tidak) -- tidak ada jalur lain yang bisa "unverified" masuk ke sini.
--
--   - Allocation SELALU diambil dari payment_allocations (Gate 2D) lewat JOIN,
--     TIDAK PERNAH dari parameter payload RPC -- kedua RPC di bawah sengaja
--     TIDAK menerima parameter allocations sama sekali.
--
--   - Locking: RPC mengunci HANYA payment_receipts (FOR UPDATE) -- baris
--     invoices/receivable_ledger/payment_allocations yang terlibat sudah
--     immutable penuh sejak Gate 2A/2D (tidak ada UPDATE yang mungkin
--     mengubahnya), dan payment_allocations untuk SATU payment_receipt_id
--     selalu dibuat SEKALIGUS dalam transaksi record_verified_payment_atomic
--     (Gate 2D) -- tidak pernah bertambah belakangan. Mengunci payment_receipts
--     sudah cukup menyerialisasi seluruh percobaan reconcile/correct pada
--     payment yang sama (idempotency check dijalankan SETELAH lock diperoleh,
--     bukan sebelum seperti Gate 2C/2D -- supaya request kedua yang menunggu
--     lock benar-benar melihat hasil COMMIT request pertama, bukan snapshot
--     sebelum lock, sehingga concurrent identical request tidak menghasilkan
--     event ganda -- lihat test #10).
--
--   - Klasifikasi (matched/partially_matched/unmatched/overpaid/shortpaid)
--     HANYA mengukur PAYMENT RECONCILIATION -- apakah seluruh nilai payment
--     ini sudah dijelaskan/dialokasikan -- BUKAN invoice settlement (apakah
--     invoice sudah lunas). Kedua state ini SENGAJA dipisah (hardening
--     setelah review): invoice_receivable_balances (Gate 2A) TETAP satu-
--     satunya sumber status lunas/outstanding/partially_paid invoice; kolom
--     financial_status pada allocations_snapshot di sini HANYA informational
--     (ditampilkan untuk konteks), TIDAK PERNAH dipakai menentukan
--     classification. Klasifikasi murni fungsi dari
--     total_allocated = SUM(payment_allocations.amount untuk receipt ini)
--     dibandingkan payment_receipts.amount:
--       * matched     -- total_allocated == payment_amount. SATU-SATUNYA
--                        syarat -- TIDAK bergantung pada apakah invoice yang
--                        dialokasikan sudah lunas. Cicilan/partial payment
--                        yang SAH terhadap invoice (invoice tersentuh masih
--                        outstanding/partially_paid) TETAP matched selama
--                        payment itu SENDIRI habis dialokasikan -- exception
--                        projection karenanya TIDAK diisi cicilan sah.
--       * partially_matched -- 0 < total_allocated < payment_amount (ada
--                        sisa payment yang TIDAK dialokasikan ke invoice
--                        mana pun). Mustahil melalui record_verified_
--                        payment_atomic() (ALLOCATION_TOTAL_MISMATCH
--                        mewajibkan SUM(allocations) == amount PERSIS sebelum
--                        INSERT apa pun) -- invariant PROSEDURAL RPC Gate 2D,
--                        bukan constraint tabel, sehingga tetap dihitung
--                        defensif di sini (bukan diasumsikan selalu benar).
--                        Dibuktikan sebagai invariant (test #6a) dengan
--                        mencoba record_verified_payment_atomic() memakai
--                        allocation < amount dan memastikan DITOLAK -- BUKAN
--                        difabrikasi lewat direct-write/backdoor.
--       * unmatched   -- SUM(payment_allocations.amount) untuk receipt = 0.
--                        Mustahil melalui record_verified_payment_atomic()
--                        (ALLOCATION_REQUIRED mewajibkan >=1 allocation dibuat
--                        SEKALIGUS dengan receipt dalam transaksi yang sama) --
--                        dibuktikan sebagai invariant (test #14: payment_
--                        receipts diinsert LANGSUNG tanpa payment_allocations
--                        sama sekali -- legal secara struktural karena tidak
--                        ada constraint tabel yang mewajibkan allocation,
--                        kewajiban itu murni prosedural di dalam RPC -- BUKAN
--                        trigger/kolom test-only). Tetap dihitung defensif
--                        (bukan diasumsikan) karena RPC ini tidak mempercayai
--                        kebenaran RPC lain -- pola sama dengan validate_
--                        receivable_ledger_entry (Gate 2A/2D) yang tetap
--                        memvalidasi ulang independen dari pemanggil.
--       * overpaid    -- total_allocated > payment_amount. Mustahil melalui
--                        record_verified_payment_atomic() (ALLOCATION_TOTAL_
--                        MISMATCH, invariant sama dengan partially_matched di
--                        atas, arah sebaliknya) -- dibuktikan sebagai
--                        invariant (test #6b) dengan mencoba allocation >
--                        amount dan memastikan DITOLAK.
--       * shortpaid   -- DIDEKLARASIKAN di domain CHECK constraint (instruksi
--                        gate eksplisit mewajibkan vocabulary ini) TAPI TIDAK
--                        PERNAH diemit oleh RPC mana pun di gate ini --
--                        "shortpaid" HANYA valid jika ada canonical expected
--                        amount/reference yang DILANGGAR (instruksi gate).
--                        Kandidat referensi semacam itu adalah promises_to_pay.
--                        promised_amount (Gate 2C), TAPI Gate 2D SENGAJA TIDAK
--                        membuat link payment_allocations -> promises_to_pay
--                        ("Link opsional ... SENGAJA TIDAK dibuat di gate ini",
--                        lihat migration 20260829000001) -- tidak ada FK/kolom
--                        yang menghubungkan SATU payment ke SATU promise
--                        tertentu. Menyimpulkan promise mana yang "dimaksud"
--                        payment ini (mis. "promise open terbaru pada invoice
--                        yang sama") adalah TEBAKAN relasi yang tidak ada di
--                        schema -- dilarang eksplisit oleh instruksi gate
--                        ("jangan menebak atau menambah sumber fakta palsu").
--                        LIMITATION ini dilaporkan apa adanya di laporan akhir,
--                        bukan diisi dengan asumsi.
--
--   - Permission 'payment.reconcile' BARU, digrant HANYA ke owner/finance --
--     disamakan dengan containment 'payment.record' (Gate 2D, migration
--     20260829000001) karena rekonsiliasi adalah kelanjutan langsung proses
--     pencatatan payment yang sama, dan instruksi gate tidak menyebut role
--     berbeda. SELECT RLS tetap reuse 'receivable.view' (Gate 2A) mengikuti
--     preseden Gate 2C/2D untuk data read-only domain piutang.
--
--   - Audit: SATU panggilan RPC (reconcile ATAU correct) menghasilkan TEPAT
--     SATU baris audit_logs (instruksi "satu operasi allocation menghasilkan
--     satu audit event" -- di sini "satu operasi" = satu panggilan RPC yang
--     mencakup SELURUH allocation set payment, bukan per-baris allocation).
--     action = 'reconciliation.' || classification untuk run PERTAMA;
--     'reconciliation.corrected' untuk koreksi yang classification-nya
--     BERUBAH dari sebelumnya; 'reconciliation.unmatched_again' untuk koreksi
--     yang classification-nya SAMA dengan sebelumnya DAN bukan 'matched'
--     (menandai exception yang masih persisten setelah re-check, instruksi
--     gate: "bila relevan"). Audit gagal (mis. constraint audit_logs) SELALU
--     merollback SELURUH RPC -- kedua RPC di bawah TIDAK memiliki blok
--     EXCEPTION WHEN sama sekali (pola sama dengan issue_invoice_atomic/Gate
--     2C/2D RPC, dibuktikan test statis).
--
--   - Reconciliation history: append-only PENUH sejak awal -- TIDAK seperti
--     promises_to_pay (Gate 2C) yang butuh transisi status karena promise itu
--     sendiri perlu "ditutup". Reconciliation event di sini tidak punya
--     status yang perlu ditutup -- koreksi CUKUP berupa baris baru yang
--     menaut previous_reconciliation_id, baris lama TIDAK PERNAH disentuh.
--     Trigger immutability karenanya full block (BEFORE UPDATE OR DELETE),
--     sama seperti receivable_ledger (Gate 2A).
--
-- DEFERRED (tidak dikerjakan di sini, lihat laporan akhir):
--   Bank statement/API/CSV matching, cash custody/handover settlement,
--   payment reversal/refund, retur/credit note, inventory/profit adjustment,
--   UI/dashboard, Telegram/WhatsApp/n8n, notification/escalation, AI scoring,
--   link payment_allocations<->promises_to_pay (dan karenanya klasifikasi
--   shortpaid yang benar-benar dapat dibuktikan).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. payment_reconciliations -- event rekonsiliasi, append-only PENUH.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_reconciliations (
  id                          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  payment_receipt_id          UUID          NOT NULL REFERENCES public.payment_receipts (id) ON DELETE RESTRICT,
  customer_id                 UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  classification              VARCHAR(20)   NOT NULL CHECK (classification IN ('matched', 'partially_matched', 'unmatched', 'overpaid', 'shortpaid')),
  payment_amount               NUMERIC(15,2) NOT NULL CHECK (payment_amount > 0),
  total_allocated               NUMERIC(15,2) NOT NULL CHECK (total_allocated >= 0),
  unallocated_amount            NUMERIC(15,2) NOT NULL,
  allocations_snapshot           JSONB         NOT NULL,
  method                          VARCHAR(10)   NOT NULL CHECK (method IN ('manual', 'automatic')),
  actor_id                        UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  previous_reconciliation_id       UUID          REFERENCES public.payment_reconciliations (id) ON DELETE RESTRICT,
  reason                            TEXT          CHECK (reason IS NULL OR length(reason) <= 1000),
  idempotency_key                   TEXT,
  created_at                        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (previous_reconciliation_id IS NULL OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_payment_reconciliations_company_id ON public.payment_reconciliations (company_id, created_at DESC);
CREATE INDEX idx_payment_reconciliations_receipt_id ON public.payment_reconciliations (payment_receipt_id, created_at DESC);
CREATE INDEX idx_payment_reconciliations_previous    ON public.payment_reconciliations (previous_reconciliation_id);

COMMENT ON TABLE public.payment_reconciliations IS
  'Event rekonsiliasi verified payment (Gate 2D) terhadap payment_allocations/invoice/receivable_ledger. Append-only PENUH (trg_payment_reconciliations_immutable) -- TIDAK ADA transisi status seperti promises_to_pay, koreksi selalu baris baru (previous_reconciliation_id). Bukan financial ledger -- tidak pernah dipakai menghitung saldo (lihat invoice_receivable_balances, Gate 2A, untuk saldo canonical).';
COMMENT ON COLUMN public.payment_reconciliations.classification IS
  'Mengukur PAYMENT RECONCILIATION SAJA (total_allocated vs payment_amount) -- BUKAN invoice settlement. matched = total_allocated == payment_amount (independen dari status lunas invoice; cicilan sah TETAP matched). partially_matched/unmatched/overpaid mustahil via record_verified_payment_atomic (ALLOCATION_TOTAL_MISMATCH/ALLOCATION_REQUIRED, Gate 2D) tapi tetap dihitung defensif. shortpaid ADA di domain (instruksi gate) tapi TIDAK PERNAH diemit -- tidak ada canonical expected-amount/reference yang menaut SATU payment ke SATU promises_to_pay di schema existing (lihat catatan migration di atas + laporan akhir).';
COMMENT ON COLUMN public.payment_reconciliations.allocations_snapshot IS
  'Snapshot allocations DIAMBIL DARI DB (payment_allocations JOIN invoices JOIN invoice_receivable_balances), bukan dari payload caller -- array JSONB terurut stabil ORDER BY invoice_id ASC: [{invoiceId, allocatedAmount, financialStatus}, ...]. financialStatus di sini HANYA informational (status invoice saat itu) -- TIDAK PERNAH dipakai menentukan classification.';

-- ---------------------------------------------------------------------------
-- 2. Immutability -- full block, tidak ada UPDATE/DELETE sama sekali (pola
--    sama dengan receivable_ledger, Gate 2A -- BUKAN promises_to_pay yang
--    masih mengizinkan transisi status terbatas).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_payment_reconciliation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RECONCILIATION_APPEND_ONLY: reconciliation % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'RECONCILIATION_APPEND_ONLY: reconciliation % tidak dapat diubah -- koreksi wajib berupa event baru', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_reconciliations_immutable ON public.payment_reconciliations;
CREATE TRIGGER trg_payment_reconciliations_immutable
  BEFORE UPDATE OR DELETE ON public.payment_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_reconciliation_mutation();

-- ---------------------------------------------------------------------------
-- 3. Tenant/consistency validation (BEFORE INSERT) -- lapisan kedua,
--    independen dari kebenaran RPC (pola sama dengan validate_invoice_tenant,
--    Gate 2A / validate_payment_allocation_tenant, Gate 2D).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_payment_reconciliation_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_receipt_company_id  UUID;
  v_receipt_customer_id UUID;
  v_actor_company_id    UUID;
  v_prev                public.payment_reconciliations%ROWTYPE;
BEGIN
  SELECT company_id, customer_id INTO v_receipt_company_id, v_receipt_customer_id
  FROM public.payment_receipts WHERE id = NEW.payment_receipt_id;
  IF v_receipt_company_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND: %', NEW.payment_receipt_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_receipt_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: payment_receipt % bukan milik company %', NEW.payment_receipt_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_receipt_customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: customer_id harus sama dengan payment_receipts.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id INTO v_actor_company_id FROM public.users WHERE id = NEW.actor_id;
  IF v_actor_company_id IS NULL THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND: %', NEW.actor_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_actor_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: actor % bukan milik company %', NEW.actor_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.previous_reconciliation_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.payment_reconciliations WHERE id = NEW.previous_reconciliation_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PREVIOUS_RECONCILIATION_NOT_FOUND: %', NEW.previous_reconciliation_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_prev.company_id <> NEW.company_id OR v_prev.payment_receipt_id <> NEW.payment_receipt_id THEN
      RAISE EXCEPTION 'PREVIOUS_RECONCILIATION_MISMATCH: previous_reconciliation % tidak terkait payment_receipt %', NEW.previous_reconciliation_id, NEW.payment_receipt_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_reconciliations_tenant ON public.payment_reconciliations;
CREATE TRIGGER trg_payment_reconciliations_tenant
  BEFORE INSERT ON public.payment_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.validate_payment_reconciliation_tenant();

-- ---------------------------------------------------------------------------
-- 4. Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('payment.reconcile', 'payment', 'reconcile', 'Menjalankan/mengoreksi rekonsiliasi verified payment terhadap invoice/receivable_ledger milik company sendiri')
ON CONFLICT (name) DO NOTHING;

-- HANYA owner/finance -- disamakan dengan containment 'payment.record'
-- (Gate 2D) karena rekonsiliasi adalah kelanjutan langsung proses pencatatan
-- payment yang sama; instruksi gate tidak menyebut role berbeda.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'finance')
  AND p.name = 'payment.reconcile'
ON CONFLICT DO NOTHING;

ALTER TABLE public.payment_reconciliations ENABLE ROW LEVEL SECURITY;

-- SELECT-only, reuse permission 'receivable.view' (Gate 2A) -- pola sama
-- dengan Gate 2C/2D. Tidak ada policy INSERT/UPDATE/DELETE untuk siapa pun,
-- diperkuat REVOKE eksplisit di bawah.
CREATE POLICY "payment_reconciliations_select" ON public.payment_reconciliations
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payment_reconciliations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_reconciliations TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Exception projection -- latest-state per payment_receipt_id, non-matched
--    saja. BUKAN financial ledger, BUKAN source of truth saldo (lihat
--    invoice_receivable_balances, Gate 2A, untuk saldo canonical).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.payment_reconciliation_exceptions
WITH (security_invoker = true) AS
SELECT latest.*
FROM (
  SELECT DISTINCT ON (pr.payment_receipt_id) pr.*
  FROM public.payment_reconciliations pr
  ORDER BY pr.payment_receipt_id, pr.created_at DESC
) latest
WHERE latest.classification <> 'matched';

COMMENT ON VIEW public.payment_reconciliation_exceptions IS
  'Latest-state projection (DISTINCT ON payment_receipt_id, event TERBARU) yang classification-nya BUKAN matched -- antrian human review. BUKAN financial ledger dan TIDAK BOLEH dipakai menghitung saldo (lihat invoice_receivable_balances, Gate 2A). security_invoker=true -- tenant isolation mengikuti RLS payment_reconciliations milik pemanggil.';

GRANT SELECT ON public.payment_reconciliation_exceptions TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC canonical -- reconcile_verified_payment().
--    Rekonsiliasi PERTAMA (atau independen) untuk SATU payment_receipt.
--    Allocation SELALU diambil dari DB (payment_allocations), TIDAK PERNAH
--    dari parameter -- fungsi ini sengaja tidak menerima parameter allocations
--    sama sekali. previous_reconciliation_id/reason SELALU NULL di sini
--    (koreksi lewat correct_payment_reconciliation di bawah).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_verified_payment(
  p_company_id          UUID,
  p_actor_id            UUID,
  p_payment_receipt_id  UUID,
  p_method              TEXT DEFAULT 'automatic',
  p_idempotency_key     TEXT DEFAULT NULL
) RETURNS TABLE(
  out_reconciliation_id   UUID,
  out_classification      VARCHAR,
  out_total_allocated     NUMERIC,
  out_unallocated_amount  NUMERIC,
  out_allocations         JSONB,
  out_already_exists      BOOLEAN
) AS $$
DECLARE
  v_payment              public.payment_receipts%ROWTYPE;
  v_existing              public.payment_reconciliations%ROWTYPE;
  v_actor_allowed         BOOLEAN;
  v_total_allocated       NUMERIC(15,2);
  v_unallocated           NUMERIC(15,2);
  v_classification        VARCHAR(20);
  v_allocations_snapshot  JSONB := '[]'::jsonb;
  v_alloc_row             RECORD;
  v_reconciliation_id     UUID;
BEGIN
  IF p_method NOT IN ('manual', 'automatic') THEN
    RAISE EXCEPTION 'INVALID_METHOD: %', p_method USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock payment_receipts -- satu-satunya entitas payment (SELALU verified by
  -- construction, Gate 2D). Dikunci SEBELUM idempotency check supaya request
  -- concurrent kedua (menunggu lock) melihat hasil COMMIT request pertama.
  SELECT * INTO v_payment FROM public.payment_receipts WHERE id = p_payment_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND: %', p_payment_receipt_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_payment.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: payment_receipt % bukan milik company %', p_payment_receipt_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payment_reconciliations
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing.payment_receipt_id <> p_payment_receipt_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYMENT_MISMATCH: idempotency_key % sudah dipakai untuk payment_receipt lain', p_idempotency_key
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN QUERY SELECT v_existing.id, v_existing.classification, v_existing.total_allocated, v_existing.unallocated_amount, v_existing.allocations_snapshot, TRUE;
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
      AND perm.name = 'payment.reconcile'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.reconcile pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Derive allocations dari DB (payment_allocations), TERURUT DETERMINISTIC
  -- (invoice_id ASC) -- bukan dari payload caller.
  v_total_allocated := 0;
  FOR v_alloc_row IN
    SELECT pa.invoice_id, pa.amount, i.company_id AS invoice_company_id, i.customer_id AS invoice_customer_id,
           rl.company_id AS ledger_company_id, b.financial_status
    FROM public.payment_allocations pa
    JOIN public.invoices i ON i.id = pa.invoice_id
    JOIN public.receivable_ledger rl ON rl.id = pa.receivable_ledger_id
    JOIN public.invoice_receivable_balances b ON b.invoice_id = pa.invoice_id
    WHERE pa.payment_receipt_id = p_payment_receipt_id
    ORDER BY pa.invoice_id ASC
  LOOP
    IF v_alloc_row.invoice_company_id <> p_company_id OR v_alloc_row.ledger_company_id <> p_company_id THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: allocation invoice/ledger % bukan milik company %', v_alloc_row.invoice_id, p_company_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_alloc_row.invoice_customer_id <> v_payment.customer_id THEN
      RAISE EXCEPTION 'INVOICE_CUSTOMER_MISMATCH: invoice % bukan milik customer % pada payment_receipt %', v_alloc_row.invoice_id, v_payment.customer_id, p_payment_receipt_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_total_allocated := v_total_allocated + v_alloc_row.amount;

    -- financial_status HANYA disimpan di snapshot untuk konteks informational
    -- (status invoice saat itu) -- TIDAK PERNAH dipakai menentukan
    -- classification. Payment reconciliation dan invoice settlement adalah
    -- dua state berbeda (lihat catatan desain di atas) -- cicilan sah yang
    -- payment-nya fully allocated TETAP matched walau invoice masih
    -- outstanding/partially_paid.
    v_allocations_snapshot := v_allocations_snapshot || jsonb_build_array(jsonb_build_object(
      'invoiceId', v_alloc_row.invoice_id, 'allocatedAmount', v_alloc_row.amount, 'financialStatus', v_alloc_row.financial_status
    ));
  END LOOP;

  v_unallocated := v_payment.amount - v_total_allocated;

  -- Klasifikasi MURNI dari total_allocated vs payment_amount -- tidak pernah
  -- membaca financial_status invoice. matched TIDAK mensyaratkan invoice
  -- lunas, hanya mensyaratkan payment ini habis dialokasikan.
  IF v_total_allocated = 0 THEN
    v_classification := 'unmatched';
  ELSIF v_total_allocated > v_payment.amount THEN
    v_classification := 'overpaid';
  ELSIF v_total_allocated < v_payment.amount THEN
    v_classification := 'partially_matched';
  ELSE
    v_classification := 'matched';
  END IF;

  INSERT INTO public.payment_reconciliations (
    company_id, payment_receipt_id, customer_id, classification, payment_amount, total_allocated, unallocated_amount,
    allocations_snapshot, method, actor_id, idempotency_key
  ) VALUES (
    p_company_id, p_payment_receipt_id, v_payment.customer_id, v_classification, v_payment.amount, v_total_allocated, v_unallocated,
    v_allocations_snapshot, p_method, p_actor_id, p_idempotency_key
  ) RETURNING id INTO v_reconciliation_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'reconciliation.' || v_classification, 'payment_reconciliations', v_reconciliation_id,
    jsonb_build_object(
      'payment_id', p_payment_receipt_id, 'payment_amount', v_payment.amount, 'allocations', v_allocations_snapshot,
      'total_allocated', v_total_allocated, 'unallocated_amount', v_unallocated, 'classification', v_classification,
      'method', p_method, 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_reconciliation_id, v_classification, v_total_allocated, v_unallocated, v_allocations_snapshot, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.reconcile_verified_payment IS
  'Rekonsiliasi PERTAMA/independen untuk SATU payment_receipt. Allocation SELALU diderivasi dari payment_allocations (JOIN, ORDER BY invoice_id ASC) -- fungsi ini TIDAK menerima parameter allocations. Mengunci payment_receipts FOR UPDATE sebelum idempotency check (menyerialisasi concurrent request). Klasifikasi mengukur PAYMENT RECONCILIATION SAJA (total_allocated vs payment_amount), BUKAN invoice settlement: matched (total_allocated==amount, independen dari status lunas invoice -- cicilan sah TETAP matched); partially_matched (0<total_allocated<amount)/unmatched (total_allocated=0)/overpaid (total_allocated>amount) -- ketiganya defensif, mustahil via record_verified_payment_atomic (ALLOCATION_TOTAL_MISMATCH/ALLOCATION_REQUIRED). shortpaid tidak pernah diemit (lihat komentar migration). Menulis payment_reconciliations + audit dalam SATU transaksi, TIDAK PERNAH mengubah payment/allocation/invoice/ledger/sales_orders. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.reconcile_verified_payment(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_verified_payment(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC canonical -- correct_payment_reconciliation().
--    Re-derive rekonsiliasi untuk payment_receipt yang SAMA dengan reconciliation
--    lama, menghasilkan baris BARU (previous_reconciliation_id) -- baris lama
--    TIDAK PERNAH disentuh (append-only, tidak ada UPDATE sama sekali).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.correct_payment_reconciliation(
  p_company_id          UUID,
  p_actor_id            UUID,
  p_reconciliation_id   UUID,
  p_reason              TEXT,
  p_idempotency_key     TEXT DEFAULT NULL
) RETURNS TABLE(
  out_reconciliation_id           UUID,
  out_previous_reconciliation_id  UUID,
  out_classification              VARCHAR,
  out_total_allocated             NUMERIC,
  out_unallocated_amount          NUMERIC,
  out_allocations                 JSONB,
  out_already_exists              BOOLEAN
) AS $$
DECLARE
  v_old                   public.payment_reconciliations%ROWTYPE;
  v_payment                public.payment_receipts%ROWTYPE;
  v_existing                public.payment_reconciliations%ROWTYPE;
  v_actor_allowed            BOOLEAN;
  v_total_allocated           NUMERIC(15,2);
  v_unallocated                NUMERIC(15,2);
  v_classification              VARCHAR(20);
  v_allocations_snapshot         JSONB := '[]'::jsonb;
  v_alloc_row                     RECORD;
  v_reconciliation_id              UUID;
  v_audit_action                    TEXT;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: koreksi rekonsiliasi wajib menyertakan reason' USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT * INTO v_old FROM public.payment_reconciliations WHERE id = p_reconciliation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECONCILIATION_NOT_FOUND: %', p_reconciliation_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_old.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: reconciliation % bukan milik company %', p_reconciliation_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Lock payment_receipts (parent) -- menyerialisasi koreksi/rekonsiliasi
  -- lain terhadap payment yang sama, dan memastikan request concurrent kedua
  -- melihat hasil COMMIT request pertama.
  SELECT * INTO v_payment FROM public.payment_receipts WHERE id = v_old.payment_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND: %', v_old.payment_receipt_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payment_reconciliations
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key AND previous_reconciliation_id = p_reconciliation_id;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing.id, p_reconciliation_id, v_existing.classification, v_existing.total_allocated, v_existing.unallocated_amount, v_existing.allocations_snapshot, TRUE;
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
      AND perm.name = 'payment.reconcile'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.reconcile pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Re-derive dari DB SAAT INI (pola sama dengan reconcile_verified_payment).
  v_total_allocated := 0;
  FOR v_alloc_row IN
    SELECT pa.invoice_id, pa.amount, i.company_id AS invoice_company_id, i.customer_id AS invoice_customer_id,
           rl.company_id AS ledger_company_id, b.financial_status
    FROM public.payment_allocations pa
    JOIN public.invoices i ON i.id = pa.invoice_id
    JOIN public.receivable_ledger rl ON rl.id = pa.receivable_ledger_id
    JOIN public.invoice_receivable_balances b ON b.invoice_id = pa.invoice_id
    WHERE pa.payment_receipt_id = v_old.payment_receipt_id
    ORDER BY pa.invoice_id ASC
  LOOP
    IF v_alloc_row.invoice_company_id <> p_company_id OR v_alloc_row.ledger_company_id <> p_company_id THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: allocation invoice/ledger % bukan milik company %', v_alloc_row.invoice_id, p_company_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_alloc_row.invoice_customer_id <> v_payment.customer_id THEN
      RAISE EXCEPTION 'INVOICE_CUSTOMER_MISMATCH: invoice % bukan milik customer % pada payment_receipt %', v_alloc_row.invoice_id, v_payment.customer_id, v_old.payment_receipt_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_total_allocated := v_total_allocated + v_alloc_row.amount;

    -- financial_status HANYA disimpan di snapshot untuk konteks informational
    -- (status invoice saat itu) -- TIDAK PERNAH dipakai menentukan
    -- classification. Payment reconciliation dan invoice settlement adalah
    -- dua state berbeda (lihat catatan desain di atas) -- cicilan sah yang
    -- payment-nya fully allocated TETAP matched walau invoice masih
    -- outstanding/partially_paid.
    v_allocations_snapshot := v_allocations_snapshot || jsonb_build_array(jsonb_build_object(
      'invoiceId', v_alloc_row.invoice_id, 'allocatedAmount', v_alloc_row.amount, 'financialStatus', v_alloc_row.financial_status
    ));
  END LOOP;

  v_unallocated := v_payment.amount - v_total_allocated;

  -- Klasifikasi MURNI dari total_allocated vs payment_amount -- tidak pernah
  -- membaca financial_status invoice. matched TIDAK mensyaratkan invoice
  -- lunas, hanya mensyaratkan payment ini habis dialokasikan.
  IF v_total_allocated = 0 THEN
    v_classification := 'unmatched';
  ELSIF v_total_allocated > v_payment.amount THEN
    v_classification := 'overpaid';
  ELSIF v_total_allocated < v_payment.amount THEN
    v_classification := 'partially_matched';
  ELSE
    v_classification := 'matched';
  END IF;

  INSERT INTO public.payment_reconciliations (
    company_id, payment_receipt_id, customer_id, classification, payment_amount, total_allocated, unallocated_amount,
    allocations_snapshot, method, actor_id, previous_reconciliation_id, reason, idempotency_key
  ) VALUES (
    p_company_id, v_old.payment_receipt_id, v_payment.customer_id, v_classification, v_payment.amount, v_total_allocated, v_unallocated,
    v_allocations_snapshot, 'manual', p_actor_id, p_reconciliation_id, p_reason, p_idempotency_key
  ) RETURNING id INTO v_reconciliation_id;

  IF v_classification = v_old.classification AND v_classification <> 'matched' THEN
    v_audit_action := 'reconciliation.unmatched_again';
  ELSE
    v_audit_action := 'reconciliation.corrected';
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, v_audit_action, 'payment_reconciliations', v_reconciliation_id,
    jsonb_build_object(
      'reconciliation_id', p_reconciliation_id, 'classification', v_old.classification,
      'total_allocated', v_old.total_allocated, 'unallocated_amount', v_old.unallocated_amount,
      'allocations', v_old.allocations_snapshot
    ),
    jsonb_build_object(
      'payment_id', v_old.payment_receipt_id, 'payment_amount', v_payment.amount, 'allocations', v_allocations_snapshot,
      'total_allocated', v_total_allocated, 'unallocated_amount', v_unallocated, 'classification', v_classification,
      'previous_reconciliation_id', p_reconciliation_id, 'reconciliation_id', v_reconciliation_id,
      'method', 'manual', 'reason', p_reason, 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_reconciliation_id, p_reconciliation_id, v_classification, v_total_allocated, v_unallocated, v_allocations_snapshot, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.correct_payment_reconciliation IS
  'Koreksi/re-check rekonsiliasi: re-derive allocation dari DB SAAT INI (definisi klasifikasi SAMA PERSIS dengan reconcile_verified_payment -- payment reconciliation saja, bukan invoice settlement) untuk payment_receipt yang sama dengan reconciliation lama, menulis baris BARU (previous_reconciliation_id, method=manual, reason wajib) -- baris lama TIDAK PERNAH diubah (append-only penuh, tidak ada UPDATE). Karena payment_allocations immutable (Gate 2D), total_allocated payment yang sama TIDAK PERNAH berubah antar correction -- classification suatu payment yang benar akan tetap konsisten selamanya; correction karenanya berguna sebagai override manual beralasan atau re-assert exception yang masih persisten (bukan untuk mengejar drift status invoice). audit action = reconciliation.unmatched_again jika classification SAMA dengan sebelumnya dan bukan matched (exception masih persisten); reconciliation.corrected untuk kasus lain. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.correct_payment_reconciliation(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_payment_reconciliation(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;
