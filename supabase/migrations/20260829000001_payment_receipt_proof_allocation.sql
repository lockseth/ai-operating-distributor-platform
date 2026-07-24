-- =============================================================================
-- Migration: Payment Receipt, Proof, and Allocation (Gate 2D)
--
-- Menutup segmen Invoice -> Collection -> Payment dengan jalur canonical untuk
-- mencatat pembayaran TERVERIFIKASI (cash/bank_transfer), menyimpan metadata
-- bukti pembayaran, mengalokasikannya ke satu atau beberapa invoice milik
-- customer yang sama, dan mencatat kredit pada receivable_ledger. Status
-- partially_paid/paid TETAP derived (invoice_receivable_balances, Gate 2A) --
-- tidak ada kolom status baru di sini.
--
-- Alur gate ini:
--   Invoice canonical -> Payment receipt (verified) -> Allocation -> Ledger credit
-- BUKAN:
--   Collection claim (Gate 2C) -> Ledger credit (klaim TIDAK PERNAH menyentuh ledger)
--   Promise to pay (Gate 2C) -> fulfilled otomatis (TIDAK dikerjakan di sini)
--
-- Tiga tabel baru:
--   1. payment_receipts    -- pembayaran terverifikasi, immutable penuh.
--   2. payment_proofs      -- metadata/object reference bukti, immutable, >=1 per receipt.
--   3. payment_allocations -- alokasi payment ke invoice, 1:1 dengan receivable_ledger credit.
-- Plus: ALTER receivable_ledger.entry_type -> tambah 'payment_allocation'
-- (forward-only, lihat section 0).
--
-- Keputusan desain (audit existing Gate 2A/2B/2C, BUKAN keputusan bisnis baru):
--   - customer_id payment_receipts TIDAK diterima dari client sebagai parameter
--     terpisah -- diturunkan server-side dari invoice PERTAMA (urutan terkunci
--     ascending) pada p_allocations, lalu SETIAP invoice lain dalam payment yang
--     sama divalidasi harus customer_id SAMA (INVOICE_CUSTOMER_MISMATCH). Pola
--     ini menghindari kelas error baru "customer_id parameter vs invoice
--     customer_id" yang tidak ada gunanya -- identik semangat dengan
--     issue_invoice_atomic yang menurunkan customer_id dari order, bukan
--     menerimanya dari caller.
--   - Locking: seluruh invoice yang terlibat DIKUNCI (FOR UPDATE) dalam urutan
--     ASCENDING id SEBELUM tulis apa pun -- mencegah deadlock antar payment
--     concurrent yang overlap invoice set, pola sama dengan issue_invoice_atomic
--     mengunci sales_orders lalu deliveries secara berurutan. Outstanding
--     balance dihitung ulang dari receivable_ledger DI DALAM lock ini (bukan
--     dari view invoice_receivable_balances yang bisa jadi snapshot lama) --
--     valid karena RPC ini adalah SATU-SATUNYA jalur credit dan SELALU
--     mengunci invoices FOR UPDATE dahulu sebelum menulis credit, sehingga dua
--     percobaan alokasi ke invoice yang sama otomatis terserialisasi.
--   - Idempotency: mengikuti pola UNIQUE(company_id, idempotency_key) Gate 2C,
--     DIPERKUAT dengan perbandingan payload eksplisit (request_payload JSONB
--     kanonik, urutan proofs/allocations dinormalisasi) -- retry dengan key
--     sama TAPI payload berbeda DITOLAK (IDEMPOTENCY_KEY_PAYLOAD_MISMATCH).
--     Gate 2C TIDAK melakukan ini (retry hanya dicocokkan by key, payload tidak
--     dibandingkan) karena instruksi Gate 2C tidak mensyaratkannya secara
--     eksplisit -- instruksi Gate 2D secara eksplisit mensyaratkan ini
--     ("idempotency key dengan payload berbeda harus ditolak"), jadi Gate 2D
--     mengimplementasikan lapisan pembanding payload yang tidak ada di gate
--     sebelumnya, tanpa mengubah pola Gate 2C itu sendiri.
--   - Role permission 'payment.record': HANYA owner/finance (BUKAN
--     manager/admin/super_admin seperti izin finance lain di Gate 2A/2B/2C) --
--     instruksi gate eksplisit menyebut "role Owner/Finance", lebih sempit dari
--     preseden containment gate-gate sebelumnya. Diikuti literal karena
--     instruksi eksplisit, bukan asumsi.
--   - payment_proofs hanya menyimpan proof_type (TEXT bebas, tidak di-enum --
--     instruksi gate tidak mendefinisikan vocabulary tetap) + object_reference
--     (pointer ke storage, BUKAN binary) + metadata JSONB bebas. Kardinalitas
--     "minimal satu bukti per payment" ditegakkan RPC (SATU-SATUNYA jalur
--     resmi, direct insert diblokir), BUKAN oleh constraint tabel struktural
--     (tidak ada cara murni deklaratif untuk constraint "minimal 1 baris
--     terkait" tanpa trigger AFTER yang rapuh terhadap urutan statement dalam
--     transaksi yang sama).
--   - Link opsional ke collection_activities/promises_to_pay (disebutkan
--     instruksi sebagai "boleh optional") SENGAJA TIDAK dibuat di gate ini --
--     tidak ada kebutuhan konkret yang diinstruksikan, dan menambah kolom
--     tanpa keperluan jelas melanggar prinsip minimal-scope. promises_to_pay
--     TIDAK PERNAH ditandai fulfilled oleh RPC ini (sesuai larangan eksplisit).
--   - received_at SELALU NOW() server-side, TIDAK menerima timestamp client --
--     pola sama persis dengan seluruh writer canonical lain di repo ini
--     (occurred_at collection_activities, dsb).
--
-- DEFERRED (tidak dikerjakan di sini, lihat laporan akhir):
--   Reconciliation bank statement, payment exception, reversal/refund, retur/
--   credit note, cash handover/custody settlement, notifikasi, UI/upload flow.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Perluasan receivable_ledger.entry_type -> tambah 'payment_allocation'.
--    Constraint domain asli (Gate 2A, migration 20260826000001) hanya
--    mengizinkan 'invoice_issued'. DROP dicari via introspeksi definisi
--    (bukan nama hardcoded) supaya tidak bergantung pada penamaan constraint
--    otomatis Postgres yang bisa berbeda antar versi/instalasi.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  -- Constraint domain entry_type murni (tanpa menyebut direction).
  FOR v_conname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.receivable_ledger'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%entry_type%invoice_issued%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%direction%'
  LOOP
    EXECUTE format('ALTER TABLE public.receivable_ledger DROP CONSTRAINT %I', v_conname);
  END LOOP;

  -- Constraint gabungan entry_type+direction (CHECK (entry_type <> 'invoice_issued' OR direction = 'debit')).
  FOR v_conname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.receivable_ledger'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%entry_type%'
      AND pg_get_constraintdef(oid) ILIKE '%direction%'
  LOOP
    EXECUTE format('ALTER TABLE public.receivable_ledger DROP CONSTRAINT %I', v_conname);
  END LOOP;
