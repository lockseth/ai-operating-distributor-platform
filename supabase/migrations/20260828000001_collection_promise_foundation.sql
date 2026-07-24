-- =============================================================================
-- Migration: Collection Activity & Promise-to-Pay Integrity (Gate 2C)
--
-- Membangun sumber fakta aktivitas penagihan dan janji bayar terhadap
-- invoice/piutang canonical (Gate 2A/2B). Alur gate ini:
--   Invoice canonical -> Collection attempt/outcome -> Promise to Pay
-- BUKAN:
--   Collection claim -> Payment -> Ledger credit
-- Payment dan pengurangan saldo BUKAN scope gate ini -- lihat catatan
-- "DEFERRED" di setiap section.
--
-- Dua tabel baru:
--   1. promises_to_pay       -- janji bayar (bisa sebagian) terhadap invoice.
--   2. collection_activities -- fakta aktivitas collection, append-only,
--                                termasuk jejak setiap mutasi promise.
-- promises_to_pay dibuat LEBIH DULU karena collection_activities.
-- promise_to_pay_id mereferensikannya.
--
-- Keputusan desain (audit existing Gate 2A/2B, BUKAN keputusan bisnis baru):
--   - Timezone: mengikuti pola issue_invoice_atomic (20260827000001) --
--     (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE. Tidak ada helper timezone
--     canonical terpisah di repo ini, jadi tidak ada yang di-reuse selain
--     pola literal yang sudah dipakai.
--   - Outcome vocabulary collection_activities SENGAJA melebihi 7 nilai
--     minimum instruksi gate (contacted_successfully/not_contactable/
--     not_paid_yet/promised_to_pay/dispute/claimed_paid_partial/
--     claimed_paid_full) -- instruksi eksplisit menyebut ini "minimum".
--     Tiga nilai tambahan (promise_corrected/promise_cancelled/
--     promise_broken) dipakai HANYA oleh RPC promise lifecycle secara
--     internal (bukan parameter client record_collection_activity) supaya
--     setiap mutasi promise (correct/cancel/broken) juga meninggalkan jejak
--     di collection_activities (instruksi gate 4B invariant #12: "Menulis
--     activity dan audit"), tanpa membuka celah client mem-forge outcome
--     "promise_*" tanpa promises_to_pay yang benar-benar ada (lihat guard
--     INVALID_OUTCOME_RESERVED pada record_collection_activity()).
--   - Status promises_to_pay SENGAJA TIDAK menyertakan 'fulfilled' sama
--     sekali pada gate ini (instruksi #17: "Jangan menyediakan transisi
--     manual ke fulfilled"; instruksi §4B: "Status fulfilled harus ditunda
--     sampai ada payment/allocation terverifikasi... Gate berikutnya boleh
--     memperluas constraint/status secara forward-only") -- pola identik
--     dengan receivable_ledger.entry_type yang HANYA 'invoice_issued' pada
--     Gate 2A dan diperluas via ALTER CHECK terpisah saat entitasnya lahir.
--   - Role mapping permission 'collection.record'/'collection.promise':
--     disamakan dengan 'receivable.view'/'invoice.issue' (owner, manager,
--     admin, super_admin, finance) -- TIDAK termasuk 'sales' (preseden
--     containment 20260825000001/20260827000001: sales tidak pernah
--     memegang aksi finansial invoice/piutang). Tidak ada role "collector"
--     terpisah di model AODP saat ini (diverifikasi lewat audit roles
--     existing + docs/product/modules/COLLECTION_INTELLIGENCE.md yang tidak
--     menyebut role spesifik) -- instruksi gate eksplisit melarang memberi
--     akses secara asumtif, jadi dipilih superset finance-oversight yang
--     SUDAH ada, bukan role baru yang diasumsikan.
--   - SELECT RLS collection_activities/promises_to_pay memakai permission
--     'receivable.view' yang sudah ada (Gate 2A) -- bukan permission baru,
--     karena data ini secara substansi adalah bagian dari domain piutang
--     dan belum ada UI/consumer khusus (Collection frontend eksplisit
--     out-of-scope gate ini) yang butuh pemisahan lebih granular.
--   - occurred_at/created_at collection_activities SELALU diisi NOW() di
--     server (RPC), TIDAK menerima timestamp dari client -- pola sama
--     dengan seluruh writer canonical lain di repo ini yang tidak pernah
--     mempercayai waktu kejadian dari input client.
--
-- DEFERRED (tidak dikerjakan di sini, lihat laporan akhir):
--   Payment receipt, cash handover, bank transfer matching, payment
--   allocation, reconciliation, ledger credit, status paid, retur/credit
--   note, aging UI, payment behavior score, AI collection priority,
--   WhatsApp/Telegram handler, scheduler/reminder automation, Collection
--   frontend, CollectionCase (entitas ini sudah diputuskan ditunda).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. promises_to_pay -- janji bayar (boleh sebagian) terhadap SATU invoice.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.promises_to_pay (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  invoice_id           UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  customer_id          UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  collector_id         UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  promised_amount      NUMERIC(15,2) NOT NULL CHECK (promised_amount > 0),
  promised_date        DATE          NOT NULL,
  status               VARCHAR(20)   NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'corrected', 'cancelled', 'broken')),
  previous_promise_id  UUID          REFERENCES public.promises_to_pay (id) ON DELETE RESTRICT,
  reason               TEXT          CHECK (reason IS NULL OR length(reason) <= 1000),
  idempotency_key      TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at          TIMESTAMPTZ,
  CHECK ((status = 'open') = (resolved_at IS NULL)),
  CHECK (status = 'open' OR (reason IS NOT NULL AND length(trim(reason)) > 0)),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_promises_to_pay_company_id ON public.promises_to_pay (company_id, created_at DESC);
CREATE INDEX idx_promises_to_pay_invoice_id ON public.promises_to_pay (invoice_id);
CREATE INDEX idx_promises_to_pay_previous   ON public.promises_to_pay (previous_promise_id);

-- Maksimal SATU promise berstatus 'open' per invoice pada satu waktu
-- (instruksi §4B invariant #9) -- partial unique index, backstop struktural
-- di luar cek eksplisit RPC (row lock FOR UPDATE pada invoices, lihat RPC
-- create_promise_to_pay di bawah).
CREATE UNIQUE INDEX uq_promises_to_pay_one_open_per_invoice
  ON public.promises_to_pay (invoice_id)
  WHERE status = 'open';

COMMENT ON TABLE public.promises_to_pay IS
  'Janji bayar (boleh sebagian) terhadap SATU invoice canonical. Terms finansial (promised_amount/promised_date/invoice_id/customer_id/collector_id) immutable penuh setelah INSERT (trg_promises_to_pay_immutable) -- koreksi WAJIB berupa baris baru (previous_promise_id) yang menutup baris lama sebagai status=corrected. TIDAK ADA status fulfilled pada gate ini (ditunda sampai payment/allocation terverifikasi gate berikutnya, forward-only).';
COMMENT ON COLUMN public.promises_to_pay.promised_date IS
  'TIDAK ADA CHECK "promised_date >= hari ini" di level tabel -- invariant ini relatif terhadap wall-clock (bukan invariant konsistensi statis antar baris seperti totals immutable Gate 2A), jadi ditegakkan HANYA pada RPC creation-time (create_promise_to_pay/correct_promise_to_pay, satu-satunya jalur resmi). Ini sengaja meninggalkan jalur INSERT langsung service_role tetap bisa menulis promised_date historis/backdated untuk kebutuhan legitimate (setup fixture test, backfill/migrasi data) tanpa CHECK constraint yang tidak punya makna integritas setelah faktanya (pola sama dengan Gate 2A yang membiarkan setup test menulis invoices langsung lewat service_role sebelum RPC atomik Gate 2B ada).';
COMMENT ON COLUMN public.promises_to_pay.status IS
  'open (aktif) -> corrected|cancelled|broken (final, tidak bisa transisi lagi). Tidak ada transisi manual ke fulfilled pada gate ini.';
COMMENT ON COLUMN public.promises_to_pay.previous_promise_id IS
  'Rantai koreksi -- diisi HANYA oleh correct_promise_to_pay() saat promise lama ditutup (status=corrected) dan promise baru dibuat.';

-- ---------------------------------------------------------------------------
-- 2. collection_activities -- fakta aktivitas collection, append-only.
--    Dibuat SETELAH promises_to_pay karena promise_to_pay_id mereferensikannya.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.collection_activities (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  invoice_id         UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  customer_id        UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  collector_id       UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  channel            VARCHAR(20)   NOT NULL CHECK (channel IN ('phone', 'whatsapp', 'telegram', 'visit', 'other')),
  activity_type      VARCHAR(10)   NOT NULL CHECK (activity_type IN ('attempt', 'outcome')),
  outcome            VARCHAR(30)   CHECK (outcome IS NULL OR outcome IN (
                         'contacted_successfully', 'not_contactable', 'not_paid_yet', 'promised_to_pay', 'dispute',
                         'claimed_paid_partial', 'claimed_paid_full',
                         'promise_corrected', 'promise_cancelled', 'promise_broken'
                       )),
  reported_amount    NUMERIC(15,2) CHECK (reported_amount IS NULL OR reported_amount > 0),
  note               TEXT          CHECK (note IS NULL OR length(note) <= 1000),
  promise_to_pay_id  UUID          REFERENCES public.promises_to_pay (id) ON DELETE RESTRICT,
  idempotency_key    TEXT,
  occurred_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- attempt tidak pernah punya outcome; outcome wajib ada untuk activity_type='outcome'.
  CHECK ((activity_type = 'attempt' AND outcome IS NULL) OR (activity_type = 'outcome' AND outcome IS NOT NULL)),
  -- reported_amount hanya relevan untuk klaim bayar sebagian/lunas.
  CHECK (reported_amount IS NULL OR outcome IN ('claimed_paid_partial', 'claimed_paid_full')),
  -- outcome promise_* (reserved, hanya ditulis internal oleh RPC promise) wajib membawa promise_to_pay_id.
  CHECK (outcome NOT IN ('promised_to_pay', 'promise_corrected', 'promise_cancelled', 'promise_broken') OR promise_to_pay_id IS NOT NULL),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_collection_activities_company_id ON public.collection_activities (company_id, created_at DESC);
CREATE INDEX idx_collection_activities_invoice_id ON public.collection_activities (invoice_id, created_at DESC);
CREATE INDEX idx_collection_activities_promise_id ON public.collection_activities (promise_to_pay_id);

COMMENT ON TABLE public.collection_activities IS
  'Sumber fakta aktivitas collection, append-only murni (trg_collection_activities_immutable -- tidak ada UPDATE/DELETE sama sekali). outcome claimed_paid_partial/claimed_paid_full adalah KLAIM belum terverifikasi (AODP_FINANCIAL_CONTRACT invariant collection) -- TIDAK PERNAH menyentuh receivable_ledger, invoices, atau sales_orders.status. outcome promise_corrected/promise_cancelled/promise_broken adalah nilai EXTENSION (di luar 7 nilai minimum instruksi gate) yang hanya ditulis oleh RPC promise lifecycle internal, bukan parameter client record_collection_activity().';
COMMENT ON COLUMN public.collection_activities.outcome IS
  'NULL untuk activity_type=attempt. contacted_successfully/not_contactable/not_paid_yet/promised_to_pay/dispute/claimed_paid_partial/claimed_paid_full dapat ditulis client lewat record_collection_activity() (promised_to_pay DITOLAK, lihat catatan RESERVED). promise_corrected/promise_cancelled/promise_broken HANYA ditulis RPC promise lifecycle.';

-- ---------------------------------------------------------------------------
-- 3. Immutability.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_collection_activity_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'COLLECTION_ACTIVITY_APPEND_ONLY: activity % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'COLLECTION_ACTIVITY_APPEND_ONLY: activity % tidak dapat diubah', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_collection_activities_immutable ON public.collection_activities;
CREATE TRIGGER trg_collection_activities_immutable
  BEFORE UPDATE OR DELETE ON public.collection_activities
  FOR EACH ROW EXECUTE FUNCTION public.prevent_collection_activity_mutation();

-- promises_to_pay mengizinkan TRANSISI STATUS TERBATAS (open -> corrected/
-- cancelled/broken, sekali, tidak bisa dibalik) -- seluruh kolom finansial
-- (promised_amount/promised_date/invoice_id/customer_id/collector_id/
-- previous_promise_id/idempotency_key/created_at) tetap immutable penuh.
CREATE OR REPLACE FUNCTION public.enforce_promise_terms_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PROMISE_IMMUTABLE: promise % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.company_id             IS DISTINCT FROM OLD.company_id
     OR NEW.invoice_id          IS DISTINCT FROM OLD.invoice_id
     OR NEW.customer_id         IS DISTINCT FROM OLD.customer_id
     OR NEW.collector_id        IS DISTINCT FROM OLD.collector_id
     OR NEW.promised_amount     IS DISTINCT FROM OLD.promised_amount
     OR NEW.promised_date       IS DISTINCT FROM OLD.promised_date
     OR NEW.previous_promise_id IS DISTINCT FROM OLD.previous_promise_id
     OR NEW.idempotency_key     IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'PROMISE_TERMS_IMMUTABLE: terms promise % tidak dapat diubah setelah dibuat', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'PROMISE_ALREADY_RESOLVED: promise % berstatus % (final), tidak dapat diubah lagi', OLD.id, OLD.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status NOT IN ('corrected', 'cancelled', 'broken') THEN
    RAISE EXCEPTION 'PROMISE_INVALID_TRANSITION: transisi status % -> % tidak diizinkan', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.reason IS NULL OR length(trim(NEW.reason)) = 0 THEN
    RAISE EXCEPTION 'PROMISE_REASON_REQUIRED: transisi status wajib menyertakan reason' USING ERRCODE = 'not_null_violation';
  END IF;

  IF NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'PROMISE_RESOLVED_AT_REQUIRED: transisi status wajib mengisi resolved_at' USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_promises_to_pay_immutable ON public.promises_to_pay;
CREATE TRIGGER trg_promises_to_pay_immutable
  BEFORE UPDATE OR DELETE ON public.promises_to_pay
  FOR EACH ROW EXECUTE FUNCTION public.enforce_promise_terms_immutable();

-- ---------------------------------------------------------------------------
-- 4. Tenant/consistency validation (BEFORE INSERT) -- lapisan kedua,
--    independen dari validasi RPC (pola sama dengan validate_invoice_tenant,
--    migration 20260826000001).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_promise_to_pay_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_company_id  UUID;
  v_invoice_customer_id UUID;
  v_collector_company_id UUID;
  v_collector_active     BOOLEAN;
  v_prev                 public.promises_to_pay%ROWTYPE;
BEGIN
  SELECT company_id, customer_id INTO v_invoice_company_id, v_invoice_customer_id
  FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_invoice_company_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_invoice_customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: customer_id harus sama dengan invoices.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id, is_active INTO v_collector_company_id, v_collector_active
  FROM public.users WHERE id = NEW.collector_id;
  IF v_collector_company_id IS NULL THEN
    RAISE EXCEPTION 'COLLECTOR_NOT_FOUND: %', NEW.collector_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_collector_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: collector % bukan milik company %', NEW.collector_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_collector_active THEN
    RAISE EXCEPTION 'COLLECTOR_INACTIVE: collector % tidak aktif', NEW.collector_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.previous_promise_id IS NOT NULL THEN
    SELECT * INTO v_prev FROM public.promises_to_pay WHERE id = NEW.previous_promise_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PREVIOUS_PROMISE_NOT_FOUND: %', NEW.previous_promise_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_prev.company_id <> NEW.company_id OR v_prev.invoice_id <> NEW.invoice_id THEN
      RAISE EXCEPTION 'PREVIOUS_PROMISE_MISMATCH: previous_promise % tidak terkait invoice %', NEW.previous_promise_id, NEW.invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_promises_to_pay_tenant ON public.promises_to_pay;
CREATE TRIGGER trg_promises_to_pay_tenant
  BEFORE INSERT ON public.promises_to_pay
  FOR EACH ROW EXECUTE FUNCTION public.validate_promise_to_pay_tenant();

CREATE OR REPLACE FUNCTION public.validate_collection_activity_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice_company_id   UUID;
  v_invoice_customer_id  UUID;
  v_collector_company_id UUID;
  v_collector_active     BOOLEAN;
  v_promise              public.promises_to_pay%ROWTYPE;
BEGIN
  SELECT company_id, customer_id INTO v_invoice_company_id, v_invoice_customer_id
  FROM public.invoices WHERE id = NEW.invoice_id;
  IF v_invoice_company_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_invoice_customer_id <> NEW.customer_id THEN
    RAISE EXCEPTION 'CUSTOMER_MISMATCH: customer_id harus sama dengan invoices.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id, is_active INTO v_collector_company_id, v_collector_active
  FROM public.users WHERE id = NEW.collector_id;
  IF v_collector_company_id IS NULL THEN
    RAISE EXCEPTION 'COLLECTOR_NOT_FOUND: %', NEW.collector_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_collector_company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: collector % bukan milik company %', NEW.collector_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_collector_active THEN
    RAISE EXCEPTION 'COLLECTOR_INACTIVE: collector % tidak aktif', NEW.collector_id USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.promise_to_pay_id IS NOT NULL THEN
    SELECT * INTO v_promise FROM public.promises_to_pay WHERE id = NEW.promise_to_pay_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROMISE_NOT_FOUND: %', NEW.promise_to_pay_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_promise.company_id <> NEW.company_id OR v_promise.invoice_id <> NEW.invoice_id THEN
      RAISE EXCEPTION 'PROMISE_INVOICE_MISMATCH: promise % tidak terkait invoice %', NEW.promise_to_pay_id, NEW.invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_collection_activities_tenant ON public.collection_activities;
CREATE TRIGGER trg_collection_activities_tenant
  BEFORE INSERT ON public.collection_activities
  FOR EACH ROW EXECUTE FUNCTION public.validate_collection_activity_tenant();

-- ---------------------------------------------------------------------------
-- 5. Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('collection.record', 'collection', 'record', 'Mencatat collection attempt/outcome pada invoice milik company sendiri'),
  ('collection.promise', 'collection', 'promise', 'Membuat/mengoreksi/membatalkan/menandai broken promise to pay pada invoice milik company sendiri')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')
  AND p.name IN ('collection.record', 'collection.promise')
ON CONFLICT DO NOTHING;

ALTER TABLE public.promises_to_pay       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_activities ENABLE ROW LEVEL SECURITY;

-- SELECT-only, reuse permission 'receivable.view' (Gate 2A) -- lihat catatan
-- keputusan desain di atas. Tidak ada policy INSERT/UPDATE/DELETE untuk
-- siapa pun, diperkuat REVOKE eksplisit di bawah.
CREATE POLICY "promises_to_pay_select" ON public.promises_to_pay
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "collection_activities_select" ON public.collection_activities
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.promises_to_pay, public.collection_activities
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.promises_to_pay, public.collection_activities TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. RPC canonical -- record_collection_activity().
--    Mencatat SATU collection attempt/outcome. outcome promise_* (reserved)
--    DITOLAK di sini -- hanya RPC promise lifecycle yang boleh menulisnya
--    (lihat catatan keputusan desain di atas).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_collection_activity(
  p_company_id          UUID,
  p_actor_id            UUID,
  p_invoice_id          UUID,
  p_channel             TEXT,
  p_activity_type       TEXT,
  p_outcome             TEXT DEFAULT NULL,
  p_reported_amount     NUMERIC DEFAULT NULL,
  p_note                TEXT DEFAULT NULL,
  p_promise_to_pay_id   UUID DEFAULT NULL,
  p_idempotency_key     TEXT DEFAULT NULL
) RETURNS TABLE(
  out_activity_id      UUID,
  out_activity_type    VARCHAR,
  out_outcome          VARCHAR,
  out_already_exists   BOOLEAN
) AS $$
DECLARE
  v_existing             public.collection_activities%ROWTYPE;
  v_actor_allowed        BOOLEAN;
  v_invoice_company_id   UUID;
  v_invoice_customer_id  UUID;
  v_promise               public.promises_to_pay%ROWTYPE;
  v_activity_id           UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.collection_activities
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing.id, v_existing.activity_type, v_existing.outcome, TRUE;
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
      AND perm.name = 'collection.record'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission collection.record pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT company_id, customer_id INTO v_invoice_company_id, v_invoice_customer_id
  FROM public.invoices WHERE id = p_invoice_id;
  IF v_invoice_company_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', p_invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', p_invoice_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_channel NOT IN ('phone', 'whatsapp', 'telegram', 'visit', 'other') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: %', p_channel USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_activity_type NOT IN ('attempt', 'outcome') THEN
    RAISE EXCEPTION 'INVALID_ACTIVITY_TYPE: %', p_activity_type USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_activity_type = 'attempt' THEN
    IF p_outcome IS NOT NULL THEN
      RAISE EXCEPTION 'ATTEMPT_MUST_NOT_HAVE_OUTCOME: activity_type=attempt tidak boleh menyertakan outcome'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    IF p_outcome IS NULL THEN
      RAISE EXCEPTION 'OUTCOME_REQUIRED: activity_type=outcome wajib menyertakan outcome' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_outcome IN ('promised_to_pay', 'promise_corrected', 'promise_cancelled', 'promise_broken') THEN
      RAISE EXCEPTION 'INVALID_OUTCOME_RESERVED: outcome % hanya dapat ditulis lewat RPC promise canonical', p_outcome
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_outcome NOT IN ('contacted_successfully', 'not_contactable', 'not_paid_yet', 'dispute', 'claimed_paid_partial', 'claimed_paid_full') THEN
      RAISE EXCEPTION 'INVALID_OUTCOME: %', p_outcome USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  IF p_reported_amount IS NOT NULL THEN
    IF p_reported_amount <= 0 THEN
      RAISE EXCEPTION 'INVALID_REPORTED_AMOUNT: % harus lebih dari 0', p_reported_amount USING ERRCODE = 'check_violation';
    END IF;
    IF p_outcome NOT IN ('claimed_paid_partial', 'claimed_paid_full') THEN
      RAISE EXCEPTION 'REPORTED_AMOUNT_NOT_APPLICABLE: hanya berlaku untuk outcome claimed_paid_partial/claimed_paid_full'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  IF p_promise_to_pay_id IS NOT NULL THEN
    SELECT * INTO v_promise FROM public.promises_to_pay WHERE id = p_promise_to_pay_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PROMISE_NOT_FOUND: %', p_promise_to_pay_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_promise.company_id <> p_company_id OR v_promise.invoice_id <> p_invoice_id THEN
      RAISE EXCEPTION 'PROMISE_INVOICE_MISMATCH: promise % tidak terkait invoice %', p_promise_to_pay_id, p_invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  INSERT INTO public.collection_activities (
    company_id, invoice_id, customer_id, collector_id, channel, activity_type,
    outcome, reported_amount, note, promise_to_pay_id, idempotency_key
  ) VALUES (
    p_company_id, p_invoice_id, v_invoice_customer_id, p_actor_id, p_channel, p_activity_type,
    p_outcome, p_reported_amount, NULLIF(p_note, ''), p_promise_to_pay_id, p_idempotency_key
  ) RETURNING id INTO v_activity_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id,
    CASE WHEN p_activity_type = 'attempt' THEN 'collection.attempt_recorded' ELSE 'collection.outcome_recorded' END,
    'collection_activities', v_activity_id,
    jsonb_build_object(
      'company_id', p_company_id, 'customer_id', v_invoice_customer_id, 'invoice_id', p_invoice_id,
      'collector_id', p_actor_id, 'channel', p_channel, 'activity_type', p_activity_type,
      'outcome', p_outcome, 'reported_amount', p_reported_amount, 'promise_to_pay_id', p_promise_to_pay_id,
      'note', NULLIF(p_note, ''), 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'collection', 'web', 'success'
  );

  RETURN QUERY SELECT v_activity_id, p_activity_type::VARCHAR, p_outcome::VARCHAR, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.record_collection_activity IS
  'Satu-satunya jalur mencatat collection attempt/outcome. Menolak outcome reserved (promised_to_pay/promise_corrected/promise_cancelled/promise_broken) -- itu hanya boleh ditulis RPC promise lifecycle sendiri. Idempotent via UNIQUE(company_id, idempotency_key). Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.record_collection_activity(UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_collection_activity(UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. RPC canonical -- create_promise_to_pay().
--    Row-lock invoices FOR UPDATE untuk menyerialisasi percobaan create/
--    correct promise pada invoice yang sama (pola sama dengan
--    issue_invoice_atomic mengunci sales_orders).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_promise_to_pay(
  p_company_id       UUID,
  p_actor_id         UUID,
  p_invoice_id       UUID,
  p_promised_amount  NUMERIC,
  p_promised_date    DATE,
  p_channel          TEXT,
  p_note             TEXT DEFAULT NULL,
  p_idempotency_key  TEXT DEFAULT NULL
) RETURNS TABLE(
  out_promise_id       UUID,
  out_status           VARCHAR,
  out_activity_id      UUID,
  out_already_exists   BOOLEAN
) AS $$
DECLARE
  v_existing              public.promises_to_pay%ROWTYPE;
  v_existing_activity_id  UUID;
  v_actor_allowed         BOOLEAN;
  v_invoice_company_id    UUID;
  v_invoice_customer_id   UUID;
  v_outstanding           NUMERIC(15,2);
  v_today                 DATE;
  v_promise_id            UUID;
  v_activity_id           UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.promises_to_pay
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key AND invoice_id = p_invoice_id;
    IF FOUND THEN
      SELECT id INTO v_existing_activity_id FROM public.collection_activities
      WHERE promise_to_pay_id = v_existing.id AND outcome = 'promised_to_pay'
      ORDER BY created_at DESC LIMIT 1;
      RETURN QUERY SELECT v_existing.id, v_existing.status, v_existing_activity_id, TRUE;
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
      AND perm.name = 'collection.promise'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission collection.promise pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_channel NOT IN ('phone', 'whatsapp', 'telegram', 'visit', 'other') THEN
    RAISE EXCEPTION 'INVALID_CHANNEL: %', p_channel USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Lock invoice -- menyerialisasi seluruh percobaan create/correct promise
  -- untuk invoice yang sama (mencegah dua open promise via race).
  SELECT company_id, customer_id INTO v_invoice_company_id, v_invoice_customer_id
  FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_invoice_company_id IS NULL THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', p_invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', p_invoice_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM public.promises_to_pay WHERE invoice_id = p_invoice_id AND status = 'open') THEN
    RAISE EXCEPTION 'ACTIVE_PROMISE_EXISTS: invoice % sudah memiliki promise aktif', p_invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF p_promised_amount IS NULL OR p_promised_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_PROMISED_AMOUNT: % harus lebih dari 0', p_promised_amount USING ERRCODE = 'check_violation';
  END IF;

  SELECT outstanding_balance INTO v_outstanding
  FROM public.invoice_receivable_balances WHERE invoice_id = p_invoice_id;
  IF v_outstanding IS NULL OR v_outstanding <= 0 THEN
    RAISE EXCEPTION 'NO_OUTSTANDING_BALANCE: invoice % tidak memiliki saldo piutang', p_invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF p_promised_amount > v_outstanding THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OUTSTANDING: promised_amount % melebihi outstanding_balance %', p_promised_amount, v_outstanding
      USING ERRCODE = 'check_violation';
  END IF;

  v_today := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
  IF p_promised_date < v_today THEN
    RAISE EXCEPTION 'PROMISE_DATE_IN_PAST: promised_date % sebelum %', p_promised_date, v_today
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.promises_to_pay (
    company_id, invoice_id, customer_id, collector_id, promised_amount, promised_date, status, idempotency_key
  ) VALUES (
    p_company_id, p_invoice_id, v_invoice_customer_id, p_actor_id, p_promised_amount, p_promised_date, 'open', p_idempotency_key
  ) RETURNING id INTO v_promise_id;

  INSERT INTO public.collection_activities (
    company_id, invoice_id, customer_id, collector_id, channel, activity_type, outcome, note, promise_to_pay_id
  ) VALUES (
    p_company_id, p_invoice_id, v_invoice_customer_id, p_actor_id, p_channel, 'outcome', 'promised_to_pay', NULLIF(p_note, ''), v_promise_id
  ) RETURNING id INTO v_activity_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'collection.promise_created', 'promises_to_pay', v_promise_id,
    jsonb_build_object(
      'company_id', p_company_id, 'customer_id', v_invoice_customer_id, 'invoice_id', p_invoice_id,
      'collector_id', p_actor_id, 'promise_id', v_promise_id, 'promised_amount', p_promised_amount,
      'promised_date', p_promised_date, 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'collection', 'web', 'success'
  );

  RETURN QUERY SELECT v_promise_id, 'open'::VARCHAR, v_activity_id, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.create_promise_to_pay IS
  'Satu-satunya jalur pembuatan promise to pay. Validasi: amount>0, amount<=outstanding_balance (invoice_receivable_balances), promised_date>=hari ini (Asia/Jakarta), maksimal satu open promise per invoice (row lock FOR UPDATE pada invoices + partial unique index). Menulis promises_to_pay + collection_activities (outcome=promised_to_pay) + audit dalam satu transaksi. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.create_promise_to_pay(UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_promise_to_pay(UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 8. RPC canonical -- correct_promise_to_pay().
--    Menutup promise lama (status=corrected) + membuat promise baru dalam
--    SATU transaksi. No-op (amount & date sama persis) DITOLAK sebelum
--    menyentuh apa pun -- tidak ada audit/activity yang tertulis.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.correct_promise_to_pay(
  p_company_id             UUID,
  p_actor_id               UUID,
  p_promise_id             UUID,
  p_new_promised_amount    NUMERIC,
  p_new_promised_date      DATE,
  p_reason                 TEXT,
  p_idempotency_key        TEXT DEFAULT NULL
) RETURNS TABLE(
  out_new_promise_id    UUID,
  out_old_promise_id    UUID,
  out_activity_id       UUID,
  out_already_exists    BOOLEAN
) AS $$
DECLARE
  v_existing              public.promises_to_pay%ROWTYPE;
  v_existing_activity_id  UUID;
  v_actor_allowed         BOOLEAN;
  v_old                   public.promises_to_pay%ROWTYPE;
  v_outstanding           NUMERIC(15,2);
  v_today                 DATE;
  v_new_promise_id        UUID;
  v_activity_id           UUID;
BEGIN
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.promises_to_pay
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key AND previous_promise_id = p_promise_id;
    IF FOUND THEN
      SELECT id INTO v_existing_activity_id FROM public.collection_activities
      WHERE promise_to_pay_id = v_existing.id AND outcome = 'promise_corrected'
      ORDER BY created_at DESC LIMIT 1;
      RETURN QUERY SELECT v_existing.id, p_promise_id, v_existing_activity_id, TRUE;
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
      AND perm.name = 'collection.promise'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission collection.promise pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: koreksi promise wajib menyertakan reason' USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT * INTO v_old FROM public.promises_to_pay WHERE id = p_promise_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMISE_NOT_FOUND: %', p_promise_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_old.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: promise % bukan milik company %', p_promise_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_old.status <> 'open' THEN
    RAISE EXCEPTION 'PROMISE_NOT_OPEN: promise % berstatus %, tidak dapat dikoreksi', p_promise_id, v_old.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF p_new_promised_amount = v_old.promised_amount AND p_new_promised_date = v_old.promised_date THEN
    RAISE EXCEPTION 'NOOP_CORRECTION_REJECTED: nilai dan tanggal baru sama persis dengan promise sebelumnya'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_new_promised_amount IS NULL OR p_new_promised_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_PROMISED_AMOUNT: % harus lebih dari 0', p_new_promised_amount USING ERRCODE = 'check_violation';
  END IF;

  SELECT outstanding_balance INTO v_outstanding
  FROM public.invoice_receivable_balances WHERE invoice_id = v_old.invoice_id;
  IF v_outstanding IS NULL OR p_new_promised_amount > v_outstanding THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OUTSTANDING: promised_amount % melebihi outstanding_balance %', p_new_promised_amount, COALESCE(v_outstanding, 0)
      USING ERRCODE = 'check_violation';
  END IF;

  v_today := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
  IF p_new_promised_date < v_today THEN
    RAISE EXCEPTION 'PROMISE_DATE_IN_PAST: promised_date % sebelum %', p_new_promised_date, v_today
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.promises_to_pay
  SET status = 'corrected', reason = p_reason, resolved_at = NOW()
  WHERE id = p_promise_id;

  INSERT INTO public.promises_to_pay (
    company_id, invoice_id, customer_id, collector_id, promised_amount, promised_date, status, previous_promise_id, idempotency_key
  ) VALUES (
    v_old.company_id, v_old.invoice_id, v_old.customer_id, p_actor_id, p_new_promised_amount, p_new_promised_date, 'open', p_promise_id, p_idempotency_key
  ) RETURNING id INTO v_new_promise_id;

  INSERT INTO public.collection_activities (
    company_id, invoice_id, customer_id, collector_id, channel, activity_type, outcome, note, promise_to_pay_id
  ) VALUES (
    v_old.company_id, v_old.invoice_id, v_old.customer_id, p_actor_id, 'other', 'outcome', 'promise_corrected', p_reason, v_new_promise_id
  ) RETURNING id INTO v_activity_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'collection.promise_corrected', 'promises_to_pay', v_new_promise_id,
    jsonb_build_object('promise_id', p_promise_id, 'promised_amount', v_old.promised_amount, 'promised_date', v_old.promised_date, 'status', v_old.status),
    jsonb_build_object(
      'company_id', p_company_id, 'customer_id', v_old.customer_id, 'invoice_id', v_old.invoice_id,
      'collector_id', p_actor_id, 'previous_promise_id', p_promise_id, 'promise_id', v_new_promise_id,
      'promised_amount', p_new_promised_amount, 'promised_date', p_new_promised_date, 'reason', p_reason,
      'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'collection', 'web', 'success'
  );

  RETURN QUERY SELECT v_new_promise_id, p_promise_id, v_activity_id, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.correct_promise_to_pay IS
  'Koreksi promise: menutup promise lama (status=corrected, reason wajib) + membuat promise baru (previous_promise_id) dalam satu transaksi. No-op (amount & date identik) ditolak SEBELUM menyentuh apa pun -- tidak ada audit/activity untuk no-op. Idempotent via UNIQUE(company_id, idempotency_key) pada promise baru. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.correct_promise_to_pay(UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_promise_to_pay(UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 9. RPC canonical -- cancel_promise_to_pay().
--    Idempotent SECARA STRUKTURAL: promise yang sudah 'cancelled' langsung
--    mengembalikan hasil yang sama tanpa menulis apa pun lagi (tidak
--    bergantung pada idempotency_key yang sama antar percobaan).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_promise_to_pay(
  p_company_id        UUID,
  p_actor_id          UUID,
  p_promise_id        UUID,
  p_reason            TEXT,
  p_idempotency_key   TEXT DEFAULT NULL
) RETURNS TABLE(
  out_promise_id       UUID,
  out_status           VARCHAR,
  out_activity_id      UUID,
  out_already_exists   BOOLEAN
) AS $$
DECLARE
  v_actor_allowed  BOOLEAN;
  v_promise        public.promises_to_pay%ROWTYPE;
  v_activity_id    UUID;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'collection.promise'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission collection.promise pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: pembatalan promise wajib menyertakan reason' USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT * INTO v_promise FROM public.promises_to_pay WHERE id = p_promise_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMISE_NOT_FOUND: %', p_promise_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_promise.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: promise % bukan milik company %', p_promise_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_promise.status = 'cancelled' THEN
    SELECT id INTO v_activity_id FROM public.collection_activities
    WHERE promise_to_pay_id = v_promise.id AND outcome = 'promise_cancelled'
    ORDER BY created_at DESC LIMIT 1;
    RETURN QUERY SELECT v_promise.id, v_promise.status, v_activity_id, TRUE;
    RETURN;
  END IF;
  IF v_promise.status <> 'open' THEN
    RAISE EXCEPTION 'PROMISE_NOT_OPEN: promise % berstatus %, tidak dapat dibatalkan', p_promise_id, v_promise.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE public.promises_to_pay
  SET status = 'cancelled', reason = p_reason, resolved_at = NOW()
  WHERE id = p_promise_id;

  INSERT INTO public.collection_activities (
    company_id, invoice_id, customer_id, collector_id, channel, activity_type, outcome, note, promise_to_pay_id, idempotency_key
  ) VALUES (
    v_promise.company_id, v_promise.invoice_id, v_promise.customer_id, p_actor_id, 'other', 'outcome', 'promise_cancelled', p_reason, v_promise.id, p_idempotency_key
  ) RETURNING id INTO v_activity_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'collection.promise_cancelled', 'promises_to_pay', p_promise_id,
    jsonb_build_object('status', v_promise.status),
    jsonb_build_object(
      'company_id', p_company_id, 'customer_id', v_promise.customer_id, 'invoice_id', v_promise.invoice_id,
      'collector_id', p_actor_id, 'promise_id', p_promise_id, 'promised_amount', v_promise.promised_amount,
      'promised_date', v_promise.promised_date, 'reason', p_reason, 'idempotency_key', p_idempotency_key
    ),
    NULL, 'audit', 'collection', 'web', 'success'
  );

  RETURN QUERY SELECT p_promise_id, 'cancelled'::VARCHAR, v_activity_id, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.cancel_promise_to_pay IS
  'Pembatalan promise (status=cancelled, reason wajib). Idempotent secara struktural -- promise yang sudah cancelled langsung mengembalikan hasil yang sama tanpa menulis apa pun lagi. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.cancel_promise_to_pay(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_promise_to_pay(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 10. RPC canonical -- mark_promise_broken().
--     Idempotent SECARA STRUKTURAL (sama dengan cancel_promise_to_pay).
--     Menolak promise yang promised_date-nya BELUM lewat (PROMISE_NOT_YET_DUE).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_promise_broken(
  p_company_id        UUID,
  p_actor_id          UUID,
  p_promise_id        UUID,
  p_idempotency_key   TEXT DEFAULT NULL
) RETURNS TABLE(
  out_promise_id       UUID,
  out_status           VARCHAR,
  out_activity_id      UUID,
  out_already_exists   BOOLEAN
) AS $$
DECLARE
  v_actor_allowed  BOOLEAN;
  v_promise        public.promises_to_pay%ROWTYPE;
  v_today          DATE;
  v_activity_id    UUID;
  v_reason         TEXT := 'Promise melewati promised_date tanpa pelunasan/koreksi/pembatalan';
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'collection.promise'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission collection.promise pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_promise FROM public.promises_to_pay WHERE id = p_promise_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROMISE_NOT_FOUND: %', p_promise_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_promise.company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: promise % bukan milik company %', p_promise_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_promise.status = 'broken' THEN
    SELECT id INTO v_activity_id FROM public.collection_activities
    WHERE promise_to_pay_id = v_promise.id AND outcome = 'promise_broken'
    ORDER BY created_at DESC LIMIT 1;
    RETURN QUERY SELECT v_promise.id, v_promise.status, v_activity_id, TRUE;
    RETURN;
  END IF;
  IF v_promise.status <> 'open' THEN
    RAISE EXCEPTION 'PROMISE_NOT_OPEN: promise % berstatus %, tidak dapat ditandai broken', p_promise_id, v_promise.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_today := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
  IF v_promise.promised_date >= v_today THEN
    RAISE EXCEPTION 'PROMISE_NOT_YET_DUE: promised_date % belum lewat (hari ini %)', v_promise.promised_date, v_today
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE public.promises_to_pay
  SET status = 'broken', reason = v_reason, resolved_at = NOW()
  WHERE id = p_promise_id;

  INSERT INTO public.collection_activities (
    company_id, invoice_id, customer_id, collector_id, channel, activity_type, outcome, note, promise_to_pay_id, idempotency_key
  ) VALUES (
    v_promise.company_id, v_promise.invoice_id, v_promise.customer_id, p_actor_id, 'other', 'outcome', 'promise_broken', v_reason, v_promise.id, p_idempotency_key
  ) RETURNING id INTO v_activity_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'collection.promise_broken', 'promises_to_pay', p_promise_id,
    jsonb_build_object('status', v_promise.status),
    jsonb_build_object(
      'company_id', p_company_id, 'customer_id', v_promise.customer_id, 'invoice_id', v_promise.invoice_id,
      'collector_id', p_actor_id, 'promise_id', p_promise_id, 'promised_amount', v_promise.promised_amount,
      'promised_date', v_promise.promised_date, 'reason', v_reason
    ),
    NULL, 'audit', 'collection', 'web', 'success'
  );

  RETURN QUERY SELECT p_promise_id, 'broken'::VARCHAR, v_activity_id, FALSE;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.mark_promise_broken IS
  'Menandai promise overdue (promised_date < hari ini Asia/Jakarta) sebagai broken. Menolak promise yang belum jatuh tempo (PROMISE_NOT_YET_DUE). Idempotent secara struktural -- promise yang sudah broken langsung mengembalikan hasil yang sama tanpa menulis apa pun lagi. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.mark_promise_broken(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_promise_broken(UUID, UUID, UUID, TEXT)
  TO service_role;
