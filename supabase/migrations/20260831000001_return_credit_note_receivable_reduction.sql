-- =============================================================================
-- Migration: Retur, Credit Note & Pengurangan Piutang (Gate 2F)
--
-- Menutup segmen Invoice -> Collection -> Payment -> Retur dengan jalur
-- canonical: invoice asli (immutable, Gate 2A/2B) -> retur dengan bukti
-- (requested) -> verifikasi Owner (approve/reject) -> credit note (immutable)
-- -> pengurangan piutang lewat receivable_ledger credit baru (Gate 2A).
-- Retur TIDAK PERNAH mengedit invoice/invoice_lines lama, TIDAK PERNAH
-- menghapus ledger lama -- koreksi selalu entry baru (kontrak invariant #6,
-- §5).
--
-- Lima tabel baru:
--   1. returns              -- retur header, transisi status TERBATAS
--                               (requested -> approved|rejected), pola sama
--                               dengan promises_to_pay (Gate 2C) BUKAN
--                               append-only penuh.
--   2. return_items          -- baris retur per invoice_line, immutable penuh.
--   3. credit_notes           -- credit note header, immutable penuh, 1:1
--                               dengan return_id (UNIQUE) -- "satu retur
--                               terverifikasi hanya satu credit note".
--   4. credit_note_lines       -- baris credit note per return_item, immutable.
--   5. credit_note_reversals    -- event reversal, immutable, 1:1 dengan
--                               credit_note_id (UNIQUE) -- idempotent by
--                               construction (bukan dari idempotency_key saja).
-- Plus: ALTER receivable_ledger.entry_type -> tambah 'credit_note' (kredit)
-- dan 'credit_note_reversal' (debit compensating), forward-only (pola sama
-- dengan Gate 2D).
--
-- Keputusan desain (audit Gate 2A-2E, BUKAN keputusan bisnis baru):
--
--   - Nilai credit note dihitung SERVER-SIDE dari invoice_lines immutable --
--     line_amount = requested_quantity * (invoice_lines.line_total /
--     invoice_lines.quantity), yaitu proporsi line_total (net setelah diskon)
--     sesuai kuantitas yang dikreditkan -- BUKAN unit_price gross, supaya
--     diskon proporsional ikut terkredit (konsisten dengan bagaimana
--     line_total dihitung di issue_invoice_atomic, Gate 2B). Client TIDAK
--     PERNAH mengirim nominal apa pun -- hanya invoice_line_id + quantity.
--   - Kuantitas kumulatif tertagih-retur per invoice_line ditegakkan DUA
--     lapis: (a) return_items BEFORE INSERT (request time) -- requested_quantity
--     tidak boleh melebihi invoice_lines.quantity (sanity bound per baris
--     retur); (b) verify_return_atomic() BEFORE approve (approval time) --
--     SUM(credit_note_lines.quantity) existing + requested_quantity tidak
--     boleh melebihi invoice_lines.quantity (invariant #6/#15, dihitung ulang
--     di dalam lock invoice FOR UPDATE, sehingga retur PARALEL yang sama-sama
--     requested tidak bisa sama-sama disetujui melebihi kuantitas invoice).
--   - applied_amount = LEAST(credit_note_total, outstanding_balance SAAT INI)
--     (invariant #9), dihitung ulang dari receivable_ledger DI DALAM lock
--     invoice -- konsisten dengan record_verified_payment_atomic (Gate 2D).
--     customer_credit_amount = credit_note_total - applied_amount (invariant
--     #10) -- TIDAK PERNAH memicu refund/cash payout (di luar scope, lihat
--     DEFERRED).
--   - Ledger credit (entry_type='credit_note') HANYA di-insert jika
--     applied_amount > 0 -- invoice yang sudah lunas (outstanding=0)
--     menghasilkan customer_credit murni TANPA ledger credit nol/palsu
--     (credit_notes.receivable_ledger_id tetap NULL, ditegakkan CHECK
--     constraint tabel).
--   - Locking: return row DIKUNCI (FOR UPDATE) SEBELUM validasi status --
--     concurrent/double approval pada return_id yang SAMA otomatis
--     terserialisasi (percobaan kedua melihat status sudah bukan 'requested'
--     setelah lock diperoleh, RETURN_ALREADY_RESOLVED) -- pola identik
--     issue_invoice_atomic (Gate 2B) yang membuktikan hanya SATU dari
--     percobaan concurrent yang sukses. Invoice JUGA dikunci (FOR UPDATE) di
--     dalam approve -- menyerialisasi approval PARALEL dari return BERBEDA
--     yang menyentuh invoice_line yang SAMA (mencegah over-credit lintas
--     retur, invariant #15), pola sama dengan record_verified_payment_atomic
--     mengunci invoice sebelum menghitung outstanding.
--   - Reversal TIDAK memakai idempotency_key sebagai satu-satunya penjaga --
--     credit_note_reversals.credit_note_id UNIQUE menjamin idempotency
--     struktural: percobaan reversal kedua pada credit_note yang sama SELALU
--     mengembalikan hasil reversal PERTAMA (out_already_exists=true) tanpa
--     menulis apa pun lagi, TIDAK PERNAH gagal/menduplikasi (instruksi gate
--     eksplisit "Owner-only dan idempotent").
--   - Compensating debit reversal (entry_type='credit_note_reversal') HANYA
--     di-insert jika credit_notes.applied_amount > 0 (kalau applied_amount=0,
--     tidak pernah ada ledger credit untuk dibalik -- reversal cukup
--     membatalkan customer_credit residual tanpa menyentuh ledger).
--   - customer_credit_amount BUKAN saldo yang bisa dibelanjakan/refund di
--     modul mana pun pada gate ini (tidak ada tabel "customer credit balance"
--     yang mengonsumsinya -- di luar scope eksplisit). "Membatalkan customer
--     credit residual" pada reversal karenanya berarti: mencatat
--     customer_credit_voided_amount pada credit_note_reversals (audit trail)
--     -- TIDAK ADA mekanisme konsumsi yang perlu "dibatalkan" secara aktif
--     karena tidak pernah dibuat di tempat lain. LIMITATION ini dilaporkan
--     apa adanya di laporan akhir Gate 2F, bukan diisi asumsi/fitur baru.
--   - Permission 'return.request': owner/manager/admin/super_admin/finance
--     (BUKAN sales) -- disamakan containment invoice.issue/collection.record
--     (Gate 2B/2C). 'return.verify'/'credit_note.reverse': HANYA owner --
--     instruksi gate eksplisit "Owner-only", lebih sempit dari containment
--     finance manapun sebelumnya (bahkan lebih sempit dari payment.record
--     yang masih mengizinkan finance).
--   - Tidak ada document_number/issued_documents untuk credit note --
--     instruksi gate eksplisit "document/PDF credit note" di luar scope;
--     credit_notes adalah entitas ledger murni, bukan dokumen resmi.
--
-- DEFERRED (tidak dikerjakan di sini, lihat laporan akhir):
--   UI/dashboard/sidebar, Telegram/WhatsApp, upload/storage binary, stock/
--   warehouse disposition, refund/cash payout, profit recalculation,
--   document/PDF credit note, perubahan collection promise, auto-close
--   reconciliation exception, shortpaid automation, notification/Owner alert,
--   cloud migration/deploy/push.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Perluasan receivable_ledger.entry_type -> tambah 'credit_note' (kredit)
--    dan 'credit_note_reversal' (debit compensating). Pola identik Gate 2D
--    (DROP via introspeksi definisi, bukan nama constraint hardcoded).
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
  CHECK (entry_type IN ('invoice_issued', 'payment_allocation', 'credit_note', 'credit_note_reversal'));

ALTER TABLE public.receivable_ledger
  ADD CONSTRAINT receivable_ledger_entry_direction_check
  CHECK (
    (entry_type = 'invoice_issued'       AND direction = 'debit')  OR
    (entry_type = 'payment_allocation'   AND direction = 'credit') OR
    (entry_type = 'credit_note'          AND direction = 'credit') OR
    (entry_type = 'credit_note_reversal' AND direction = 'debit')
  );

COMMENT ON COLUMN public.receivable_ledger.entry_type IS
  'invoice_issued (debit, Gate 2A/2B), payment_allocation (credit, Gate 2D), credit_note (credit, Gate 2F), credit_note_reversal (debit compensating, Gate 2F) -- lihat receivable_ledger_entry_direction_check untuk pemetaan wajib entry_type->direction.';

-- validate_receivable_ledger_entry() (Gate 2A, diperluas Gate 2D) diperluas
-- lagi: credit_note dibatasi outstanding SAAT INI (sama seperti
-- payment_allocation); credit_note_reversal (debit) tidak boleh membuat
-- saldo melebihi invoices.total_amount (batas atas simetris dengan "outstanding
-- tidak boleh negatif" -- tidak boleh memulihkan piutang melebihi nilai
-- invoice yang pernah ada).
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
  IF NEW.entry_type IN ('payment_allocation', 'credit_note') THEN
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
  'BEFORE INSERT guard receivable_ledger (Gate 2A, diperluas Gate 2D/2F): invoice_id wajib satu tenant. invoice_issued wajib amount==invoices.total_amount. payment_allocation/credit_note wajib amount<=outstanding_balance SAAT INI. credit_note_reversal (debit) tidak boleh membuat saldo melebihi invoices.total_amount.';

-- ---------------------------------------------------------------------------
-- 1. returns -- retur header. Transisi status TERBATAS (requested ->
--    approved|rejected), pola sama dengan promises_to_pay (Gate 2C).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.returns (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id       UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  invoice_id        UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  sales_order_id    UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE RESTRICT,
  delivery_id       UUID          NOT NULL REFERENCES public.deliveries (id) ON DELETE RESTRICT,
  status            VARCHAR(10)   NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected')),
  reason_code       TEXT          NOT NULL CHECK (length(trim(reason_code)) > 0),
  proof_reference   TEXT          NOT NULL CHECK (length(trim(proof_reference)) > 0),
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

CREATE INDEX idx_returns_company_id ON public.returns (company_id, created_at DESC);
CREATE INDEX idx_returns_invoice_id ON public.returns (invoice_id);
CREATE INDEX idx_returns_status    ON public.returns (company_id, status);

COMMENT ON TABLE public.returns IS
  'Retur header (Gate 2F). customer_id/sales_order_id/delivery_id diturunkan server-side dari invoice canonical pada saat request (bukan parameter independen client), divalidasi trg_returns_tenant. status requested->approved|rejected TERBATAS (trg_returns_immutable) -- retur requested TIDAK PERNAH mengurangi piutang (invariant #3 gate).';

-- ---------------------------------------------------------------------------
-- 2. return_items -- baris retur per invoice_line, immutable penuh.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.return_items (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id           UUID          NOT NULL REFERENCES public.returns (id) ON DELETE CASCADE,
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  invoice_line_id     UUID          NOT NULL REFERENCES public.invoice_lines (id) ON DELETE RESTRICT,
  requested_quantity  NUMERIC(15,3) NOT NULL CHECK (requested_quantity > 0),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (return_id, invoice_line_id)
);

CREATE INDEX idx_return_items_return_id       ON public.return_items (return_id);
CREATE INDEX idx_return_items_invoice_line_id ON public.return_items (invoice_line_id);

COMMENT ON TABLE public.return_items IS
  'Baris retur per invoice_line (Gate 2F). Immutable penuh (trg_return_items_immutable). requested_quantity divalidasi <= invoice_lines.quantity pada INSERT (trg_return_items_tenant, sanity bound per baris) -- batas KUMULATIF lintas retur (invariant #6/#15) ditegakkan verify_return_atomic() pada approval, bukan di sini.';

-- ---------------------------------------------------------------------------
-- 3. credit_notes -- credit note header, immutable penuh. 1:1 dengan
--    return_id (UNIQUE) -- "satu retur terverifikasi hanya satu credit note".
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_notes (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  return_id                UUID          NOT NULL UNIQUE REFERENCES public.returns (id) ON DELETE RESTRICT,
  invoice_id                UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  customer_id                UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  total_amount                 NUMERIC(15,2) NOT NULL CHECK (total_amount > 0),
  applied_amount                 NUMERIC(15,2) NOT NULL CHECK (applied_amount >= 0),
  customer_credit_amount           NUMERIC(15,2) NOT NULL CHECK (customer_credit_amount >= 0),
  receivable_ledger_id                UUID          UNIQUE REFERENCES public.receivable_ledger (id) ON DELETE RESTRICT,
  approved_by                           UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at                             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (total_amount = applied_amount + customer_credit_amount),
  CHECK ((applied_amount = 0 AND receivable_ledger_id IS NULL) OR (applied_amount > 0 AND receivable_ledger_id IS NOT NULL))
);

CREATE INDEX idx_credit_notes_company_id ON public.credit_notes (company_id, created_at DESC);
CREATE INDEX idx_credit_notes_invoice_id ON public.credit_notes (invoice_id);

COMMENT ON TABLE public.credit_notes IS
  'Credit note header (Gate 2F) -- immutable penuh (trg_credit_notes_immutable). return_id UNIQUE menegakkan "satu retur terverifikasi hanya satu credit note" (invariant #11) secara STRUKTURAL (bukan hanya prosedural di RPC). total_amount dihitung server-side dari invoice_lines (invariant #5). applied_amount = LEAST(total_amount, outstanding_balance saat approval) (invariant #9); customer_credit_amount = sisanya (invariant #10, TIDAK PERNAH memicu refund). receivable_ledger_id NULL jika applied_amount=0 (invoice sudah lunas -- TIDAK ADA ledger credit nol/palsu).';

-- ---------------------------------------------------------------------------
-- 4. credit_note_lines -- baris credit note per return_item, immutable.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_note_lines (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id    UUID          NOT NULL REFERENCES public.credit_notes (id) ON DELETE CASCADE,
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  return_item_id    UUID          NOT NULL REFERENCES public.return_items (id) ON DELETE RESTRICT,
  invoice_line_id   UUID          NOT NULL REFERENCES public.invoice_lines (id) ON DELETE RESTRICT,
  quantity          NUMERIC(15,3) NOT NULL CHECK (quantity > 0),
  line_amount       NUMERIC(15,2) NOT NULL CHECK (line_amount > 0),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (credit_note_id, return_item_id)
);

CREATE INDEX idx_credit_note_lines_credit_note_id  ON public.credit_note_lines (credit_note_id);
CREATE INDEX idx_credit_note_lines_invoice_line_id ON public.credit_note_lines (invoice_line_id);

COMMENT ON TABLE public.credit_note_lines IS
  'Baris credit note per return_item (Gate 2F) -- immutable penuh (trg_credit_note_lines_immutable). quantity WAJIB sama dengan return_items.requested_quantity (trg_credit_note_lines_tenant); line_amount = quantity * (invoice_lines.line_total / invoice_lines.quantity), proporsi net setelah diskon (invariant #5, dihitung verify_return_atomic()).';

-- ---------------------------------------------------------------------------
-- 5. credit_note_reversals -- event reversal, immutable. 1:1 dengan
--    credit_note_id (UNIQUE) -- idempotent secara STRUKTURAL.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_note_reversals (
  id                              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  credit_note_id                  UUID          NOT NULL UNIQUE REFERENCES public.credit_notes (id) ON DELETE RESTRICT,
  receivable_ledger_id             UUID          UNIQUE REFERENCES public.receivable_ledger (id) ON DELETE RESTRICT,
  reversed_amount                    NUMERIC(15,2) NOT NULL CHECK (reversed_amount >= 0),
  customer_credit_voided_amount        NUMERIC(15,2) NOT NULL CHECK (customer_credit_voided_amount >= 0),
  actor_id                                UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  reason                                    TEXT          CHECK (reason IS NULL OR length(trim(reason)) > 0),
  idempotency_key                             TEXT,
  created_at                                   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK ((reversed_amount = 0 AND receivable_ledger_id IS NULL) OR (reversed_amount > 0 AND receivable_ledger_id IS NOT NULL)),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_credit_note_reversals_company_id ON public.credit_note_reversals (company_id, created_at DESC);

COMMENT ON TABLE public.credit_note_reversals IS
  'Event reversal credit note (Gate 2F) -- immutable penuh (trg_credit_note_reversals_immutable). credit_note_id UNIQUE menjamin idempotency STRUKTURAL (invariant #17 test matrix "double reversal idempotent") -- reverse_credit_note_atomic() SELALU mengembalikan baris pertama pada percobaan kedua, tidak pernah menulis lagi. reversed_amount = credit_notes.applied_amount pada saat reversal (compensating debit, invariant #12 -- TIDAK PERNAH menghapus/mengubah credit_notes/receivable_ledger lama). customer_credit_voided_amount = credit_notes.customer_credit_amount (catatan audit pembatalan residual -- lihat catatan desain migration di atas untuk limitation).';

-- ---------------------------------------------------------------------------
-- 6. Immutability.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_return_invalid_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RETURN_IMMUTABLE: return % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.company_id      IS DISTINCT FROM OLD.company_id
     OR NEW.customer_id     IS DISTINCT FROM OLD.customer_id
     OR NEW.invoice_id         IS DISTINCT FROM OLD.invoice_id
     OR NEW.sales_order_id        IS DISTINCT FROM OLD.sales_order_id
     OR NEW.delivery_id               IS DISTINCT FROM OLD.delivery_id
     OR NEW.reason_code                  IS DISTINCT FROM OLD.reason_code
     OR NEW.proof_reference                 IS DISTINCT FROM OLD.proof_reference
     OR NEW.requested_by                       IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at                          IS DISTINCT FROM OLD.requested_at
     OR NEW.request_payload                          IS DISTINCT FROM OLD.request_payload
     OR NEW.idempotency_key                             IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at                                     IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'RETURN_TERMS_IMMUTABLE: data retur % tidak dapat diubah setelah dibuat -- hanya status/decided_by/decided_at yang boleh bertransisi', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'RETURN_ALREADY_RESOLVED: return % sudah berstatus % (final), tidak dapat diverifikasi lagi', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'RETURN_INVALID_TRANSITION: transisi status % -> % tidak diizinkan', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.decided_by IS NULL OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'RETURN_DECISION_METADATA_REQUIRED: decided_by/decided_at wajib diisi saat verifikasi return %', OLD.id
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_returns_immutable ON public.returns;
CREATE TRIGGER trg_returns_immutable
  BEFORE UPDATE OR DELETE ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.prevent_return_invalid_mutation();

CREATE OR REPLACE FUNCTION public.prevent_return_item_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RETURN_ITEM_IMMUTABLE: return_item % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'RETURN_ITEM_IMMUTABLE: return_item % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_return_items_immutable ON public.return_items;
CREATE TRIGGER trg_return_items_immutable
  BEFORE UPDATE OR DELETE ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public.prevent_return_item_mutation();

CREATE OR REPLACE FUNCTION public.prevent_credit_note_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE: credit_note % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'CREDIT_NOTE_IMMUTABLE: credit_note % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_credit_notes_immutable ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_immutable
  BEFORE UPDATE OR DELETE ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.prevent_credit_note_mutation();

CREATE OR REPLACE FUNCTION public.prevent_credit_note_line_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CREDIT_NOTE_LINE_IMMUTABLE: credit_note_line % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'CREDIT_NOTE_LINE_IMMUTABLE: credit_note_line % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_credit_note_lines_immutable ON public.credit_note_lines;
CREATE TRIGGER trg_credit_note_lines_immutable
  BEFORE UPDATE OR DELETE ON public.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_credit_note_line_mutation();

CREATE OR REPLACE FUNCTION public.prevent_credit_note_reversal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CREDIT_NOTE_REVERSAL_IMMUTABLE: credit_note_reversal % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'CREDIT_NOTE_REVERSAL_IMMUTABLE: credit_note_reversal % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_credit_note_reversals_immutable ON public.credit_note_reversals;
CREATE TRIGGER trg_credit_note_reversals_immutable
  BEFORE UPDATE OR DELETE ON public.credit_note_reversals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_credit_note_reversal_mutation();

-- ---------------------------------------------------------------------------
-- 7. Tenant/consistency validation (BEFORE INSERT) -- lapisan kedua,
--    independen dari kebenaran RPC (pola sama dengan Gate 2A-2E).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_return_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
  v_requester_company UUID;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_invoice.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'RETURN_CUSTOMER_MISMATCH: customer_id harus sama dengan invoices.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_invoice.sales_order_id <> NEW.sales_order_id THEN
    RAISE EXCEPTION 'RETURN_ORDER_MISMATCH: sales_order_id harus sama dengan invoices.sales_order_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_invoice.delivery_id <> NEW.delivery_id THEN
    RAISE EXCEPTION 'RETURN_DELIVERY_MISMATCH: delivery_id harus sama dengan invoices.delivery_id'
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

DROP TRIGGER IF EXISTS trg_returns_tenant ON public.returns;
CREATE TRIGGER trg_returns_tenant
  BEFORE INSERT ON public.returns
  FOR EACH ROW EXECUTE FUNCTION public.validate_return_tenant();

CREATE OR REPLACE FUNCTION public.validate_return_item_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_return       public.returns%ROWTYPE;
  v_line         public.invoice_lines%ROWTYPE;
BEGIN
  SELECT * INTO v_return FROM public.returns WHERE id = NEW.return_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND: %', NEW.return_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_return.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: return % bukan milik company %', NEW.return_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_line FROM public.invoice_lines WHERE id = NEW.invoice_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_LINE_NOT_FOUND: %', NEW.invoice_line_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_line.invoice_id <> v_return.invoice_id THEN
    RAISE EXCEPTION 'RETURN_ITEM_INVOICE_MISMATCH: invoice_line % bukan milik invoice % pada return %', NEW.invoice_line_id, v_return.invoice_id, NEW.return_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_line.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice_line % bukan milik company %', NEW.invoice_line_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.requested_quantity > v_line.quantity THEN
    RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_INVOICED: requested_quantity % melebihi invoice_lines.quantity % pada baris %', NEW.requested_quantity, v_line.quantity, NEW.invoice_line_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_return_items_tenant ON public.return_items;
CREATE TRIGGER trg_return_items_tenant
  BEFORE INSERT ON public.return_items
  FOR EACH ROW EXECUTE FUNCTION public.validate_return_item_tenant();

CREATE OR REPLACE FUNCTION public.validate_credit_note_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_return public.returns%ROWTYPE;
  v_ledger public.receivable_ledger%ROWTYPE;
BEGIN
  SELECT * INTO v_return FROM public.returns WHERE id = NEW.return_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND: %', NEW.return_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_return.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: return % bukan milik company %', NEW.return_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_return.invoice_id <> NEW.invoice_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_INVOICE_MISMATCH: invoice_id credit_note harus sama dengan return.invoice_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_return.customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_CUSTOMER_MISMATCH: customer_id credit_note harus sama dengan return.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.receivable_ledger_id IS NOT NULL THEN
    SELECT * INTO v_ledger FROM public.receivable_ledger WHERE id = NEW.receivable_ledger_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECEIVABLE_LEDGER_ENTRY_NOT_FOUND: %', NEW.receivable_ledger_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_ledger.entry_type <> 'credit_note' OR v_ledger.direction <> 'credit' THEN
      RAISE EXCEPTION 'CREDIT_NOTE_LEDGER_TYPE_MISMATCH: receivable_ledger % harus entry_type=credit_note/direction=credit', NEW.receivable_ledger_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_ledger.invoice_id <> NEW.invoice_id OR v_ledger.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'CREDIT_NOTE_LEDGER_INVOICE_MISMATCH: receivable_ledger % tidak terkait invoice %', NEW.receivable_ledger_id, NEW.invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_ledger.amount <> NEW.applied_amount THEN
      RAISE EXCEPTION 'CREDIT_NOTE_LEDGER_AMOUNT_MISMATCH: applied_amount % tidak sama dengan credit ledger %', NEW.applied_amount, v_ledger.amount
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_credit_notes_tenant ON public.credit_notes;
CREATE TRIGGER trg_credit_notes_tenant
  BEFORE INSERT ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.validate_credit_note_tenant();

CREATE OR REPLACE FUNCTION public.validate_credit_note_line_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_credit_note public.credit_notes%ROWTYPE;
  v_item        public.return_items%ROWTYPE;
BEGIN
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = NEW.credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', NEW.credit_note_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_credit_note.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: credit_note % bukan milik company %', NEW.credit_note_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_item FROM public.return_items WHERE id = NEW.return_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_ITEM_NOT_FOUND: %', NEW.return_item_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_item.return_id <> v_credit_note.return_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_LINE_RETURN_MISMATCH: return_item % bukan milik return % pada credit_note %', NEW.return_item_id, v_credit_note.return_id, NEW.credit_note_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_item.invoice_line_id <> NEW.invoice_line_id THEN
    RAISE EXCEPTION 'CREDIT_NOTE_LINE_ITEM_MISMATCH: invoice_line_id % tidak sama dengan return_item %', NEW.invoice_line_id, NEW.return_item_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.quantity <> v_item.requested_quantity THEN
    RAISE EXCEPTION 'CREDIT_NOTE_LINE_QUANTITY_MISMATCH: quantity % harus sama dengan return_items.requested_quantity %', NEW.quantity, v_item.requested_quantity
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_credit_note_lines_tenant ON public.credit_note_lines;
CREATE TRIGGER trg_credit_note_lines_tenant
  BEFORE INSERT ON public.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_credit_note_line_tenant();

CREATE OR REPLACE FUNCTION public.validate_credit_note_reversal_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_credit_note public.credit_notes%ROWTYPE;
  v_ledger      public.receivable_ledger%ROWTYPE;
  v_actor_company UUID;
BEGIN
  SELECT * INTO v_credit_note FROM public.credit_notes WHERE id = NEW.credit_note_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CREDIT_NOTE_NOT_FOUND: %', NEW.credit_note_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_credit_note.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: credit_note % bukan milik company %', NEW.credit_note_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_credit_note.applied_amount <> NEW.reversed_amount THEN
    RAISE EXCEPTION 'REVERSAL_AMOUNT_MISMATCH: reversed_amount % harus sama dengan credit_notes.applied_amount %', NEW.reversed_amount, v_credit_note.applied_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_credit_note.customer_credit_amount <> NEW.customer_credit_voided_amount THEN
    RAISE EXCEPTION 'REVERSAL_CUSTOMER_CREDIT_MISMATCH: customer_credit_voided_amount % harus sama dengan credit_notes.customer_credit_amount %', NEW.customer_credit_voided_amount, v_credit_note.customer_credit_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id INTO v_actor_company FROM public.users WHERE id = NEW.actor_id;
  IF v_actor_company IS NULL THEN
    RAISE EXCEPTION 'ACTOR_NOT_FOUND: %', NEW.actor_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_actor_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: actor % bukan milik company %', NEW.actor_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.receivable_ledger_id IS NOT NULL THEN
    SELECT * INTO v_ledger FROM public.receivable_ledger WHERE id = NEW.receivable_ledger_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'RECEIVABLE_LEDGER_ENTRY_NOT_FOUND: %', NEW.receivable_ledger_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_ledger.entry_type <> 'credit_note_reversal' OR v_ledger.direction <> 'debit' THEN
      RAISE EXCEPTION 'REVERSAL_LEDGER_TYPE_MISMATCH: receivable_ledger % harus entry_type=credit_note_reversal/direction=debit', NEW.receivable_ledger_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_ledger.invoice_id <> v_credit_note.invoice_id OR v_ledger.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'REVERSAL_LEDGER_INVOICE_MISMATCH: receivable_ledger % tidak terkait invoice %', NEW.receivable_ledger_id, v_credit_note.invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_ledger.amount <> NEW.reversed_amount THEN
      RAISE EXCEPTION 'REVERSAL_LEDGER_AMOUNT_MISMATCH: reversed_amount % tidak sama dengan debit ledger %', NEW.reversed_amount, v_ledger.amount
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_credit_note_reversals_tenant ON public.credit_note_reversals;
CREATE TRIGGER trg_credit_note_reversals_tenant
  BEFORE INSERT ON public.credit_note_reversals
  FOR EACH ROW EXECUTE FUNCTION public.validate_credit_note_reversal_tenant();

-- ---------------------------------------------------------------------------
-- 7b. Pairing invariant -- ledger credit/debit yang lahir dari retur (entry_
--     type IN ('credit_note','credit_note_reversal')) WAJIB berpasangan
--     dengan TEPAT SATU credit_notes/credit_note_reversals yang menunjuknya.
--     Pola identik enforce_payment_allocation_ledger_pairing (Gate 2D) --
--     constraint trigger AFTER INSERT DEFERRABLE INITIALLY DEFERRED supaya
--     verify_return_atomic()/reverse_credit_note_atomic() tetap bisa INSERT
--     ledger LEBIH DULU baru credit_notes/credit_note_reversals dalam
--     transaksi yang sama -- lihat catatan Gate 2D migration 20260829000001
--     untuk root cause lengkap (kenapa BEFORE INSERT trigger pada
--     receivable_ledger sendiri tidak bisa menutup celah orphan credit ini).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_return_ledger_pairing()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.entry_type = 'credit_note' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE receivable_ledger_id = NEW.id) THEN
      RAISE EXCEPTION 'ORPHAN_CREDIT_NOTE_LEDGER_CREDIT: receivable_ledger % (entry_type=credit_note) wajib memiliki tepat satu credit_notes yang menunjuknya', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.entry_type = 'credit_note_reversal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_note_reversals WHERE receivable_ledger_id = NEW.id) THEN
      RAISE EXCEPTION 'ORPHAN_CREDIT_NOTE_REVERSAL_LEDGER_DEBIT: receivable_ledger % (entry_type=credit_note_reversal) wajib memiliki tepat satu credit_note_reversals yang menunjuknya', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.enforce_return_ledger_pairing IS
  'Constraint trigger DEFERRABLE INITIALLY DEFERRED pada receivable_ledger -- entry_type=credit_note wajib punya tepat satu credit_notes yang menunjuknya; entry_type=credit_note_reversal wajib punya tepat satu credit_note_reversals yang menunjuknya, keduanya diperiksa pada COMMIT. Menutup celah bare/orphan credit/debit langsung, independen dari RLS/service_role trust (pola identik Gate 2D).';

DROP TRIGGER IF EXISTS trg_receivable_ledger_return_pairing ON public.receivable_ledger;
CREATE CONSTRAINT TRIGGER trg_receivable_ledger_return_pairing
  AFTER INSERT ON public.receivable_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_return_ledger_pairing();

-- ---------------------------------------------------------------------------
-- 8. Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('return.request', 'return', 'request', 'Mengajukan retur dengan bukti terhadap invoice milik company sendiri'),
  ('return.verify', 'return', 'verify', 'Memverifikasi (approve/reject) retur dan menerbitkan credit note -- Owner only'),
  ('credit_note.reverse', 'credit_note', 'reverse', 'Membalik (compensating) credit note yang sudah diterapkan ke piutang -- Owner only')
ON CONFLICT (name) DO NOTHING;

-- return.request disamakan containment invoice.issue/collection.record
-- (Gate 2B/2C) -- owner/manager/admin/super_admin/finance, BUKAN sales.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')
  AND p.name = 'return.request'
ON CONFLICT DO NOTHING;

-- return.verify/credit_note.reverse: HANYA owner (instruksi gate eksplisit
-- "Owner-only") -- LEBIH SEMPIT dari payment.record/payment.reconcile
-- (Gate 2D/2E) yang masih mengizinkan finance.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name = 'owner'
  AND p.name IN ('return.verify', 'credit_note.reverse')
ON CONFLICT DO NOTHING;

ALTER TABLE public.returns               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_notes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_note_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_note_reversals ENABLE ROW LEVEL SECURITY;

-- SELECT-only, reuse 'receivable.view' (Gate 2A) -- pola sama dengan Gate
-- 2C/2D/2E. Tidak ada policy INSERT/UPDATE/DELETE untuk siapa pun, diperkuat
-- REVOKE eksplisit di bawah.
CREATE POLICY "returns_select" ON public.returns
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "return_items_select" ON public.return_items
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "credit_notes_select" ON public.credit_notes
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "credit_note_lines_select" ON public.credit_note_lines
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "credit_note_reversals_select" ON public.credit_note_reversals
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.returns, public.return_items, public.credit_notes, public.credit_note_lines, public.credit_note_reversals
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.returns, public.return_items, public.credit_notes, public.credit_note_lines, public.credit_note_reversals TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. RPC canonical -- request_return_atomic().
--    Satu-satunya jalur resmi membuat retur berstatus 'requested'. TIDAK
--    menyentuh credit_notes/receivable_ledger/payment/reconciliation/invoice
--    sama sekali.
--
--    p_items: JSONB array [{ "invoice_line_id": UUID, "requested_quantity":
--             NUMERIC }, ...] -- minimal 1 elemen, invoice_line_id tidak
--             boleh duplikat dalam satu retur.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.request_return_atomic(
  p_company_id        UUID,
  p_actor_id          UUID,
  p_invoice_id        UUID,
  p_items             JSONB,
  p_reason_code       TEXT,
  p_proof_reference   TEXT,
  p_idempotency_key   TEXT DEFAULT NULL
) RETURNS TABLE(
  out_return_id       UUID,
  out_status          VARCHAR,
  out_already_exists  BOOLEAN
) AS $$
DECLARE
  v_request_payload    JSONB;
  v_existing           public.returns%ROWTYPE;
  v_actor_allowed      BOOLEAN;
  v_invoice            public.invoices%ROWTYPE;
  v_total_count        INTEGER;
  v_distinct_count     INTEGER;
  v_return_id          UUID;
  v_item_elem          JSONB;
  v_item_line_id       UUID;
  v_item_quantity      NUMERIC(15,3);
  v_inserted_items     INTEGER;
BEGIN
  -- -------------------------------------------------------------------------
  -- A. Validasi struktural.
  -- -------------------------------------------------------------------------
  IF p_reason_code IS NULL OR length(trim(p_reason_code)) = 0 THEN
    RAISE EXCEPTION 'REASON_CODE_REQUIRED: retur wajib menyertakan reason_code' USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_proof_reference IS NULL OR length(trim(p_proof_reference)) = 0 THEN
    RAISE EXCEPTION 'PROOF_REQUIRED: retur wajib menyertakan proof_reference' USING ERRCODE = 'not_null_violation';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'ITEMS_REQUIRED: retur wajib menyertakan minimal satu item' USING ERRCODE = 'not_null_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) elem
    WHERE elem->>'invoice_line_id' IS NULL OR elem->>'requested_quantity' IS NULL OR (elem->>'requested_quantity')::NUMERIC <= 0
  ) THEN
    RAISE EXCEPTION 'INVALID_ITEM_QUANTITY: setiap item wajib memiliki invoice_line_id dan requested_quantity > 0' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT elem->>'invoice_line_id') INTO v_total_count, v_distinct_count
  FROM jsonb_array_elements(p_items) elem;
  IF v_total_count <> v_distinct_count THEN
    RAISE EXCEPTION 'DUPLICATE_INVOICE_LINE_IN_RETURN: satu invoice_line tidak boleh muncul lebih dari sekali dalam satu retur' USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Snapshot request kanonik (urutan dinormalisasi) -- idempotency payload.
  -- -------------------------------------------------------------------------
  SELECT jsonb_build_object(
    'invoiceId', p_invoice_id,
    'reasonCode', p_reason_code,
    'proofReference', p_proof_reference,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'invoiceLineId', elem->>'invoice_line_id', 'requestedQuantity', (elem->>'requested_quantity')::NUMERIC
      ) ORDER BY elem->>'invoice_line_id')
      FROM jsonb_array_elements(p_items) elem
    ), '[]'::jsonb)
  ) INTO v_request_payload;

  -- -------------------------------------------------------------------------
  -- C. Idempotency.
  -- -------------------------------------------------------------------------
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.returns
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
      AND perm.name = 'return.request'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission return.request pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- E. Lock + validasi invoice canonical.
  -- -------------------------------------------------------------------------
  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', p_invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', p_invoice_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- F. Validasi setiap item WAJIB milik invoice ini + kuantitas sanity bound
  --    (trg_return_items_tenant memvalidasi ulang independen di bawah).
  -- -------------------------------------------------------------------------
  FOR v_item_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_item_line_id := (v_item_elem->>'invoice_line_id')::UUID;
    IF NOT EXISTS (SELECT 1 FROM public.invoice_lines WHERE id = v_item_line_id AND invoice_id = p_invoice_id) THEN
      RAISE EXCEPTION 'INVOICE_LINE_NOT_IN_INVOICE: invoice_line % bukan milik invoice %', v_item_line_id, p_invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- G. Insert returns + return_items.
  -- -------------------------------------------------------------------------
  INSERT INTO public.returns (
    company_id, customer_id, invoice_id, sales_order_id, delivery_id,
    reason_code, proof_reference, requested_by, request_payload, idempotency_key
  ) VALUES (
    p_company_id, v_invoice.customer_id, p_invoice_id, v_invoice.sales_order_id, v_invoice.delivery_id,
    p_reason_code, p_proof_reference, p_actor_id, v_request_payload, p_idempotency_key
  ) RETURNING id INTO v_return_id;

  FOR v_item_elem IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_item_line_id := (v_item_elem->>'invoice_line_id')::UUID;
    v_item_quantity := (v_item_elem->>'requested_quantity')::NUMERIC;
    INSERT INTO public.return_items (return_id, company_id, invoice_line_id, requested_quantity)
    VALUES (v_return_id, p_company_id, v_item_line_id, v_item_quantity);
  END LOOP;

  SELECT COUNT(*) INTO v_inserted_items FROM public.return_items WHERE return_id = v_return_id;
  IF v_inserted_items <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'RETURN_ITEM_MATERIALIZATION_INCOMPLETE: return % mengharapkan % item, hanya % ter-insert', v_return_id, jsonb_array_length(p_items), v_inserted_items
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- H. Audit canonical.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'return.requested', 'returns', v_return_id,
    jsonb_build_object(
      'return_id', v_return_id, 'invoice_id', p_invoice_id, 'customer_id', v_invoice.customer_id,
      'items', v_request_payload->'items', 'reason_code', p_reason_code, 'proof_reference', p_proof_reference,
      'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_return_id, 'requested'::VARCHAR, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.request_return_atomic IS
  'Satu-satunya jalur resmi membuat retur (status=requested). Atomic: returns + return_items + audit dalam SATU transaksi. Menolak: REASON_CODE_REQUIRED, PROOF_REQUIRED, ITEMS_REQUIRED/INVALID_ITEM_QUANTITY, DUPLICATE_INVOICE_LINE_IN_RETURN, IDEMPOTENCY_KEY_PAYLOAD_MISMATCH, FORBIDDEN (permission return.request), INVOICE_NOT_FOUND, TENANT_CONTEXT_MISMATCH, INVOICE_LINE_NOT_IN_INVOICE. TIDAK PERNAH menyentuh credit_notes/receivable_ledger/payment/reconciliation/invoice (invariant #3 gate -- retur requested tidak mengurangi piutang). customer_id/sales_order_id/delivery_id diturunkan server-side dari invoice, bukan parameter caller. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.request_return_atomic(UUID, UUID, UUID, JSONB, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_return_atomic(UUID, UUID, UUID, JSONB, TEXT, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 10. RPC canonical -- verify_return_atomic().
--     Owner-only. p_decision IN ('approve','reject'). Reject: tandai
--     rejected, TANPA efek finansial apa pun. Approve: lock invoice, validasi
--     kuantitas kumulatif per invoice_line, hitung nilai dari invoice_lines
--     immutable, buat credit_notes+credit_note_lines, insert ledger credit
--     (jika applied_amount>0) SEBELUM credit_notes (supaya pairing invariant
--     DEFERRED terpenuhi pada COMMIT), transisi returns.status='approved'.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.verify_return_atomic(
  p_company_id  UUID,
  p_actor_id    UUID,
  p_return_id   UUID,
  p_decision    TEXT
) RETURNS TABLE(
  out_return_id                  UUID,
  out_status                     VARCHAR,
  out_credit_note_id              UUID,
  out_total_amount                 NUMERIC,
  out_applied_amount                 NUMERIC,
  out_customer_credit_amount           NUMERIC
) AS $$
DECLARE
  v_actor_allowed        BOOLEAN;
  v_return               public.returns%ROWTYPE;
  v_invoice              public.invoices%ROWTYPE;
  v_item                 RECORD;
  v_line                 public.invoice_lines%ROWTYPE;
  v_already_credited     NUMERIC(15,3);
  v_remaining            NUMERIC(15,3);
  v_line_amount           NUMERIC(15,2);
  v_total_credit          NUMERIC(15,2) := 0;
  v_outstanding             NUMERIC(15,2);
  v_applied_amount            NUMERIC(15,2);
  v_customer_credit              NUMERIC(15,2);
  v_credit_note_id                UUID;
  v_ledger_id                        UUID;
  v_balance_before                     NUMERIC(15,2);
  v_balance_after                         NUMERIC(15,2);
  v_line_credits                            JSONB := '[]'::jsonb;
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
      AND perm.name = 'return.verify'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission return.verify pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- B. Lock return -- menyerialisasi double/concurrent decision pada return
  --    yang SAMA (percobaan kedua melihat status sudah bukan 'requested').
  -- -------------------------------------------------------------------------
  SELECT * INTO v_return FROM public.returns WHERE id = p_return_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RETURN_NOT_FOUND: %', p_return_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_return.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: return % bukan milik company %', p_return_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_return.status <> 'requested' THEN
    RAISE EXCEPTION 'RETURN_ALREADY_RESOLVED: return % sudah berstatus %', p_return_id, v_return.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- C. Reject -- tanpa efek finansial apa pun.
  -- -------------------------------------------------------------------------
  IF p_decision = 'reject' THEN
    UPDATE public.returns SET status = 'rejected', decided_by = p_actor_id, decided_at = NOW() WHERE id = p_return_id;

    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, old_data, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'return.rejected', 'returns', p_return_id,
      jsonb_build_object('status', 'requested'),
      jsonb_build_object('status', 'rejected', 'return_id', p_return_id, 'invoice_id', v_return.invoice_id),
      NULL, 'audit', 'finance', 'web', 'success'
    );

    RETURN QUERY SELECT p_return_id, 'rejected'::VARCHAR, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- D. Approve -- lock invoice (menyerialisasi approval retur lain pada
  --    invoice yang sama, mencegah over-credit lintas retur paralel).
  -- -------------------------------------------------------------------------
  SELECT * INTO v_invoice FROM public.invoices WHERE id = v_return.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', v_return.invoice_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Hitung nilai kredit per item dari invoice_lines immutable (invariant #5) --
  -- proporsi line_total (net setelah diskon) sesuai kuantitas dikreditkan.
  -- Validasi kumulatif (invariant #6/#15): SUM(credit_note_lines.quantity
  -- existing) + requested_quantity tidak boleh melebihi invoice_lines.quantity.
  FOR v_item IN SELECT * FROM public.return_items WHERE return_id = p_return_id LOOP
    SELECT * INTO v_line FROM public.invoice_lines WHERE id = v_item.invoice_line_id;

    SELECT COALESCE(SUM(cnl.quantity), 0) INTO v_already_credited
    FROM public.credit_note_lines cnl WHERE cnl.invoice_line_id = v_item.invoice_line_id;

    v_remaining := v_line.quantity - v_already_credited;
    IF v_item.requested_quantity > v_remaining THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_CREDITABLE: requested_quantity % melebihi sisa creditable % pada invoice_line % (invoice_lines.quantity=%, sudah dikredit=%)', v_item.requested_quantity, v_remaining, v_item.invoice_line_id, v_line.quantity, v_already_credited
        USING ERRCODE = 'check_violation';
    END IF;

    v_line_amount := ROUND(v_item.requested_quantity * (v_line.line_total / v_line.quantity), 2);
    v_total_credit := v_total_credit + v_line_amount;

    v_line_credits := v_line_credits || jsonb_build_array(jsonb_build_object(
      'returnItemId', v_item.id, 'invoiceLineId', v_item.invoice_line_id,
      'quantity', v_item.requested_quantity, 'lineAmount', v_line_amount
    ));
  END LOOP;

  IF v_total_credit <= 0 THEN
    RAISE EXCEPTION 'RETURN_NO_CREDITABLE_ITEMS: return % tidak memiliki item yang menghasilkan nilai kredit', p_return_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) - COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
  INTO v_outstanding
  FROM public.receivable_ledger WHERE invoice_id = v_invoice.id;

  v_balance_before := v_outstanding;
  v_applied_amount := LEAST(v_total_credit, v_outstanding);
  v_customer_credit := v_total_credit - v_applied_amount;
  v_balance_after := v_balance_before - v_applied_amount;

  -- Ledger credit HANYA jika applied_amount > 0 -- insert SEBELUM credit_notes
  -- supaya pairing invariant DEFERRED (section 7b) terpenuhi pada COMMIT.
  IF v_applied_amount > 0 THEN
    INSERT INTO public.receivable_ledger (company_id, invoice_id, entry_type, direction, amount, created_by)
    VALUES (p_company_id, v_invoice.id, 'credit_note', 'credit', v_applied_amount, p_actor_id)
    RETURNING id INTO v_ledger_id;
  ELSE
    v_ledger_id := NULL;
  END IF;

  INSERT INTO public.credit_notes (
    company_id, return_id, invoice_id, customer_id, total_amount, applied_amount, customer_credit_amount, receivable_ledger_id, approved_by
  ) VALUES (
    p_company_id, p_return_id, v_invoice.id, v_return.customer_id, v_total_credit, v_applied_amount, v_customer_credit, v_ledger_id, p_actor_id
  ) RETURNING id INTO v_credit_note_id;

  FOR v_item IN
    SELECT ri.id AS return_item_id, ri.invoice_line_id, ri.requested_quantity,
           (SELECT (elem->>'lineAmount')::NUMERIC FROM jsonb_array_elements(v_line_credits) elem WHERE (elem->>'returnItemId')::UUID = ri.id) AS line_amount
    FROM public.return_items ri WHERE ri.return_id = p_return_id
  LOOP
    INSERT INTO public.credit_note_lines (credit_note_id, company_id, return_item_id, invoice_line_id, quantity, line_amount)
    VALUES (v_credit_note_id, p_company_id, v_item.return_item_id, v_item.invoice_line_id, v_item.requested_quantity, v_item.line_amount);
  END LOOP;

  UPDATE public.returns SET status = 'approved', decided_by = p_actor_id, decided_at = NOW() WHERE id = p_return_id;

  -- -------------------------------------------------------------------------
  -- E. Audit canonical -- return.approved, credit_note.issued, dan (jika
  --    applied_amount>0) credit_note.applied + receivable.adjusted.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'return.approved', 'returns', p_return_id,
    jsonb_build_object('status', 'requested'),
    jsonb_build_object('status', 'approved', 'return_id', p_return_id, 'invoice_id', v_invoice.id, 'credit_note_id', v_credit_note_id),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'credit_note.issued', 'credit_notes', v_credit_note_id,
    jsonb_build_object(
      'credit_note_id', v_credit_note_id, 'return_id', p_return_id, 'invoice_id', v_invoice.id,
      'total_amount', v_total_credit, 'applied_amount', v_applied_amount, 'customer_credit_amount', v_customer_credit,
      'lines', v_line_credits
    ),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  IF v_applied_amount > 0 THEN
    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'credit_note.applied', 'credit_notes', v_credit_note_id,
      jsonb_build_object(
        'credit_note_id', v_credit_note_id, 'invoice_id', v_invoice.id, 'applied_amount', v_applied_amount,
        'balance_before', v_balance_before, 'balance_after', v_balance_after
      ),
      NULL, 'audit', 'finance', 'web', 'success'
    );

    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id, p_actor_id, 'receivable.adjusted', 'receivable_ledger', v_ledger_id,
      jsonb_build_object(
        'invoice_id', v_invoice.id, 'entry_type', 'credit_note', 'amount', v_applied_amount,
        'balance_before', v_balance_before, 'balance_after', v_balance_after, 'credit_note_id', v_credit_note_id
      ),
      NULL, 'audit', 'finance', 'web', 'success'
    );
  END IF;

  RETURN QUERY SELECT p_return_id, 'approved'::VARCHAR, v_credit_note_id, v_total_credit, v_applied_amount, v_customer_credit;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.verify_return_atomic IS
  'Owner-only. Reject: tandai returns.status=rejected, TANPA credit_note/ledger entry apa pun. Approve: lock return (serialize double/concurrent decision -- RETURN_ALREADY_RESOLVED pada percobaan kedua) + lock invoice (serialize approval retur lain pada invoice sama), validasi kuantitas kumulatif per invoice_line (RETURN_QUANTITY_EXCEEDS_CREDITABLE), hitung nilai dari invoice_lines immutable, applied_amount=LEAST(total,outstanding), customer_credit_amount=sisanya, INSERT ledger credit (jika applied_amount>0) SEBELUM credit_notes, lalu credit_notes+credit_note_lines+transisi status dalam SATU transaksi. Menolak: INVALID_DECISION, FORBIDDEN (permission return.verify, HANYA owner), RETURN_NOT_FOUND, TENANT_CONTEXT_MISMATCH, RETURN_ALREADY_RESOLVED, RETURN_QUANTITY_EXCEEDS_CREDITABLE, RETURN_NO_CREDITABLE_ITEMS. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.verify_return_atomic(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_return_atomic(UUID, UUID, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 11. RPC canonical -- reverse_credit_note_atomic().