END $$;

ALTER TABLE public.receivable_ledger
  ADD CONSTRAINT receivable_ledger_entry_type_check
  CHECK (entry_type IN ('invoice_issued', 'payment_allocation'));

-- Menggantikan CHECK lama (entry_type=invoice_issued => direction=debit)
-- dengan pemetaan EXHAUSTIVE atas kedua entry_type yang dikenal -- entry_type
-- baru mana pun WAJIB memperluas constraint ini secara eksplisit (forward-only
-- by construction, mencegah entry_type baru lolos tanpa keputusan direction).
ALTER TABLE public.receivable_ledger
  ADD CONSTRAINT receivable_ledger_entry_direction_check
  CHECK (
    (entry_type = 'invoice_issued'     AND direction = 'debit') OR
    (entry_type = 'payment_allocation' AND direction = 'credit')
  );

COMMENT ON COLUMN public.receivable_ledger.entry_type IS
  'invoice_issued (debit, Gate 2A/2B) atau payment_allocation (credit, Gate 2D) -- lihat receivable_ledger_entry_direction_check untuk pemetaan wajib entry_type->direction.';

-- Lapisan kedua defense-in-depth: validate_receivable_ledger_entry() (Gate 2A)
-- diperluas untuk entry_type=payment_allocation -- credit tidak boleh melebihi
-- outstanding balance SAAT INI (dihitung ulang dari receivable_ledger,
-- independen dari kebenaran record_verified_payment_atomic()).
CREATE OR REPLACE FUNCTION public.validate_receivable_ledger_entry()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice          public.invoices%ROWTYPE;
  v_current_balance  NUMERIC(15,2);
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.entry_type = 'invoice_issued' AND NEW.amount <> v_invoice.total_amount THEN
    RAISE EXCEPTION 'RECEIVABLE_LEDGER_OPENING_AMOUNT_MISMATCH: opening debit % harus sama dengan invoices.total_amount % pada invoice %', NEW.amount, v_invoice.total_amount, v_invoice.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_type = 'payment_allocation' THEN
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO v_current_balance
    FROM public.receivable_ledger WHERE invoice_id = NEW.invoice_id;
    IF NEW.amount > v_current_balance THEN
      RAISE EXCEPTION 'ALLOCATION_EXCEEDS_OUTSTANDING: credit % melebihi outstanding_balance % pada invoice %', NEW.amount, v_current_balance, NEW.invoice_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_receivable_ledger_entry IS
  'BEFORE INSERT guard receivable_ledger (Gate 2A, diperluas Gate 2D): invoice_id wajib satu tenant. entry_type=invoice_issued wajib amount==invoices.total_amount. entry_type=payment_allocation wajib amount<=outstanding_balance SAAT INI (dihitung ulang dari receivable_ledger, lapisan kedua independen dari record_verified_payment_atomic).';

