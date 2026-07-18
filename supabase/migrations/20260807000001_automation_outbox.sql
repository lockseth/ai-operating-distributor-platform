-- =============================================================================
-- n8n Automation & Orchestration Foundation — Automation Outbox
--
-- Supabase tetap source of truth. n8n HANYA orchestration/scheduling/
-- delivery/retry -- tidak pernah menghitung Call/EC/achievement/target
-- sendiri (itu tetap di lib/sales-kpi/*, tidak disentuh migration ini) dan
-- tidak pernah menulis langsung ke tabel transaksi inti (sales_orders,
-- sales_calls, sales_kpi_*). Outbox ini murni antrian PENGIRIMAN notifikasi
-- yang KONTEN-nya sudah dihitung oleh service AODP sebelum masuk outbox.
--
-- Autentikasi caller (n8n) memakai ULANG n8n_inbound_credentials yang sudah
-- di-hardening (migration 20260715000001) -- Bearer token, SHA-256 hash
-- lookup, company_id SELALU dari credential (bukan payload), scope[]
-- fail-closed. Scope string baru yang dipakai modul ini (tidak perlu ALTER
-- TABLE -- scope adalah TEXT[] tanpa CHECK constraint terhadap isi):
--   automation.claim, automation.complete, automation.fail,
--   automation.replay, automation.health,
--   automation.morning_brief.generate, automation.kpi_summary.generate
--
-- Claim job memakai FOR UPDATE SKIP LOCKED -- pola BARU di repo ini (belum
-- pernah dipakai sebelumnya, diverifikasi via audit sebelum implementasi),
-- dipilih karena ini satu-satunya primitif Postgres yang benar untuk
-- concurrency-safe job-queue claim (dua worker claim bersamaan -> hanya
-- satu yang dapat baris yang sama, worker lain otomatis skip tanpa
-- blocking). Stale PROCESSING (locked_at > 10 menit) dianggap eligible
-- claim ulang di WHERE clause yang sama -- tidak perlu RPC/cron terpisah
-- untuk stale-lock recovery.
--
-- Audit: setiap transisi status penting (claim/complete/fail/dead_letter/
-- replay) menulis baris ke audit_logs (existing, immutable table) --
-- automation_outbox SENDIRI TIDAK append-only (job memang butuh banyak
-- transisi status sepanjang siklus hidupnya, beda dengan sales_calls/
-- achievement_events yang append-only karena itu FAKTA historis).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.automation_outbox (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  event_type                VARCHAR(50)  NOT NULL CHECK (event_type IN ('MORNING_BRIEF', 'KPI_DAILY_SUMMARY')),
  channel                   VARCHAR(20)  NOT NULL CHECK (channel IN ('telegram', 'whatsapp')),
  recipient_user_id         UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  recipient_reference       TEXT         NOT NULL,
  payload                   JSONB        NOT NULL,
  idempotency_key           TEXT         NOT NULL,
  status                    VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'RETRY', 'FAILED', 'DEAD_LETTER')),
  available_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  attempt_count             INTEGER      NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts              INTEGER      NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_at                 TIMESTAMPTZ,
  locked_by                 TEXT,
  sent_at                   TIMESTAMPTZ,
  failed_at                 TIMESTAMPTZ,
  last_error                TEXT,
  provider_message_id       TEXT,
  created_by_credential_id  UUID         REFERENCES public.n8n_inbound_credentials (id) ON DELETE SET NULL,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, idempotency_key)
);

-- Index utama untuk query claim (status + available_at) dan monitoring UI
-- (company_id + status + created_at).
CREATE INDEX idx_automation_outbox_claim
  ON public.automation_outbox (company_id, status, available_at);
CREATE INDEX idx_automation_outbox_monitor
  ON public.automation_outbox (company_id, status, created_at DESC);
CREATE INDEX idx_automation_outbox_recipient
  ON public.automation_outbox (company_id, recipient_user_id);

CREATE TRIGGER trg_automation_outbox_updated_at
  BEFORE UPDATE ON public.automation_outbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.automation_outbox IS
  'Antrian pengiriman notifikasi (Morning Brief, KPI Daily Summary). Konten payload SUDAH dihitung oleh service AODP sebelum insert -- n8n hanya membaca & mengirim. Tidak append-only (status berubah sepanjang siklus job); audit trail penting ada di audit_logs.';
COMMENT ON COLUMN public.automation_outbox.payload IS
  'Konten terstruktur hasil presenter AODP (lib/automation/*). TIDAK PERNAH berisi credential/provider secret.';
COMMENT ON COLUMN public.automation_outbox.last_error IS
  'Pesan error SUDAH disanitasi (truncated, token/secret-like pattern di-strip) sebelum disimpan -- lihat sanitizeAutomationError() di lib/automation/service.ts dan defensive strip di fail_automation_job.';
COMMENT ON COLUMN public.automation_outbox.locked_by IS
  'Identitas pengklaim (label credential n8n atau worker id) -- untuk audit trace, bukan mekanisme keamanan.';

ALTER TABLE public.automation_outbox ENABLE ROW LEVEL SECURITY;

-- Hanya owner/manager/super_admin yang boleh melihat antrian automation
-- tenant sendiri (dashboard monitoring). Salesman TIDAK melihat automation
-- job tenant mana pun, termasuk miliknya sendiri (job ini operasional
-- internal, bukan data yang perlu diekspos ke salesman).
CREATE POLICY "automation_outbox_select" ON public.automation_outbox
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

REVOKE ALL ON TABLE public.automation_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.automation_outbox TO authenticated;

-- ---------------------------------------------------------------------------
-- Helper: verifikasi credential n8n punya scope tertentu untuk company_id
-- yang diklaim. Dipakai berulang oleh RPC di bawah -- SATU tempat definisi
-- aturan "credential X boleh melakukan Y untuk tenant Z", supaya tidak
-- terduplikasi berbeda-beda di tiap RPC.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_automation_credential_scope(
  p_credential_id UUID,
  p_company_id UUID,
  p_required_scope TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT company_id, status, scope
  INTO v_row
  FROM public.n8n_inbound_credentials
  WHERE id = p_credential_id;

  IF v_row IS NULL THEN RETURN FALSE; END IF;
  IF v_row.status <> 'active' THEN RETURN FALSE; END IF;
  IF v_row.company_id IS DISTINCT FROM p_company_id THEN RETURN FALSE; END IF;
  IF NOT (p_required_scope = ANY(v_row.scope)) THEN RETURN FALSE; END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.check_automation_credential_scope(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_automation_credential_scope(UUID, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- claim_automation_jobs: klaim atomik hingga p_max_jobs baris PENDING/RETRY
-- yang sudah due (available_at<=now), TERMASUK PROCESSING yang stale
-- (locked_at > 10 menit -- dianggap worker sebelumnya mati/hang).
-- FOR UPDATE SKIP LOCKED menjamin dua worker/credential yang claim
-- bersamaan tidak pernah mendapat baris yang sama.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_automation_jobs(
  p_company_id UUID,
  p_credential_id UUID,
  p_max_jobs INTEGER,
  p_worker_label TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  job_id UUID,
  event_type TEXT,
  channel TEXT,
  recipient_reference TEXT,
  payload JSONB,
  attempt_count INTEGER,
  max_attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized BOOLEAN;
  v_ids UUID[];
BEGIN
  v_authorized := public.check_automation_credential_scope(p_credential_id, p_company_id, 'automation.claim');
  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::INTEGER, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_max_jobs IS NULL OR p_max_jobs <= 0 OR p_max_jobs > 50 THEN
    RETURN QUERY SELECT 'invalid_max_jobs'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::JSONB, NULL::INTEGER, NULL::INTEGER;
    RETURN;
  END IF;

  -- Pilih kandidat lebih dulu ke array eksplisit (bukan heuristik jendela
  -- waktu) supaya UPDATE, INSERT audit, dan RETURN QUERY di bawah semuanya
  -- beroperasi pada SET BARIS YANG SAMA PERSIS -- tidak ada celah race atau
  -- salah atribusi audit walau dua worker claim nyaris bersamaan.
  SELECT array_agg(o.id) INTO v_ids
  FROM (
    SELECT id
    FROM public.automation_outbox
    WHERE company_id = p_company_id
      AND (
        (status IN ('PENDING', 'RETRY') AND available_at <= NOW())
        OR (status = 'PROCESSING' AND locked_at < NOW() - INTERVAL '10 minutes')
      )
    ORDER BY available_at
    LIMIT p_max_jobs
    FOR UPDATE SKIP LOCKED
  ) o;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    RETURN; -- tidak ada job eligible -- result set kosong, bukan error
  END IF;

  -- attempt_count bertambah di SETIAP claim (baik claim normal dari PENDING/
  -- RETRY maupun stale-reclaim dari PROCESSING) -- ini satu-satunya tempat
  -- attempt_count naik. fail_automation_job membandingkan attempt_count vs
  -- max_attempts SETELAH claim ini untuk memutuskan RETRY vs DEAD_LETTER,
  -- jadi max_attempts=N berarti tepat N kali claim/percobaan diizinkan
  -- sebelum dead-letter.
  UPDATE public.automation_outbox o
  SET status = 'PROCESSING',
      locked_at = NOW(),
      locked_by = p_worker_label,
      attempt_count = o.attempt_count + 1
  WHERE o.id = ANY(v_ids);

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  SELECT p_company_id, NULL, 'automation.job_claimed', 'automation_outbox', o.id,
         jsonb_build_object('worker_label', p_worker_label, 'credential_id', p_credential_id, 'attempt_count', o.attempt_count)
  FROM public.automation_outbox o
  WHERE o.id = ANY(v_ids);

  RETURN QUERY
  SELECT 'claimed'::TEXT, o.id, o.event_type::TEXT, o.channel::TEXT, o.recipient_reference, o.payload, o.attempt_count, o.max_attempts
  FROM public.automation_outbox o
  WHERE o.id = ANY(v_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_automation_jobs(UUID, UUID, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_jobs(UUID, UUID, INTEGER, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- complete_automation_job: tandai SENT. Idempotent -- retry dengan job_id
-- yang sama pada baris yang sudah SENT tidak menggandakan efek apa pun.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_automation_job(
  p_company_id UUID,
  p_credential_id UUID,
  p_job_id UUID,
  p_provider_message_id TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized BOOLEAN;
  v_status TEXT;
BEGIN
  v_authorized := public.check_automation_credential_scope(p_credential_id, p_company_id, 'automation.complete');
  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT status INTO v_status
  FROM public.automation_outbox
  WHERE id = p_job_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;
  IF v_status = 'SENT' THEN
    RETURN QUERY SELECT 'already_completed'::TEXT;
    RETURN;
  END IF;
  IF v_status <> 'PROCESSING' THEN
    RETURN QUERY SELECT 'invalid_state'::TEXT;
    RETURN;
  END IF;

  UPDATE public.automation_outbox
  SET status = 'SENT', sent_at = NOW(), provider_message_id = p_provider_message_id,
      locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, NULL, 'automation.job_completed', 'automation_outbox', p_job_id,
          jsonb_build_object('provider_message_id', p_provider_message_id, 'credential_id', p_credential_id));

  RETURN QUERY SELECT 'completed'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_automation_job(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_automation_job(UUID, UUID, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- fail_automation_job: p_retryable=FALSE -> FAILED langsung (error data,
-- tidak akan pernah berhasil walau diulang). p_retryable=TRUE -> RETRY
-- dengan backoff eksponensial (2^attempt_count menit, cap 60 menit) jika
-- attempt_count belum mencapai max_attempts, else DEAD_LETTER.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fail_automation_job(
  p_company_id UUID,
  p_credential_id UUID,
  p_job_id UUID,
  p_error TEXT,
  p_retryable BOOLEAN
)
RETURNS TABLE(result_outcome TEXT, result_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized BOOLEAN;
  v_job RECORD;
  v_sanitized_error TEXT;
  v_backoff_minutes NUMERIC;
BEGIN
  v_authorized := public.check_automation_credential_scope(p_credential_id, p_company_id, 'automation.fail');
  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT status, attempt_count, max_attempts
  INTO v_job
  FROM public.automation_outbox
  WHERE id = p_job_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_job IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF v_job.status <> 'PROCESSING' THEN
    RETURN QUERY SELECT 'invalid_state'::TEXT, v_job.status::TEXT;
    RETURN;
  END IF;

  -- Sanitasi defensif sisi DB (lapis kedua -- sanitasi utama sudah terjadi
  -- di TypeScript sebelum RPC dipanggil, lihat sanitizeAutomationError()):
  -- truncate 500 char, strip pola mirip Bearer token/header Authorization.
  v_sanitized_error := regexp_replace(COALESCE(p_error, ''), 'Bearer\s+\S+', 'Bearer [redacted]', 'gi');
  v_sanitized_error := regexp_replace(v_sanitized_error, 'Authorization:\s*\S+', 'Authorization: [redacted]', 'gi');
  v_sanitized_error := left(v_sanitized_error, 500);

  IF NOT p_retryable THEN
    UPDATE public.automation_outbox
    SET status = 'FAILED', failed_at = NOW(), last_error = v_sanitized_error,
        locked_at = NULL, locked_by = NULL
    WHERE id = p_job_id;

    INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
    VALUES (p_company_id, NULL, 'automation.job_failed', 'automation_outbox', p_job_id,
            jsonb_build_object('status', 'FAILED', 'retryable', FALSE, 'credential_id', p_credential_id));

    RETURN QUERY SELECT 'failed'::TEXT, 'FAILED'::TEXT;
    RETURN;
  END IF;

  IF v_job.attempt_count >= v_job.max_attempts THEN
    UPDATE public.automation_outbox
    SET status = 'DEAD_LETTER', failed_at = NOW(), last_error = v_sanitized_error,
        locked_at = NULL, locked_by = NULL
    WHERE id = p_job_id;

    INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
    VALUES (p_company_id, NULL, 'automation.job_dead_letter', 'automation_outbox', p_job_id,
            jsonb_build_object('status', 'DEAD_LETTER', 'attempt_count', v_job.attempt_count, 'credential_id', p_credential_id));

    RETURN QUERY SELECT 'dead_letter'::TEXT, 'DEAD_LETTER'::TEXT;
    RETURN;
  END IF;

  v_backoff_minutes := LEAST(POWER(2, v_job.attempt_count), 60);

  UPDATE public.automation_outbox
  SET status = 'RETRY', last_error = v_sanitized_error,
      available_at = NOW() + (v_backoff_minutes || ' minutes')::INTERVAL,
      locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, NULL, 'automation.job_retry_scheduled', 'automation_outbox', p_job_id,
          jsonb_build_object('status', 'RETRY', 'attempt_count', v_job.attempt_count, 'backoff_minutes', v_backoff_minutes, 'credential_id', p_credential_id));

  RETURN QUERY SELECT 'retry_scheduled'::TEXT, 'RETRY'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_automation_job(UUID, UUID, UUID, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_automation_job(UUID, UUID, UUID, TEXT, BOOLEAN)
  TO service_role;

-- ---------------------------------------------------------------------------
-- replay_automation_job: dipicu MANUSIA (dashboard, p_actor_id terisi) ATAU
-- credential n8n (dead-letter-monitor workflow, p_credential_id terisi) --
-- tepat satu dari keduanya wajib terisi. Reset job ke PENDING, attempt_count
-- direset ke 0 (kesempatan baru, disengaja -- ini aksi terkontrol manusia/
-- workflow eksplisit, bukan retry otomatis). TIDAK PERNAH menyentuh tabel
-- transaksi inti (sales_orders/sales_calls/dst) -- hanya baris outbox ini.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.replay_automation_job(
  p_company_id UUID,
  p_actor_id UUID,
  p_credential_id UUID,
  p_job_id UUID,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized BOOLEAN := FALSE;
  v_status TEXT;
BEGIN
  IF p_actor_id IS NULL AND p_credential_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF p_actor_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.users u
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
      JOIN public.roles r ON r.id = ur.role_id
      WHERE u.id = p_actor_id
        AND u.company_id = p_company_id
        AND u.is_active = TRUE
        AND r.name IN ('owner','manager','super_admin')
    ) INTO v_authorized;
  ELSIF p_credential_id IS NOT NULL THEN
    v_authorized := public.check_automation_credential_scope(p_credential_id, p_company_id, 'automation.replay');
  END IF;

  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RETURN QUERY SELECT 'reason_required'::TEXT;
    RETURN;
  END IF;

  SELECT status INTO v_status
  FROM public.automation_outbox
  WHERE id = p_job_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;
  IF v_status NOT IN ('DEAD_LETTER', 'FAILED') THEN
    RETURN QUERY SELECT 'invalid_state'::TEXT;
    RETURN;
  END IF;

  UPDATE public.automation_outbox
  SET status = 'PENDING', available_at = NOW(), attempt_count = 0,
      locked_at = NULL, locked_by = NULL, last_error = NULL, failed_at = NULL
  WHERE id = p_job_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (
    p_company_id, p_actor_id, 'automation.job_replayed', 'automation_outbox', p_job_id,
    jsonb_build_object('previous_status', v_status),
    jsonb_build_object(
      'reason', trim(p_reason),
      'triggered_via', CASE WHEN p_actor_id IS NOT NULL THEN 'dashboard' ELSE 'api' END,
      'credential_id', p_credential_id
    )
  );

  RETURN QUERY SELECT 'replayed'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.replay_automation_job(UUID, UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replay_automation_job(UUID, UUID, UUID, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- enqueue_automation_job: insert PENDING job baru dengan idempotency. Dipakai
-- oleh generator Morning Brief / KPI Daily Summary (lib/automation/service.ts
-- lewat repository) -- satu tempat definisi "cara aman membuat job baru"
-- supaya validasi scope+idempotency konsisten dan tidak bisa dilewati dari
-- TypeScript (mis. lupa cek idempotency sebelum insert).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_automation_job(
  p_company_id UUID,
  p_credential_id UUID,
  p_required_scope TEXT,
  p_event_type TEXT,
  p_channel TEXT,
  p_recipient_user_id UUID,
  p_recipient_reference TEXT,
  p_payload JSONB,
  p_idempotency_key TEXT,
  p_max_attempts INTEGER
)
RETURNS TABLE(result_outcome TEXT, job_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized BOOLEAN;
  v_existing_id UUID;
  v_new_id UUID;
BEGIN
  v_authorized := public.check_automation_credential_scope(p_credential_id, p_company_id, p_required_scope);
  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_event_type NOT IN ('MORNING_BRIEF', 'KPI_DAILY_SUMMARY') THEN
    RETURN QUERY SELECT 'invalid_event_type'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF p_channel NOT IN ('telegram', 'whatsapp') THEN
    RETURN QUERY SELECT 'invalid_channel'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN QUERY SELECT 'idempotency_key_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT id INTO v_existing_id
  FROM public.automation_outbox
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_exists'::TEXT, v_existing_id;
    RETURN;
  END IF;

  INSERT INTO public.automation_outbox (
    company_id, event_type, channel, recipient_user_id, recipient_reference,
    payload, idempotency_key, max_attempts, created_by_credential_id
  ) VALUES (
    p_company_id, p_event_type, p_channel, p_recipient_user_id, p_recipient_reference,
    p_payload, p_idempotency_key, COALESCE(p_max_attempts, 5), p_credential_id
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, NULL, 'automation.job_enqueued', 'automation_outbox', v_new_id,
          jsonb_build_object('event_type', p_event_type, 'channel', p_channel, 'credential_id', p_credential_id));

  RETURN QUERY SELECT 'enqueued'::TEXT, v_new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_automation_job(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, TEXT, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_automation_job(UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, JSONB, TEXT, INTEGER)
  TO service_role;
