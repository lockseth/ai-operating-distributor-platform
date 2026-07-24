-- =============================================================================
-- Migration: Order Cancellation & Invoice Void (Gate 2G)
--
-- Invoice void adalah pembatalan ADMINISTRATIF sebelum settlement -- BUKAN
-- retur, credit note, customer credit, atau refund (Gate 2F/di luar scope
-- sini). Menutup jalur resmi pembatalan order yang menyatukan mutasi
-- sales_orders.status='cancelled' dengan pengurangan piutang (jika invoice
-- sudah terbit) dalam SATU transaksi, mengikuti pola request->approve/reject
-- (Gate 2C/2F) BUKAN append-only penuh.
--
-- Dua tabel baru:
--   1. order_cancellations -- request header, transisi status TERBATAS
--                              (requested -> approved|rejected), pola sama
--                              dengan returns (Gate 2F).
--   2. invoice_voids        -- invoice-void record, immutable penuh, 1:1
--                              dengan invoice_id DAN order_cancellation_id
--                              (UNIQUE keduanya) -- "satu invoice hanya satu
--                              void, lahir dari satu cancellation approved".
-- Plus: ALTER receivable_ledger.entry_type -> tambah 'invoice_void' (kredit,
-- compensating penuh terhadap invoice_issued), forward-only (pola sama Gate
-- 2D/2F).
--
-- cancel_sales_order_atomic (20260822000001) TIDAK disentuh -- RPC legacy itu
-- SUDAH menolak status delivered/invoiced/paid/cancelled (containment murni
-- status generik, tanpa pengetahuan invoice/ledger). Gate 2G adalah jalur
-- BARU yang sadar invoice -- satu-satunya jalur resmi untuk membatalkan order
-- yang statusnya invoiced/paid, dan menggantikan pembatalan order
-- tanpa-invoice dengan alur request->approve yang sama (bukan lagi
-- cancel_sales_order_atomic langsung) supaya SATU RPC pair menegakkan "satu
-- approved cancellation per order" secara struktural untuk SEMUA kasus.
--
-- Keputusan desain (audit Gate 2A-2F, BUKAN keputusan bisnis baru):
--
--   - Eligibility dipetakan dari sales_orders.status (field lifecycle
--     kanonis yang SUDAH ada, bukan field baru):
--       * draft/confirmed/processing/delivering -> TIDAK ADA delivery final,
--         TIDAK ADA invoice (issue_invoice_atomic mensyaratkan status
--         'delivered' -- lihat 20260827000001) -> case #1 kontrak: cancel
--         langsung, TANPA ledger entry.
--       * delivered -> delivery SUDAH final (agregat lifecycle, lihat
--         sync_sales_order_delivery_status, 20260717000001) TETAPI belum
--         invoiced -- case #4 kontrak: DITOLAK (DELIVERY_REVERSAL_REQUIRED),
--         Gate 2G tidak menangani inventory/delivery reversal.
--       * invoiced/paid -> invoice SUDAH terbit (issue_invoice_atomic adalah
--         SATU-SATUNYA jalur ke status ini, dan update_sales_order_status_
--         atomic MENGUNCI status ini dari mutasi generik lain sejak
--         20260825000001 -- sehingga invoice yang bersangkutan DIJAMIN ada
--         dan tunggal per order pada praktiknya) -- case #2/#3 kontrak:
--         invoice diperiksa untouched-nya (lihat bawah).
--       * cancelled -> ORDER_ALREADY_CANCELLED (idempotent-safe, retry aman).
--     Case #2 dan #4 karenanya TIDAK PERNAH tumpang tindih -- keduanya
--     dibedakan murni oleh ada/tidaknya invoice pada order, bukan oleh status
--     delivery mentah (invoice tidak mensyaratkan delivery berstatus
--     'verified'/'fully_received' pada schema Gate 2A -- hanya order
--     'delivered' -- sehingga sebuah order invoiced boleh dibatalkan secara
--     administratif tanpa membutuhkan reversal fisik yang di luar scope).
--   - "Belum memiliki pengurangan piutang" (case #2) ditegakkan TIGA lapis,
--     dihitung ulang DI DALAM lock invoice pada saat approval (bukan
--     dipercaya dari state sebelum lock):
--       (a) TIDAK ADA receivable_ledger.entry_type='payment_allocation' pada
--           invoice tsb (invariant "payment verified ditolak");
--       (b) TIDAK ADA credit_notes yang menunjuk invoice tsb, terlepas
--           reversed atau belum (invariant "active credit note ditolak" --
--           credit note yang SUDAH direversal pun tetap menandakan histori
--           invoice yang tidak lagi "polos", sehingga tetap ditolak, BUKAN
--           hanya kalau reversal belum terjadi);
--       (c) outstanding_balance (dihitung ulang dari receivable_ledger,
--           formula sama dengan invoice_receivable_balances) HARUS SAMA
--           PERSIS dengan invoices.total_amount (invariant "outstanding tidak
--           lagi sama ditolak") -- pemeriksaan pertahanan-berlapis terakhir
--           yang menutup kombinasi entry ledger apa pun di luar (a)/(b).
--     Ketiganya independen -- satu saja gagal menghasilkan
--     INVOICE_SETTLEMENT_EXISTS (deterministic business error, TIDAK PERNAH
--     membuat customer credit/refund otomatis -- di luar scope Gate 2G,
--     lihat DEFERRED).
--   - voided_amount SELALU = invoices.total_amount (bukan LEAST/proporsi
--     seperti credit_notes.applied_amount Gate 2F) -- invariant "invoice_void
--     adalah credit yang mengimbangi debit invoice asli secara TEPAT", dan
--     precondition (c) di atas sudah menjamin outstanding==total_amount pada
--     saat itu, sehingga ledger credit invoice_void SELALU applied penuh,
--     TIDAK PERNAH menyisakan customer_credit_amount residual (berbeda dari
--     credit note yang bisa parsial/melebihi outstanding).
--   - Order dengan LEBIH DARI SATU invoice (skenario multi-delivery yang
--     sudah ditolak issue_invoice_atomic sejak Gate 2B -- MULTI_DELIVERY_
--     INVOICING_NOT_SUPPORTED) TIDAK PERNAH terjadi pada data yang lahir dari
--     RPC canonical, tetapi tetap ditolak eksplisit
--     (MULTIPLE_INVOICES_UNSUPPORTED) sebagai pertahanan-berlapis alih-alih
--     diam-diam memilih salah satu.
--   - Locking: order_cancellations DIKUNCI (FOR UPDATE) SEBELUM validasi
--     status pada approval -- percobaan approve/reject konkuren pada
--     cancellation_id yang SAMA otomatis terserialisasi (percobaan kedua
--     melihat status sudah bukan 'requested', ORDER_CANCELLATION_ALREADY_
--     RESOLVED) -- pola identik verify_return_atomic (Gate 2F). sales_orders
--     DAN invoices (jika ada) JUGA dikunci (FOR UPDATE) di dalam approve,
--     SEBELUM eligibility check apa pun -- pola sama issue_invoice_atomic/
--     verify_return_atomic.
--   - Permission 'order_cancellation.request': owner/manager/admin/
--     super_admin/finance (BUKAN sales) -- disamakan containment
--     invoice.issue/return.request (Gate 2B/2F), karena request ini bisa
--     berujung memicu invoice void (dampak finansial), bukan sekadar
--     mutasi order murni. 'order_cancellation.approve': HANYA owner --
--     instruksi gate eksplisit "Owner-only", pola sama return.verify/
--     credit_note.reverse (Gate 2F).
--   - Tidak ada mekanisme customer credit/refund pada gate ini -- invoice
--     void yang mengurangi piutang HANYA berlaku bila invoice belum
--     tersentuh (precondition c), sehingga voided_amount tidak pernah
--     melebihi outstanding dan tidak pernah menyisakan residual yang perlu
--     "dikreditkan" ke customer.
--
-- DEFERRED (tidak dikerjakan di sini, lihat laporan akhir):
--   Customer Credit Ledger & Refund, inventory/delivery reversal (case #4),
--   UI/dashboard/sidebar, Telegram/WhatsApp, cloud migration/deploy/push,
--   dukungan order dengan lebih dari satu invoice/delivery.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Perluasan receivable_ledger.entry_type -> tambah 'invoice_void' (kredit).
--    Pola identik Gate 2D/2F (DROP via introspeksi definisi, bukan nama
--    constraint hardcoded).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_conname TEXT;
BEGIN
  FOR v_conname IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.receivable_ledger'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%entry_type%'
      AND pg_get_constraintdef(oid) NOT ILIKE '%direction%'
  LOOP
    EXECUTE format('ALTER TABLE public.receivable_ledger DROP CONSTRAINT %I', v_conname);
  END LOOP;

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
  CHECK (entry_type IN ('invoice_issued', 'payment_allocation', 'credit_note', 'credit_note_reversal', 'invoice_void'));

ALTER TABLE public.receivable_ledger
  ADD CONSTRAINT receivable_ledger_entry_direction_check
  CHECK (
    (entry_type = 'invoice_issued'       AND direction = 'debit')  OR
    (entry_type = 'payment_allocation'   AND direction = 'credit') OR
    (entry_type = 'credit_note'          AND direction = 'credit') OR
    (entry_type = 'credit_note_reversal' AND direction = 'debit')  OR
    (entry_type = 'invoice_void'         AND direction = 'credit')
  );

COMMENT ON COLUMN public.receivable_ledger.entry_type IS
  'invoice_issued (debit, Gate 2A/2B), payment_allocation (credit, Gate 2D), credit_note (credit, Gate 2F), credit_note_reversal (debit compensating, Gate 2F), invoice_void (credit compensating penuh, Gate 2G) -- lihat receivable_ledger_entry_direction_check untuk pemetaan wajib entry_type->direction.';

-- validate_receivable_ledger_entry() (Gate 2A, diperluas Gate 2D/2F) diperluas
-- lagi: invoice_void dibatasi outstanding SAAT INI (sama seperti payment_
-- allocation/credit_note) DAN wajib PERSIS sama dengan invoices.total_amount
-- (invariant "invoice_void mengimbangi debit invoice asli secara TEPAT" --
-- bukan hanya <=, seperti opening debit invoice_issued).
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
  IF NEW.entry_type = 'invoice_void' AND NEW.amount <> v_invoice.total_amount THEN
    RAISE EXCEPTION 'INVOICE_VOID_AMOUNT_MISMATCH: voided_amount % harus sama persis dengan invoices.total_amount % pada invoice %', NEW.amount, v_invoice.total_amount, v_invoice.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.entry_type IN ('payment_allocation', 'credit_note', 'invoice_void') THEN
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO v_current_balance
    FROM public.receivable_ledger WHERE invoice_id = NEW.invoice_id;
    IF NEW.amount > v_current_balance THEN
      RAISE EXCEPTION 'ALLOCATION_EXCEEDS_OUTSTANDING: credit % melebihi outstanding_balance % pada invoice %', NEW.amount, v_current_balance, NEW.invoice_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.entry_type = 'credit_note_reversal' THEN
    SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
    INTO v_current_balance
    FROM public.receivable_ledger WHERE invoice_id = NEW.invoice_id;
    IF v_current_balance + NEW.amount > v_invoice.total_amount THEN
      RAISE EXCEPTION 'REVERSAL_EXCEEDS_INVOICE_TOTAL: compensating debit % membuat saldo % melebihi total_amount invoice % (%)', NEW.amount, v_current_balance + NEW.amount, v_invoice.id, v_invoice.total_amount
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_receivable_ledger_entry IS
  'BEFORE INSERT guard receivable_ledger (Gate 2A, diperluas Gate 2D/2F/2G): invoice_id wajib satu tenant. invoice_issued wajib amount==invoices.total_amount. invoice_void wajib amount==invoices.total_amount (compensating penuh) DAN amount<=outstanding SAAT INI. payment_allocation/credit_note wajib amount<=outstanding_balance SAAT INI. credit_note_reversal (debit) tidak boleh membuat saldo melebihi invoices.total_amount.';

-- ---------------------------------------------------------------------------
-- 1. order_cancellations -- request header pembatalan order. Transisi status
--    TERBATAS (requested -> approved|rejected), pola sama dengan returns
--    (Gate 2F)/promises_to_pay (Gate 2C).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_cancellations (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id    UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE RESTRICT,
  status            VARCHAR(10)   NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected')),
  reason_code       TEXT          NOT NULL CHECK (length(trim(reason_code)) > 0),
  requested_by      UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  requested_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  decided_by        UUID          REFERENCES public.users (id) ON DELETE RESTRICT,
  decided_at        TIMESTAMPTZ,
  request_payload   JSONB         NOT NULL,
  idempotency_key   TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK ((status = 'requested') = (decided_by IS NULL)),
  CHECK ((status = 'requested') = (decided_at IS NULL)),
  UNIQUE (company_id, idempotency_key)
);

-- Invariant struktural "satu approved cancellation per order" -- partial
-- unique index, bukan hanya dicegah prosedural di RPC.
CREATE UNIQUE INDEX uq_order_cancellations_one_approved_per_order
  ON public.order_cancellations (sales_order_id)
  WHERE status = 'approved';

CREATE INDEX idx_order_cancellations_company_id ON public.order_cancellations (company_id, created_at DESC);
CREATE INDEX idx_order_cancellations_order_id   ON public.order_cancellations (sales_order_id);
CREATE INDEX idx_order_cancellations_status     ON public.order_cancellations (company_id, status);

COMMENT ON TABLE public.order_cancellations IS
  'Request header pembatalan order (Gate 2G). status requested->approved|rejected TERBATAS (trg_order_cancellations_immutable). uq_order_cancellations_one_approved_per_order menegakkan "satu approved cancellation per order" secara STRUKTURAL. Approve dapat memicu invoice_voids (jika order sudah invoiced) -- lihat approve_order_cancellation_atomic.';

-- ---------------------------------------------------------------------------
-- 2. invoice_voids -- invoice-void record, immutable penuh. 1:1 dengan
--    invoice_id DAN order_cancellation_id (UNIQUE keduanya).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoice_voids (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  order_cancellation_id  UUID          NOT NULL UNIQUE REFERENCES public.order_cancellations (id) ON DELETE RESTRICT,
  invoice_id             UUID          NOT NULL UNIQUE REFERENCES public.invoices (id) ON DELETE RESTRICT,
  voided_amount          NUMERIC(15,2) NOT NULL CHECK (voided_amount > 0),
  receivable_ledger_id   UUID          NOT NULL UNIQUE REFERENCES public.receivable_ledger (id) ON DELETE RESTRICT,
  approved_by            UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoice_voids_company_id ON public.invoice_voids (company_id, created_at DESC);
CREATE INDEX idx_invoice_voids_invoice_id ON public.invoice_voids (invoice_id);

COMMENT ON TABLE public.invoice_voids IS
  'Invoice-void record (Gate 2G) -- immutable penuh (trg_invoice_voids_immutable). invoice_id UNIQUE menegakkan "satu invoice hanya satu void" secara STRUKTURAL. order_cancellation_id UNIQUE menegakkan 1:1 dengan cancellation yang menerbitkannya. voided_amount SELALU == invoices.total_amount (compensating penuh, bukan proporsi) -- invoice_void hanya dibuat saat invoice belum tersentuh (lihat approve_order_cancellation_atomic).';

-- ---------------------------------------------------------------------------
-- 3. Immutability.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_order_cancellation_invalid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_IMMUTABLE: order_cancellation % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.company_id       IS DISTINCT FROM OLD.company_id
     OR NEW.sales_order_id   IS DISTINCT FROM OLD.sales_order_id
     OR NEW.reason_code         IS DISTINCT FROM OLD.reason_code
     OR NEW.requested_by           IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at              IS DISTINCT FROM OLD.requested_at
     OR NEW.request_payload              IS DISTINCT FROM OLD.request_payload
     OR NEW.idempotency_key                 IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at                         IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_TERMS_IMMUTABLE: data order_cancellation % tidak dapat diubah setelah dibuat -- hanya status/decided_by/decided_at yang boleh bertransisi', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_ALREADY_RESOLVED: order_cancellation % sudah berstatus % (final), tidak dapat diputuskan lagi', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_INVALID_TRANSITION: transisi status % -> % tidak diizinkan', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_DECISION_METADATA_REQUIRED: decided_by/decided_at wajib diisi saat memutuskan order_cancellation %', OLD.id
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_order_cancellations_immutable ON public.order_cancellations;
CREATE TRIGGER trg_order_cancellations_immutable
  BEFORE UPDATE OR DELETE ON public.order_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_order_cancellation_invalid_mutation();

CREATE OR REPLACE FUNCTION public.prevent_invoice_void_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVOICE_VOID_IMMUTABLE: invoice_void % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'INVOICE_VOID_IMMUTABLE: invoice_void % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_invoice_voids_immutable ON public.invoice_voids;
CREATE TRIGGER trg_invoice_voids_immutable
  BEFORE UPDATE OR DELETE ON public.invoice_voids
  FOR EACH ROW EXECUTE FUNCTION public.prevent_invoice_void_mutation();

-- ---------------------------------------------------------------------------
-- 4. Tenant/consistency validation (BEFORE INSERT) -- lapisan kedua,
--    independen dari kebenaran RPC (pola sama dengan Gate 2A-2F).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_order_cancellation_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_order_company    UUID;
  v_requester_company UUID;
BEGIN
  SELECT company_id INTO v_order_company FROM public.sales_orders WHERE id = NEW.sales_order_id;
  IF v_order_company IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', NEW.sales_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_order_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: sales_order % bukan milik company %', NEW.sales_order_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
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

DROP TRIGGER IF EXISTS trg_order_cancellations_tenant ON public.order_cancellations;
CREATE TRIGGER trg_order_cancellations_tenant
  BEFORE INSERT ON public.order_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.validate_order_cancellation_tenant();

CREATE OR REPLACE FUNCTION public.validate_invoice_void_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_cancellation public.order_cancellations%ROWTYPE;
  v_invoice      public.invoices%ROWTYPE;
  v_ledger       public.receivable_ledger%ROWTYPE;
BEGIN
  SELECT * INTO v_cancellation FROM public.order_cancellations WHERE id = NEW.order_cancellation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_NOT_FOUND: %', NEW.order_cancellation_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_cancellation.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: order_cancellation % bukan milik company %', NEW.order_cancellation_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_invoice.sales_order_id <> v_cancellation.sales_order_id THEN
    RAISE EXCEPTION 'INVOICE_VOID_ORDER_MISMATCH: invoice % bukan milik order % pada cancellation %', NEW.invoice_id, v_cancellation.sales_order_id, NEW.order_cancellation_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.voided_amount <> v_invoice.total_amount THEN
    RAISE EXCEPTION 'INVOICE_VOID_AMOUNT_MISMATCH: voided_amount % harus sama persis dengan invoices.total_amount %', NEW.voided_amount, v_invoice.total_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO v_ledger FROM public.receivable_ledger WHERE id = NEW.receivable_ledger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RECEIVABLE_LEDGER_ENTRY_NOT_FOUND: %', NEW.receivable_ledger_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_ledger.entry_type <> 'invoice_void' OR v_ledger.direction <> 'credit' THEN
    RAISE EXCEPTION 'INVOICE_VOID_LEDGER_TYPE_MISMATCH: receivable_ledger % harus entry_type=invoice_void/direction=credit', NEW.receivable_ledger_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_ledger.invoice_id <> NEW.invoice_id OR v_ledger.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'INVOICE_VOID_LEDGER_INVOICE_MISMATCH: receivable_ledger % tidak terkait invoice %', NEW.receivable_ledger_id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_ledger.amount <> NEW.voided_amount THEN
    RAISE EXCEPTION 'INVOICE_VOID_LEDGER_AMOUNT_MISMATCH: voided_amount % tidak sama dengan credit ledger %', NEW.voided_amount, v_ledger.amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_invoice_voids_tenant ON public.invoice_voids;
CREATE TRIGGER trg_invoice_voids_tenant
  BEFORE INSERT ON public.invoice_voids
  FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_void_tenant();

-- ---------------------------------------------------------------------------
-- 4b. Pairing invariant -- ledger credit entry_type='invoice_void' WAJIB
--     berpasangan dengan TEPAT SATU invoice_voids yang menunjuknya. Pola
--     identik enforce_return_ledger_pairing (Gate 2F)/enforce_payment_
--     allocation_ledger_pairing (Gate 2D) -- constraint trigger AFTER INSERT
--     DEFERRABLE INITIALLY DEFERRED supaya approve_order_cancellation_atomic
--     tetap bisa INSERT ledger LEBIH DULU baru invoice_voids dalam transaksi
--     yang sama.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_invoice_void_ledger_pairing()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.entry_type = 'invoice_void' THEN
    IF NOT EXISTS (SELECT 1 FROM public.invoice_voids WHERE receivable_ledger_id = NEW.id) THEN
      RAISE EXCEPTION 'ORPHAN_INVOICE_VOID_LEDGER_CREDIT: receivable_ledger % (entry_type=invoice_void) wajib memiliki tepat satu invoice_voids yang menunjuknya', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.enforce_invoice_void_ledger_pairing IS
  'Constraint trigger DEFERRABLE INITIALLY DEFERRED pada receivable_ledger -- entry_type=invoice_void wajib punya tepat satu invoice_voids yang menunjuknya, diperiksa pada COMMIT. Menutup celah bare/orphan credit langsung, independen dari RLS/service_role trust (pola identik Gate 2D/2F).';

DROP TRIGGER IF EXISTS trg_receivable_ledger_invoice_void_pairing ON public.receivable_ledger;
CREATE CONSTRAINT TRIGGER trg_receivable_ledger_invoice_void_pairing
  AFTER INSERT ON public.receivable_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invoice_void_ledger_pairing();

-- ---------------------------------------------------------------------------
-- 5. Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('order_cancellation.request', 'order_cancellation', 'request', 'Mengajukan pembatalan order milik company sendiri'),
  ('order_cancellation.approve', 'order_cancellation', 'approve', 'Memverifikasi (approve/reject) pembatalan order dan menerbitkan invoice void bila perlu -- Owner only')
ON CONFLICT (name) DO NOTHING;

-- order_cancellation.request disamakan containment invoice.issue/return.request
-- (Gate 2B/2F) -- owner/manager/admin/super_admin/finance, BUKAN sales.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')
  AND p.name = 'order_cancellation.request'
ON CONFLICT DO NOTHING;

-- order_cancellation.approve: HANYA owner (instruksi gate eksplisit
-- "Owner-only") -- pola sama return.verify/credit_note.reverse (Gate 2F).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name = 'owner'
  AND p.name = 'order_cancellation.approve'
ON CONFLICT DO NOTHING;

ALTER TABLE public.order_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_voids       ENABLE ROW LEVEL SECURITY;

-- SELECT-only, reuse 'receivable.view' (Gate 2A) -- pola sama Gate 2C/2D/2E/2F.
-- Tidak ada policy INSERT/UPDATE/DELETE untuk siapa pun, diperkuat REVOKE
-- eksplisit di bawah.
CREATE POLICY "order_cancellations_select" ON public.order_cancellations
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "invoice_voids_select" ON public.invoice_voids
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.order_cancellations, public.invoice_voids
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_cancellations, public.invoice_voids TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC canonical -- request_order_cancellation_atomic().
--    Satu-satunya jalur resmi mengajukan pembatalan order (status=requested).
--    TIDAK menyentuh sales_orders.status/invoices/receivable_ledger sama
--    sekali -- efek finansial/status HANYA terjadi lewat
--    approve_order_cancellation_atomic.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_order_cancellation_atomic(
  p_company_id        UUID,
  p_actor_id          UUID,
  p_sales_order_id    UUID,
  p_reason_code       TEXT,
  p_idempotency_key   TEXT DEFAULT NULL
) RETURNS TABLE(
  out_cancellation_id UUID,
  out_status          VARCHAR,
  out_already_exists  BOOLEAN
) AS $$
DECLARE
  v_request_payload  JSONB;
  v_existing         public.order_cancellations%ROWTYPE;
  v_actor_allowed    BOOLEAN;
  v_order            public.sales_orders%ROWTYPE;
  v_cancellation_id  UUID;
BEGIN
  -- -------------------------------------------------------------------------
  -- A. Validasi struktural.
  -- -------------------------------------------------------------------------
  IF p_reason_code IS NULL OR length(trim(p_reason_code)) = 0 THEN
    RAISE EXCEPTION 'REASON_CODE_REQUIRED: pembatalan order wajib menyertakan reason_code' USING ERRCODE = 'not_null_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Snapshot request kanonik -- idempotency payload.
  -- -------------------------------------------------------------------------
  v_request_payload := jsonb_build_object('salesOrderId', p_sales_order_id, 'reasonCode', p_reason_code);

  -- -------------------------------------------------------------------------
  -- C. Idempotency.
  -- -------------------------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.order_cancellations
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
  -- D. Actor/permission.
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
      AND perm.name = 'order_cancellation.request'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission order_cancellation.request pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- E. Lock + validasi order canonical.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', p_sales_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_order.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: sales_order % bukan milik company %', p_sales_order_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'ORDER_ALREADY_CANCELLED: order % sudah berstatus cancelled', p_sales_order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_cancellations WHERE sales_order_id = p_sales_order_id AND status = 'requested') THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_ALREADY_REQUESTED: order % sudah memiliki pengajuan pembatalan yang belum diputuskan', p_sales_order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- F. Insert order_cancellations.
  -- -------------------------------------------------------------------------
  INSERT INTO public.order_cancellations (
    company_id, sales_order_id, reason_code, requested_by, request_payload, idempotency_key
  ) VALUES (
    p_company_id, p_sales_order_id, p_reason_code, p_actor_id, v_request_payload, p_idempotency_key
  ) RETURNING id INTO v_cancellation_id;

  -- -------------------------------------------------------------------------
  -- G. Audit canonical.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order_cancellation.requested', 'order_cancellations', v_cancellation_id,
    jsonb_build_object(
      'cancellation_id', v_cancellation_id, 'sales_order_id', p_sales_order_id,
      'reason_code', p_reason_code, 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_cancellation_id, 'requested'::VARCHAR, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.request_order_cancellation_atomic IS
  'Satu-satunya jalur resmi mengajukan pembatalan order (status=requested). Atomic: order_cancellations + audit dalam SATU transaksi. Menolak: REASON_CODE_REQUIRED, IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, FORBIDDEN (permission order_cancellation.request), ORDER_NOT_FOUND, TENANT_CONTEXT_MISMATCH, ORDER_ALREADY_CANCELLED, ORDER_CANCELLATION_ALREADY_REQUESTED. TIDAK PERNAH menyentuh sales_orders.status/invoices/receivable_ledger. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.request_order_cancellation_atomic(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_order_cancellation_atomic(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC canonical -- approve_order_cancellation_atomic().
--    Owner-only. p_decision IN ('approve','reject'). Reject: tandai
--    rejected, TANPA efek apa pun pada order/invoice/ledger. Approve: lock
--    order_cancellations + sales_orders (+ invoices jika ada) SEBELUM
--    eligibility check, transisi sales_orders.status='cancelled', dan --
--    HANYA jika order sudah invoiced/paid DAN invoice belum tersentuh --
--    insert ledger credit 'invoice_void' SEBELUM invoice_voids (supaya
--    pairing invariant DEFERRED terpenuhi pada COMMIT).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_order_cancellation_atomic(
  p_company_id      UUID,
  p_actor_id        UUID,
  p_cancellation_id UUID,
  p_decision        TEXT
) RETURNS TABLE(
  out_cancellation_id  UUID,
  out_status           VARCHAR,
  out_order_status     VARCHAR,
  out_invoice_void_id  UUID,
  out_voided_amount    NUMERIC
) AS $$
DECLARE
  v_actor_allowed     BOOLEAN;
  v_cancellation      public.order_cancellations%ROWTYPE;
  v_order             public.sales_orders%ROWTYPE;
  v_invoice           public.invoices%ROWTYPE;
  v_invoice_count     INTEGER;
  v_has_payment       BOOLEAN;
  v_has_credit_note   BOOLEAN;
  v_outstanding       NUMERIC(15,2);
  v_ledger_id         UUID;
  v_invoice_void_id   UUID;
  v_voided_amount     NUMERIC(15,2);
BEGIN
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'INVALID_DECISION: %', p_decision USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- -------------------------------------------------------------------------
  -- A. Actor -- Owner-only (instruksi gate eksplisit).
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
      AND perm.name = 'order_cancellation.approve'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission order_cancellation.approve pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Lock order_cancellations -- menyerialisasi double/concurrent decision
  --    pada cancellation_id yang SAMA.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_cancellation FROM public.order_cancellations WHERE id = p_cancellation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_NOT_FOUND: %', p_cancellation_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_cancellation.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: order_cancellation % bukan milik company %', p_cancellation_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_cancellation.status <> 'requested' THEN
    RAISE EXCEPTION 'ORDER_CANCELLATION_ALREADY_RESOLVED: order_cancellation % sudah berstatus %', p_cancellation_id, v_cancellation.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- C. Reject -- tanpa efek apa pun pada order/invoice/ledger.
  -- -------------------------------------------------------------------------
  IF p_decision = 'reject' THEN
    UPDATE public.order_cancellations SET status = 'rejected', decided_by = p_actor_id, decided_at = NOW() WHERE id = p_cancellation_id;

    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, old_data, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'order_cancellation.rejected', 'order_cancellations', p_cancellation_id,
      jsonb_build_object('status', 'requested'),
      jsonb_build_object('status', 'rejected', 'cancellation_id', p_cancellation_id, 'sales_order_id', v_cancellation.sales_order_id),
      NULL, 'audit', 'finance', 'web', 'success'
    );

    RETURN QUERY SELECT p_cancellation_id, 'rejected'::VARCHAR, NULL::VARCHAR, NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- D. Approve -- lock order SEBELUM eligibility check apa pun.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_order FROM public.sales_orders WHERE id = v_cancellation.sales_order_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', v_cancellation.sales_order_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'ORDER_ALREADY_CANCELLED: order % sudah berstatus cancelled', v_order.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Case #4 kontrak: delivery sudah final (agregat 'delivered') tetapi belum
  -- invoiced -- ditolak, Gate 2G tidak menangani inventory/delivery reversal.
  IF v_order.status = 'delivered' THEN
    RAISE EXCEPTION 'DELIVERY_REVERSAL_REQUIRED: order % sudah delivered (delivery final) -- pembatalan membutuhkan stock/delivery reversal, di luar scope Gate 2G', v_order.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_order.status IN ('draft', 'confirmed', 'processing', 'delivering') THEN
    -- Case #1 kontrak: eligible tanpa invoice -- cancel langsung, TANPA
    -- ledger entry apa pun.
    UPDATE public.sales_orders SET status = 'cancelled' WHERE id = v_order.id;
    UPDATE public.order_cancellations SET status = 'approved', decided_by = p_actor_id, decided_at = NOW() WHERE id = p_cancellation_id;

    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, old_data, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'order_cancellation.approved', 'order_cancellations', p_cancellation_id,
      jsonb_build_object('status', 'requested', 'order_status', v_order.status),
      jsonb_build_object('status', 'approved', 'cancellation_id', p_cancellation_id, 'sales_order_id', v_order.id, 'order_status', 'cancelled', 'invoice_void_id', NULL),
      NULL, 'audit', 'finance', 'web', 'success'
    );

    RETURN QUERY SELECT p_cancellation_id, 'approved'::VARCHAR, 'cancelled'::VARCHAR, NULL::UUID, NULL::NUMERIC;
    RETURN;
  END IF;

  IF v_order.status NOT IN ('invoiced', 'paid') THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATUS_FOR_CANCELLATION: order % berstatus % tidak dikenali Gate 2G', v_order.id, v_order.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Case #2/#3 kontrak: order sudah invoiced/paid -- invoice WAJIB ada
  -- (issue_invoice_atomic satu-satunya jalur ke status ini) dan tunggal.
  SELECT COUNT(*) INTO v_invoice_count FROM public.invoices WHERE sales_order_id = v_order.id;
  IF v_invoice_count = 0 THEN
    RAISE EXCEPTION 'INVOICE_RECORD_MISSING: order % berstatus % tetapi tidak memiliki invoice canonical -- di luar scope Gate 2G', v_order.id, v_order.status
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF v_invoice_count > 1 THEN
    RAISE EXCEPTION 'MULTIPLE_INVOICES_UNSUPPORTED: order % memiliki lebih dari satu invoice -- di luar scope Gate 2G', v_order.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE sales_order_id = v_order.id FOR UPDATE;

  -- Precondition "belum memiliki pengurangan piutang" -- TIGA lapis
  -- independen, dihitung ulang DI DALAM lock invoice.
  v_has_payment := EXISTS (
    SELECT 1 FROM public.receivable_ledger WHERE invoice_id = v_invoice.id AND entry_type = 'payment_allocation'
  );
  v_has_credit_note := EXISTS (
    SELECT 1 FROM public.credit_notes WHERE invoice_id = v_invoice.id
  );
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
  INTO v_outstanding
  FROM public.receivable_ledger WHERE invoice_id = v_invoice.id;

  IF v_has_payment OR v_has_credit_note OR v_outstanding <> v_invoice.total_amount THEN
    RAISE EXCEPTION 'INVOICE_SETTLEMENT_EXISTS: invoice % sudah memiliki payment terverifikasi/credit note aktif/outstanding yang berubah -- invoice void tidak didukung Gate 2G (bukan retur/credit note/refund)', v_invoice.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Case #2 kontrak: invoice belum tersentuh -- void penuh + ledger credit
  -- compensating SEBELUM invoice_voids (pairing invariant DEFERRED).
  v_voided_amount := v_invoice.total_amount;

  INSERT INTO public.receivable_ledger (company_id, invoice_id, entry_type, direction, amount, created_by)
  VALUES (p_company_id, v_invoice.id, 'invoice_void', 'credit', v_voided_amount, p_actor_id)
  RETURNING id INTO v_ledger_id;

  INSERT INTO public.invoice_voids (
    company_id, order_cancellation_id, invoice_id, voided_amount, receivable_ledger_id, approved_by
  ) VALUES (
    p_company_id, p_cancellation_id, v_invoice.id, v_voided_amount, v_ledger_id, p_actor_id
  ) RETURNING id INTO v_invoice_void_id;

  UPDATE public.sales_orders SET status = 'cancelled' WHERE id = v_order.id;
  UPDATE public.order_cancellations SET status = 'approved', decided_by = p_actor_id, decided_at = NOW() WHERE id = p_cancellation_id;

  -- -------------------------------------------------------------------------
  -- E. Audit canonical -- order_cancellation.approved, invoice.voided, dan
  --    receivable.adjusted.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order_cancellation.approved', 'order_cancellations', p_cancellation_id,
    jsonb_build_object('status', 'requested', 'order_status', v_order.status),
    jsonb_build_object('status', 'approved', 'cancellation_id', p_cancellation_id, 'sales_order_id', v_order.id, 'order_status', 'cancelled', 'invoice_void_id', v_invoice_void_id),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'invoice.voided', 'invoice_voids', v_invoice_void_id,
    jsonb_build_object(
      'invoice_void_id', v_invoice_void_id, 'invoice_id', v_invoice.id, 'order_cancellation_id', p_cancellation_id,
      'voided_amount', v_voided_amount
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'receivable.adjusted', 'receivable_ledger', v_ledger_id,
    jsonb_build_object(
      'invoice_id', v_invoice.id, 'entry_type', 'invoice_void', 'amount', v_voided_amount,
      'balance_before', v_outstanding, 'balance_after', v_outstanding - v_voided_amount, 'invoice_void_id', v_invoice_void_id
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT p_cancellation_id, 'approved'::VARCHAR, 'cancelled'::VARCHAR, v_invoice_void_id, v_voided_amount;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.approve_order_cancellation_atomic IS
  'Owner-only. Reject: tandai order_cancellations.status=rejected, TANPA efek apa pun. Approve: lock order_cancellations (serialize -- ORDER_CANCELLATION_ALREADY_RESOLVED pada percobaan kedua) + lock sales_orders (+ invoices jika ada) SEBELUM eligibility check. Cabang berdasarkan sales_orders.status: draft/confirmed/processing/delivering -> cancel langsung tanpa ledger; delivered -> DELIVERY_REVERSAL_REQUIRED; invoiced/paid -> cek invoice untouched (payment_allocation/credit_notes/outstanding), jika untouched INSERT ledger credit invoice_void (=invoices.total_amount) SEBELUM invoice_voids, lalu cancel order, dalam SATU transaksi. Menolak: INVALID_DECISION, FORBIDDEN (permission order_cancellation.approve, HANYA owner), ORDER_CANCELLATION_NOT_FOUND, TENANT_CONTEXT_MISMATCH, ORDER_CANCELLATION_ALREADY_RESOLVED, ORDER_ALREADY_CANCELLED, DELIVERY_REVERSAL_REQUIRED, INVOICE_RECORD_MISSING, MULTIPLE_INVOICES_UNSUPPORTED, INVOICE_SETTLEMENT_EXISTS. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.approve_order_cancellation_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_order_cancellation_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;