-- ---------------------------------------------------------------------------
-- 1. payment_receipts -- pembayaran TERVERIFIKASI (cash/bank_transfer).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id         UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  method              VARCHAR(20)   NOT NULL CHECK (method IN ('cash', 'bank_transfer')),
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  currency            VARCHAR(3)    NOT NULL DEFAULT 'IDR',
  transfer_reference  TEXT          CHECK (transfer_reference IS NULL OR length(trim(transfer_reference)) > 0),
  recorded_by         UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  received_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  request_payload     JSONB         NOT NULL,
  idempotency_key     TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, idempotency_key)
);

CREATE UNIQUE INDEX uq_payment_receipts_transfer_reference
  ON public.payment_receipts (company_id, transfer_reference)
  WHERE transfer_reference IS NOT NULL;

CREATE INDEX idx_payment_receipts_company_id  ON public.payment_receipts (company_id, created_at DESC);
CREATE INDEX idx_payment_receipts_customer_id ON public.payment_receipts (customer_id);

COMMENT ON TABLE public.payment_receipts IS
  'Pembayaran TERVERIFIKASI (cash/bank_transfer). Immutable penuh (trg_payment_receipts_immutable). customer_id diturunkan server-side dari invoice pada allocation, bukan parameter client. transfer_reference UNIQUE per company jika diisi (uq_payment_receipts_transfer_reference) -- mencegah pencatatan ganda. request_payload menyimpan snapshot kanonik request (untuk perbandingan idempotency_key retry dengan payload berbeda -- lihat record_verified_payment_atomic).';
COMMENT ON COLUMN public.payment_receipts.received_at IS
  'SELALU NOW() server-side pada saat RPC dieksekusi -- TIDAK menerima timestamp dari client (pola sama dengan collection_activities.occurred_at, Gate 2C).';

