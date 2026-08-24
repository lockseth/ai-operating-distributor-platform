-- =============================================================================
-- Sales/Driver bisa catat hasil kunjungan penagihan (non-pembayaran).
--
-- Temuan (2026-08-24): sales/driver turun ke lapangan untuk menagih (opsi
-- "Penagihan" ada di halaman Kunjungan Sales, sales_visits.visit_purpose),
-- tapi tidak punya cara mencatat hasilnya kalau bukan "sudah terima uang"
-- (Klaim Pembayaran, payment_claims, permission payment.claim). Tabel
-- penagihan sungguhan (collection_activities, dipakai Business Guard
-- Collection Risk + Unremitted Collection Risk) permission-nya
-- collection.record -- SENGAJA finance-tier saja sejak Gate 2C
-- (20260828000001: "sales tidak pernah pegang aksi finansial
-- invoice/piutang"). Akibatnya hasil kunjungan penagihan yang BUKAN
-- "berhasil dapat uang" (belum bayar/janji besok/sengketa/tidak ketemu)
-- hilang dari sistem kecuali lapor manual ke Finance.
--
-- Fix: permission BARU collection.record.field (BUKAN mengubah
-- collection.record yang sudah ada -- itu tetap finance-tier utuh, supaya
-- klaim "sudah dibayar" tetap SATU-SATUNYA lewat Klaim Pembayaran yang
-- direview Finance, tidak ada 2 jalur berbeda yang bisa tidak konsisten).
-- Dipegang sales+driver, pola sama persis payment.claim (20261010000001)
-- yang sudah dipegang kedua role itu.
--
-- record_collection_activity() di-CREATE OR REPLACE, signature SAMA
-- PERSIS (backward-compatible) -- tambah cabang otorisasi kedua: actor
-- dengan HANYA collection.record.field (bukan collection.record penuh)
-- WAJIB outcome salah satu dari contacted_successfully/not_contactable/
-- not_paid_yet/dispute. claimed_paid_partial/claimed_paid_full/outcome
-- reserved tetap ditolak di level RPC untuk tier ini -- defense-in-depth,
-- bukan cuma dibatasi UI (union type sempit di server action lapis
-- pertama, tapi RPC tidak pernah mempercayai lapis app saja).
--
-- Tidak ada containment "hanya customer sendiri" -- dicek ke fitur
-- sibling payment.claim (dashboard/payment-claims/page.tsx) yang sudah
-- shipped, TIDAK ada pembatasan assigned_sales_id di situ. Konsisten,
-- tidak menciptakan model keamanan berbeda antara dua fitur yang setara.
-- =============================================================================

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('collection.record.field', 'collection', 'record_field',
   'Mencatat hasil kunjungan penagihan lapangan (bukan klaim pembayaran) -- outcome terbatas ke non-pembayaran (contacted_successfully/not_contactable/not_paid_yet/dispute)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('sales', 'driver')
  AND p.name = 'collection.record.field'
ON CONFLICT DO NOTHING;

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
  v_has_full              BOOLEAN;
  v_has_field             BOOLEAN;
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

  SELECT
    bool_or(perm.name = 'collection.record'),
    bool_or(perm.name = 'collection.record.field')
  INTO v_has_full, v_has_field
  FROM public.users u
  JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
  JOIN public.role_permissions rp ON rp.role_id = ur.role_id
  JOIN public.permissions perm ON perm.id = rp.permission_id
  WHERE u.id = p_actor_id
    AND u.company_id = p_company_id
    AND u.is_active = TRUE
    AND perm.name IN ('collection.record', 'collection.record.field');

  IF NOT COALESCE(v_has_full, FALSE) AND NOT COALESCE(v_has_field, FALSE) THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission collection.record/collection.record.field pada company %', p_actor_id, p_company_id
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
    -- BARU: actor tier "field" (bukan full finance-tier) TIDAK BOLEH
    -- menulis outcome pembayaran -- itu tetap SATU-SATUNYA lewat Klaim
    -- Pembayaran (payment_claims) yang direview Finance.
    IF NOT v_has_full AND p_outcome IN ('claimed_paid_partial', 'claimed_paid_full') THEN
      RAISE EXCEPTION 'INVALID_OUTCOME_FIELD_TIER: outcome % hanya dapat ditulis actor dengan permission collection.record penuh -- gunakan Klaim Pembayaran untuk lapor sudah terima uang', p_outcome
        USING ERRCODE = 'insufficient_privilege';
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
  'Satu-satunya jalur mencatat collection attempt/outcome. Dua tier otorisasi: collection.record (penuh, finance-tier, semua outcome) atau collection.record.field (sales/driver, HANYA outcome non-pembayaran -- claimed_paid_* ditolak di level RPC ini). Menolak outcome reserved (promised_to_pay/promise_corrected/promise_cancelled/promise_broken) -- itu hanya boleh ditulis RPC promise lifecycle sendiri. Idempotent via UNIQUE(company_id, idempotency_key). Dipanggil hanya lewat service_role.';

-- Signature RPC tidak berubah -- REVOKE/GRANT existing (service_role saja)
-- tetap berlaku, tidak perlu diulang.