--     Owner-only dan idempotent (credit_note_reversals.credit_note_id UNIQUE
--     -- percobaan kedua SELALU mengembalikan hasil pertama, tidak pernah
--     menulis lagi/gagal). TIDAK PERNAH menghapus/mengubah credit_notes/
--     receivable_ledger lama -- compensating debit baru saja (invariant #12).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_credit_note_atomic(
  p_company_id      UUID,
  p_actor_id        UUID,
  p_credit_note_id  UUID,
  p_reason          TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS TABLE(
  out_reversal_id                    UUID,
  out_credit_note_id                    UUID,
  out_reversed_amount                      NUMERIC,
  out_customer_credit_voided_amount           NUMERIC,
  out_already_exists                             BOOLEAN
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
  -- D. Compensating debit -- HANYA jika applied_amount > 0 (kalau tidak,
  --    tidak pernah ada ledger credit untuk dibalik).
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
  -- E. Audit canonical.
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
  'Owner-only dan idempotent (credit_note_reversals.credit_note_id UNIQUE -- percobaan kedua SELALU kembalikan hasil pertama). TIDAK PERNAH menghapus/mengubah credit_notes/receivable_ledger lama -- compensating debit baru (entry_type=credit_note_reversal) sebesar applied_amount (jika >0) dalam SATU transaksi dengan credit_note_reversals + audit. Menolak: FORBIDDEN (permission credit_note.reverse, HANYA owner), CREDIT_NOTE_NOT_FOUND, TENANT_CONTEXT_MISMATCH. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.reverse_credit_note_atomic(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_credit_note_atomic(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;