-- ---------------------------------------------------------------------------
-- 2. payment_proofs -- metadata/object reference bukti pembayaran, immutable.
--    Minimal satu per receipt ditegakkan RPC (satu-satunya jalur resmi),
--    bukan constraint struktural (lihat catatan desain di atas).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_proofs (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_receipt_id  UUID          NOT NULL REFERENCES public.payment_receipts (id) ON DELETE RESTRICT,
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  proof_type          TEXT          NOT NULL CHECK (length(trim(proof_type)) > 0),
  object_reference    TEXT          NOT NULL CHECK (length(trim(object_reference)) > 0),
  metadata            JSONB         NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by         UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_proofs_receipt_id ON public.payment_proofs (payment_receipt_id);
CREATE INDEX idx_payment_proofs_company_id ON public.payment_proofs (company_id);

COMMENT ON TABLE public.payment_proofs IS
  'Metadata/object reference bukti pembayaran (BUKAN binary file). Immutable penuh (trg_payment_proofs_immutable). Kardinalitas >=1 per payment_receipt_id ditegakkan record_verified_payment_atomic() (PROOF_REQUIRED), bukan constraint tabel.';

-- ---------------------------------------------------------------------------
-- 3. payment_allocations -- alokasi payment ke invoice, 1:1 dengan
--    receivable_ledger credit (receivable_ledger_id UNIQUE).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payment_allocations (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_receipt_id    UUID          NOT NULL REFERENCES public.payment_receipts (id) ON DELETE RESTRICT,
  invoice_id            UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  company_id            UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  amount                NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  receivable_ledger_id  UUID          NOT NULL UNIQUE REFERENCES public.receivable_ledger (id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (payment_receipt_id, invoice_id)
);

CREATE INDEX idx_payment_allocations_receipt_id ON public.payment_allocations (payment_receipt_id);
CREATE INDEX idx_payment_allocations_invoice_id ON public.payment_allocations (invoice_id);

COMMENT ON TABLE public.payment_allocations IS
  'Alokasi SATU payment_receipt ke SATU invoice. receivable_ledger_id UNIQUE -- satu allocation menghasilkan TEPAT SATU credit ledger (invariant gate). amount WAJIB sama dengan receivable_ledger.amount (ditegakkan trg_payment_allocations_tenant). UNIQUE(payment_receipt_id, invoice_id) -- satu invoice hanya dialokasikan sekali per payment.';

-- ---------------------------------------------------------------------------
-- 4. Immutability -- full block, tidak ada UPDATE/DELETE sama sekali.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_payment_receipt_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PAYMENT_RECEIPT_IMMUTABLE: payment_receipt % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'PAYMENT_RECEIPT_IMMUTABLE: payment_receipt % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_receipts_immutable ON public.payment_receipts;
CREATE TRIGGER trg_payment_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.payment_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_receipt_mutation();

CREATE OR REPLACE FUNCTION public.prevent_payment_proof_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PAYMENT_PROOF_IMMUTABLE: payment_proof % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'PAYMENT_PROOF_IMMUTABLE: payment_proof % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_proofs_immutable ON public.payment_proofs;
CREATE TRIGGER trg_payment_proofs_immutable
  BEFORE UPDATE OR DELETE ON public.payment_proofs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_proof_mutation();

CREATE OR REPLACE FUNCTION public.prevent_payment_allocation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PAYMENT_ALLOCATION_IMMUTABLE: payment_allocation % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'PAYMENT_ALLOCATION_IMMUTABLE: payment_allocation % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_allocations_immutable ON public.payment_allocations;
CREATE TRIGGER trg_payment_allocations_immutable
  BEFORE UPDATE OR DELETE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_allocation_mutation();

-- ---------------------------------------------------------------------------
-- 5. Tenant/consistency validation (BEFORE INSERT) -- lapisan kedua,
--    independen dari kebenaran RPC (pola sama dengan Gate 2A/2C).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_payment_receipt_tenant()
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

DROP TRIGGER IF EXISTS trg_payment_receipts_tenant ON public.payment_receipts;
CREATE TRIGGER trg_payment_receipts_tenant
  BEFORE INSERT ON public.payment_receipts
  FOR EACH ROW EXECUTE FUNCTION public.validate_payment_receipt_tenant();

CREATE OR REPLACE FUNCTION public.validate_payment_proof_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_receipt_company_id UUID;
BEGIN
  SELECT company_id INTO v_receipt_company_id FROM public.payment_receipts WHERE id = NEW.payment_receipt_id;
  IF v_receipt_company_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND: %', NEW.payment_receipt_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_receipt_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: payment_receipt % bukan milik company %', NEW.payment_receipt_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_proofs_tenant ON public.payment_proofs;
CREATE TRIGGER trg_payment_proofs_tenant
  BEFORE INSERT ON public.payment_proofs
  FOR EACH ROW EXECUTE FUNCTION public.validate_payment_proof_tenant();

CREATE OR REPLACE FUNCTION public.validate_payment_allocation_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_receipt           public.payment_receipts%ROWTYPE;
  v_invoice_company   UUID;
  v_invoice_customer  UUID;
  v_ledger            public.receivable_ledger%ROWTYPE;
BEGIN
  SELECT * INTO v_receipt FROM public.payment_receipts WHERE id = NEW.payment_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_RECEIPT_NOT_FOUND: %', NEW.payment_receipt_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_receipt.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: payment_receipt % bukan milik company %', NEW.payment_receipt_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT company_id, customer_id INTO v_invoice_company, v_invoice_customer
  FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_invoice_company IS NULL THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_invoice_customer <> v_receipt.customer_id THEN
    RAISE EXCEPTION 'INVOICE_CUSTOMER_MISMATCH: invoice % bukan milik customer % pada payment_receipt %', NEW.invoice_id, v_receipt.customer_id, NEW.payment_receipt_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO v_ledger FROM public.receivable_ledger WHERE id = NEW.receivable_ledger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIVABLE_LEDGER_ENTRY_NOT_FOUND: %', NEW.receivable_ledger_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_ledger.entry_type <> 'payment_allocation' OR v_ledger.direction <> 'credit' THEN
    RAISE EXCEPTION 'ALLOCATION_LEDGER_TYPE_MISMATCH: receivable_ledger % harus entry_type=payment_allocation/direction=credit', NEW.receivable_ledger_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_ledger.invoice_id <> NEW.invoice_id OR v_ledger.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'ALLOCATION_LEDGER_INVOICE_MISMATCH: receivable_ledger % tidak terkait invoice %', NEW.receivable_ledger_id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_ledger.amount <> NEW.amount THEN
    RAISE EXCEPTION 'ALLOCATION_LEDGER_AMOUNT_MISMATCH: amount allocation % tidak sama dengan credit ledger %', NEW.amount, v_ledger.amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_payment_allocations_tenant ON public.payment_allocations;
CREATE TRIGGER trg_payment_allocations_tenant
  BEFORE INSERT ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.validate_payment_allocation_tenant();

-- ---------------------------------------------------------------------------
-- 5b. Pairing invariant -- ledger credit (entry_type=payment_allocation) WAJIB
--     berpasangan dengan TEPAT SATU payment_allocations yang menunjuknya.
--
--     Root cause (audit): section 0 melebarkan CHECK domain receivable_ledger.
--     entry_type agar mengizinkan 'payment_allocation'/'credit' -- ini SAH dan
--     memang tujuan gate ini. Tapi CHECK constraint hanya memvalidasi BENTUK
--     satu baris (entry_type/direction/amount), bukan RELASI-nya ke
--     payment_allocations. Akibatnya, INSERT langsung ke receivable_ledger
--     dengan entry_type='payment_allocation' TANPA payment_allocations/
--     payment_receipts sama sekali (bare/orphan credit -- ini persis yang
--     dilakukan Gate 2A test #13 "entry_type di luar 'invoice_issued'
--     ditolak", yang sekarang lolos CHECK sejak entry_type diperluas) TETAP
--     lolos dan mengurangi derived outstanding_balance (invoice_receivable_
--     balances menghitung SUM(credit) apa adanya, tanpa tahu kredit itu
--     "asli"/bertaut ke payment canonical atau tidak). validate_receivable_
--     ledger_entry() (BEFORE INSERT) tidak bisa menutup ini -- pada saat
--     ledger row itu sendiri di-insert, payment_allocations yang menaut ke
--     ID-nya BELUM ADA (ID baru terbentuk sesudahnya), sehingga BEFORE INSERT
--     trigger pada receivable_ledger tidak mungkin memverifikasi keberadaan
--     pasangannya.
--
--     Fix: constraint trigger AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED
--     pada receivable_ledger -- diperiksa HANYA pada COMMIT transaksi (bukan
--     akhir setiap statement). INITIALLY DEFERRED WAJIB (bukan IMMEDIATE):
--     record_verified_payment_atomic() (section 7) meng-INSERT receivable_
--     ledger LEBIH DULU baru payment_allocations, dalam transaksi yang SAMA --
--     jika diperiksa immediate (akhir statement INSERT ledger), RPC yang SAH
--     akan langsung ditolak sebelum sempat membuat payment_allocations-nya
--     sendiri. Dengan DEFERRED, pemeriksaan menunggu sampai akhir transaksi
--     (saat itu payment_allocations sudah ter-insert oleh RPC yang sama) --
--     RPC legitimate tetap lolos, sedangkan INSERT langsung/orphan (transaksi
--     satu-statement tanpa payment_allocations yang menyertainya) ditolak
--     tepat sebelum COMMIT, membatalkan SELURUH transaksi (ledger row TIDAK
--     tersisa sama sekali -- bukan hanya rejected lalu row tetap ada).
--
--     Independen dari RLS/kepercayaan service_role -- constraint trigger ini
--     berlaku untuk SIAPA PUN yang INSERT ke receivable_ledger, termasuk
--     service_role yang membypass record_verified_payment_atomic() sama
--     sekali (grant ALL ke service_role, lihat 20260707000003, tidak
--     mengecualikan constraint trigger tabel).
--
--     ERRCODE 'check_violation' (SQLSTATE 23514) dipilih SENGAJA -- bukan
--     'integrity_constraint_violation' generik -- supaya konsisten dengan
--     ERRCODE yang sudah dipakai constraint sejenis di gate ini (mis.
--     ALLOCATION_EXCEEDS_OUTSTANDING, section 7) dan agar Gate 2A test #13
--     ("entry_type di luar 'invoice_issued' ditolak CHECK constraint")
--     kembali lulus tanpa perlu mengubah satu baris pun test Gate 2A --
--     assertion literalnya (error.code === '23514') tetap terpenuhi, hanya
--     mekanismenya berpindah dari CHECK constraint (section 0, ditolak untuk
--     SEMUA entry_type di luar domain) menjadi constraint trigger DEFERRED
--     ini (ditolak khusus untuk entry_type='payment_allocation' yang orphan
--     -- domain entry_type itu sendiri tetap sah diperluas).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_payment_allocation_ledger_pairing()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.entry_type = 'payment_allocation' THEN
    IF NOT EXISTS (SELECT 1 FROM public.payment_allocations WHERE receivable_ledger_id = NEW.id) THEN
      RAISE EXCEPTION 'ORPHAN_PAYMENT_ALLOCATION_LEDGER_CREDIT: receivable_ledger % (entry_type=payment_allocation) wajib memiliki tepat satu payment_allocations yang menunjuknya -- credit tidak boleh dibuat tanpa allocation canonical', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.enforce_payment_allocation_ledger_pairing IS
  'Constraint trigger DEFERRABLE INITIALLY DEFERRED pada receivable_ledger -- setiap baris entry_type=payment_allocation WAJIB memiliki tepat satu payment_allocations yang menunjuknya (receivable_ledger_id) pada saat COMMIT transaksi. Menutup celah bare/orphan credit langsung (tanpa payment_receipts/payment_allocations canonical), independen dari RLS/service_role trust. DEFERRED (bukan IMMEDIATE) supaya record_verified_payment_atomic() tetap bisa INSERT ledger lalu payment_allocations berurutan dalam satu transaksi yang sama.';

DROP TRIGGER IF EXISTS trg_receivable_ledger_payment_allocation_pairing ON public.receivable_ledger;
CREATE CONSTRAINT TRIGGER trg_receivable_ledger_payment_allocation_pairing
  AFTER INSERT ON public.receivable_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_allocation_ledger_pairing();

-- ---------------------------------------------------------------------------
-- 6. Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('payment.record', 'payment', 'record', 'Mencatat pembayaran terverifikasi (cash/bank_transfer) dan mengalokasikannya ke invoice milik company sendiri')
ON CONFLICT (name) DO NOTHING;

-- HANYA owner/finance (instruksi gate eksplisit "role Owner/Finance") --
-- LEBIH SEMPIT dari preseden containment permission finance lain di repo ini
-- (invoice.issue/collection.record/collection.promise juga granted ke
-- manager/admin/super_admin). Diikuti literal karena instruksi eksplisit.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'finance')
  AND p.name = 'payment.record'
ON CONFLICT DO NOTHING;

ALTER TABLE public.payment_receipts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_proofs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

-- SELECT-only, reuse permission 'receivable.view' (Gate 2A) -- pola sama
-- dengan Gate 2C (data ini bagian domain piutang, belum ada UI/consumer
-- khusus yang butuh pemisahan granular). Tidak ada policy INSERT/UPDATE/
-- DELETE untuk siapa pun, diperkuat REVOKE eksplisit di bawah.
CREATE POLICY "payment_receipts_select" ON public.payment_receipts
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "payment_proofs_select" ON public.payment_proofs
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "payment_allocations_select" ON public.payment_allocations
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payment_receipts, public.payment_proofs, public.payment_allocations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_receipts, public.payment_proofs, public.payment_allocations TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. RPC canonical -- record_verified_payment_atomic().
--
--    Satu-satunya jalur resmi: payment_receipts + payment_proofs (>=1) +
--    receivable_ledger credit + payment_allocations (1:1 per invoice) +
--    audit dalam SATU transaksi. Invoice yang terlibat DIKUNCI (FOR UPDATE)
--    dalam urutan ascending id sebelum tulis apa pun -- lihat catatan desain
--    di atas untuk alasan urutan dan perhitungan outstanding di dalam lock.
--
--    p_proofs: JSONB array [{ "proof_type": TEXT, "object_reference": TEXT,
--              "metadata": JSONB (opsional) }, ...] -- minimal 1 elemen.
--    p_allocations: JSONB array [{ "invoice_id": UUID, "amount": NUMERIC },
--              ...] -- minimal 1 elemen, invoice_id tidak boleh duplikat
--              dalam satu payment, SUM(amount) harus == p_amount persis.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_verified_payment_atomic(
  p_company_id          UUID,
  p_actor_id            UUID,
  p_method              TEXT,
  p_amount              NUMERIC,
  p_proofs              JSONB,
  p_allocations         JSONB,
  p_transfer_reference  TEXT DEFAULT NULL,
  p_idempotency_key     TEXT DEFAULT NULL
) RETURNS TABLE(
  out_payment_receipt_id  UUID,
  out_already_exists      BOOLEAN,
  out_total_amount        NUMERIC,
  out_allocations         JSONB
) AS $$
DECLARE
  v_transfer_reference  TEXT;
  v_request_payload     JSONB;
  v_existing_receipt    public.payment_receipts%ROWTYPE;
  v_actor_allowed       BOOLEAN;
  v_total_count         INTEGER;
  v_distinct_count      INTEGER;
  v_total_allocation    NUMERIC(15,2);
  v_invoice_ids         UUID[];
  v_invoice_id          UUID;
  v_customer_id         UUID;
  v_inv_company         UUID;
  v_inv_customer        UUID;
  v_alloc_sum_for_invoice NUMERIC(15,2);
  v_outstanding         NUMERIC(15,2);
  v_receipt_id          UUID;
  v_proof_elem          JSONB;
  v_proof_count         INTEGER;
  v_alloc_elem          JSONB;
  v_alloc_invoice_id    UUID;
  v_alloc_amount        NUMERIC(15,2);
  v_ledger_id           UUID;
  v_allocation_id       UUID;
  v_financial_status    TEXT;
  v_allocations_summary JSONB := '[]'::jsonb;
  v_final_allocated     NUMERIC(15,2);
BEGIN
  -- -------------------------------------------------------------------------
  -- A. Validasi struktural (murni fungsi input, tidak menyentuh DB).
  -- -------------------------------------------------------------------------
  IF p_method NOT IN ('cash', 'bank_transfer') THEN
    RAISE EXCEPTION 'INVALID_METHOD: %', p_method USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: % harus lebih dari 0', p_amount USING ERRCODE = 'check_violation';
  END IF;

  IF p_proofs IS NULL OR jsonb_typeof(p_proofs) <> 'array' OR jsonb_array_length(p_proofs) = 0 THEN
    RAISE EXCEPTION 'PROOF_REQUIRED: pembayaran wajib menyertakan minimal satu bukti' USING ERRCODE = 'not_null_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_proofs) elem
    WHERE elem->>'proof_type' IS NULL OR length(trim(elem->>'proof_type')) = 0
       OR elem->>'object_reference' IS NULL OR length(trim(elem->>'object_reference')) = 0
  ) THEN
    RAISE EXCEPTION 'INVALID_PROOF: setiap proof wajib memiliki proof_type dan object_reference' USING ERRCODE = 'check_violation';
  END IF;

  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'ALLOCATION_REQUIRED: pembayaran wajib mengalokasikan ke minimal satu invoice' USING ERRCODE = 'not_null_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_allocations) elem
    WHERE elem->>'invoice_id' IS NULL OR elem->>'amount' IS NULL OR (elem->>'amount')::NUMERIC <= 0
  ) THEN
    RAISE EXCEPTION 'INVALID_ALLOCATION_AMOUNT: setiap allocation wajib memiliki invoice_id dan amount > 0' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT elem->>'invoice_id') INTO v_total_count, v_distinct_count
  FROM jsonb_array_elements(p_allocations) elem;
  IF v_total_count <> v_distinct_count THEN
    RAISE EXCEPTION 'DUPLICATE_INVOICE_IN_ALLOCATION: satu invoice tidak boleh muncul lebih dari sekali dalam satu payment' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT SUM((elem->>'amount')::NUMERIC) INTO v_total_allocation FROM jsonb_array_elements(p_allocations) elem;
  IF v_total_allocation <> p_amount THEN
    RAISE EXCEPTION 'ALLOCATION_TOTAL_MISMATCH: total allocation % tidak sama dengan payment amount %', v_total_allocation, p_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_transfer_reference := NULLIF(trim(COALESCE(p_transfer_reference, '')), '');

  -- -------------------------------------------------------------------------
  -- B. Snapshot request kanonik (urutan dinormalisasi) -- dipakai untuk
  --    perbandingan idempotency_key retry dengan payload berbeda.
  -- -------------------------------------------------------------------------
  SELECT jsonb_build_object(
    'method', p_method,
    'amount', p_amount,
    'transferReference', v_transfer_reference,
    'proofs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'proofType', elem->>'proof_type',
        'objectReference', elem->>'object_reference',
        'metadata', COALESCE(elem->'metadata', '{}'::jsonb)
      ) ORDER BY elem->>'object_reference')
      FROM jsonb_array_elements(p_proofs) elem
    ), '[]'::jsonb),
    'allocations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'invoiceId', elem->>'invoice_id', 'amount', (elem->>'amount')::NUMERIC
      ) ORDER BY elem->>'invoice_id')
      FROM jsonb_array_elements(p_allocations) elem
    ), '[]'::jsonb)
  ) INTO v_request_payload;

  -- -------------------------------------------------------------------------
  -- C. Idempotency -- retry identik (payload sama persis) mengembalikan hasil
  --    yang sama tanpa menulis apa pun lagi; payload berbeda DITOLAK.
  -- -------------------------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing_receipt FROM public.payment_receipts
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      IF v_existing_receipt.request_payload IS DISTINCT FROM v_request_payload THEN
        RAISE EXCEPTION 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH: idempotency_key % sudah dipakai dengan payload berbeda', p_idempotency_key
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'invoiceId', pa.invoice_id, 'allocationId', pa.id, 'ledgerId', pa.receivable_ledger_id,
        'amount', pa.amount, 'financialStatus', b.financial_status
      )), '[]'::jsonb)
      INTO v_allocations_summary
      FROM public.payment_allocations pa
      JOIN public.invoice_receivable_balances b ON b.invoice_id = pa.invoice_id
      WHERE pa.payment_receipt_id = v_existing_receipt.id;

      RETURN QUERY SELECT v_existing_receipt.id, TRUE, v_existing_receipt.amount, v_allocations_summary;
      RETURN;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- D. Actor/permission -- HANYA owner/finance aktif pada tenant yang sama.
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
      AND perm.name = 'payment.record'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission payment.record pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- E. Transfer reference unik per tenant (proaktif -- backstop struktural
  --    tetap uq_payment_receipts_transfer_reference untuk race condition).
  -- -------------------------------------------------------------------------
  IF v_transfer_reference IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.payment_receipts WHERE company_id = p_company_id AND transfer_reference = v_transfer_reference) THEN
      RAISE EXCEPTION 'DUPLICATE_TRANSFER_REFERENCE: transfer_reference % sudah pernah dicatat pada company %', v_transfer_reference, p_company_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- F. Lock invoice (ascending id, cegah deadlock) -- validasi tenant/customer
  --    konsisten + outstanding balance (dihitung ulang DI DALAM lock).
  -- -------------------------------------------------------------------------
  SELECT ARRAY_AGG(DISTINCT (elem->>'invoice_id')::UUID ORDER BY (elem->>'invoice_id')::UUID)
  INTO v_invoice_ids
  FROM jsonb_array_elements(p_allocations) elem;

  FOREACH v_invoice_id IN ARRAY v_invoice_ids LOOP
    SELECT company_id, customer_id INTO v_inv_company, v_inv_customer
    FROM public.invoices WHERE id = v_invoice_id FOR UPDATE;

    IF v_inv_company IS NULL THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', v_invoice_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_inv_company <> p_company_id THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', v_invoice_id, p_company_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_customer_id IS NULL THEN
      v_customer_id := v_inv_customer;
    ELSIF v_inv_customer <> v_customer_id THEN
      RAISE EXCEPTION 'INVOICE_CUSTOMER_MISMATCH: invoice % milik customer berbeda dari invoice lain dalam payment ini', v_invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT (elem->>'amount')::NUMERIC INTO v_alloc_sum_for_invoice
    FROM jsonb_array_elements(p_allocations) elem
    WHERE (elem->>'invoice_id')::UUID = v_invoice_id;

    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO v_outstanding
    FROM public.receivable_ledger WHERE invoice_id = v_invoice_id;

    IF v_alloc_sum_for_invoice > v_outstanding THEN
      RAISE EXCEPTION 'ALLOCATION_EXCEEDS_OUTSTANDING: allocation % melebihi outstanding_balance % pada invoice %', v_alloc_sum_for_invoice, v_outstanding, v_invoice_id
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- G. Insert payment_receipts.
  -- -------------------------------------------------------------------------
  INSERT INTO public.payment_receipts (
    company_id, customer_id, method, amount, transfer_reference, recorded_by, request_payload, idempotency_key
  ) VALUES (
    p_company_id, v_customer_id, p_method, p_amount, v_transfer_reference, p_actor_id, v_request_payload, p_idempotency_key
  ) RETURNING id INTO v_receipt_id;

  -- -------------------------------------------------------------------------
  -- H. Insert payment_proofs -- assertion eksplisit jumlah baris.
  -- -------------------------------------------------------------------------
  FOR v_proof_elem IN SELECT * FROM jsonb_array_elements(p_proofs) LOOP
    INSERT INTO public.payment_proofs (payment_receipt_id, company_id, proof_type, object_reference, metadata, uploaded_by)
    VALUES (v_receipt_id, p_company_id, v_proof_elem->>'proof_type', v_proof_elem->>'object_reference', COALESCE(v_proof_elem->'metadata', '{}'::jsonb), p_actor_id);
  END LOOP;

  SELECT COUNT(*) INTO v_proof_count FROM public.payment_proofs WHERE payment_receipt_id = v_receipt_id;
  IF v_proof_count <> jsonb_array_length(p_proofs) THEN
    RAISE EXCEPTION 'PROOF_MATERIALIZATION_INCOMPLETE: payment_receipt % mengharapkan % proof, hanya % ter-insert', v_receipt_id, jsonb_array_length(p_proofs), v_proof_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- I. Insert receivable_ledger credit + payment_allocations per invoice.
  -- -------------------------------------------------------------------------
  FOR v_alloc_elem IN SELECT * FROM jsonb_array_elements(p_allocations) LOOP
    v_alloc_invoice_id := (v_alloc_elem->>'invoice_id')::UUID;
    v_alloc_amount := (v_alloc_elem->>'amount')::NUMERIC;

    INSERT INTO public.receivable_ledger (company_id, invoice_id, entry_type, direction, amount, created_by)
    VALUES (p_company_id, v_alloc_invoice_id, 'payment_allocation', 'credit', v_alloc_amount, p_actor_id)
    RETURNING id INTO v_ledger_id;

    INSERT INTO public.payment_allocations (payment_receipt_id, invoice_id, company_id, amount, receivable_ledger_id)
    VALUES (v_receipt_id, v_alloc_invoice_id, p_company_id, v_alloc_amount, v_ledger_id)
    RETURNING id INTO v_allocation_id;

    SELECT financial_status INTO v_financial_status FROM public.invoice_receivable_balances WHERE invoice_id = v_alloc_invoice_id;

    v_allocations_summary := v_allocations_summary || jsonb_build_array(jsonb_build_object(
      'invoiceId', v_alloc_invoice_id, 'allocationId', v_allocation_id, 'ledgerId', v_ledger_id,
      'amount', v_alloc_amount, 'financialStatus', v_financial_status
    ));
  END LOOP;

  -- Assertion eksplisit -- SUM(payment_allocations.amount) untuk receipt ini
  -- harus SAMA PERSIS dengan p_amount (independen dari validasi pre-insert).
  SELECT COALESCE(SUM(amount), 0) INTO v_final_allocated FROM public.payment_allocations WHERE payment_receipt_id = v_receipt_id;
  IF v_final_allocated <> p_amount THEN
    RAISE EXCEPTION 'ALLOCATION_TOTAL_MISMATCH: SUM(allocations)=% tidak sama dengan payment amount=%', v_final_allocated, p_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- J. Audit canonical.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'payment.recorded', 'payment_receipts', v_receipt_id,
    jsonb_build_object(
      'company_id', p_company_id, 'customer_id', v_customer_id, 'method', p_method, 'amount', p_amount,
      'transfer_reference', v_transfer_reference, 'allocations', v_allocations_summary, 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_receipt_id, FALSE, p_amount, v_allocations_summary;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.record_verified_payment_atomic IS
  'Satu-satunya jalur resmi pencatatan pembayaran terverifikasi. Atomic: payment_receipts + payment_proofs (>=1) + receivable_ledger credit + payment_allocations (1:1 per invoice) + audit dalam SATU transaksi -- gagal di mana pun me-rollback seluruhnya. Invoice dikunci FOR UPDATE ascending id sebelum tulis apa pun. Menolak: INVALID_METHOD, INVALID_AMOUNT, PROOF_REQUIRED/INVALID_PROOF, ALLOCATION_REQUIRED/INVALID_ALLOCATION_AMOUNT, DUPLICATE_INVOICE_IN_ALLOCATION, ALLOCATION_TOTAL_MISMATCH, IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, FORBIDDEN (permission payment.record, HANYA owner/finance), DUPLICATE_TRANSFER_REFERENCE, INVOICE_NOT_FOUND, TENANT_CONTEXT_MISMATCH, INVOICE_CUSTOMER_MISMATCH, ALLOCATION_EXCEEDS_OUTSTANDING. Tidak pernah menulis outstanding/paid_amount/financial_status manual -- status tetap derived dari invoice_receivable_balances (Gate 2A). Tidak pernah menyentuh promises_to_pay/collection_activities (Gate 2C). Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.record_verified_payment_atomic(UUID, UUID, TEXT, NUMERIC, JSONB, JSONB, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_verified_payment_atomic(UUID, UUID, TEXT, NUMERIC, JSONB, JSONB, TEXT, TEXT)
  TO service_role;
