-- =============================================================================
-- Gate P4.12 -- Laporan Sales Fase B varian PAGI: event type baru
-- COLLECTION_PLAN_MORNING untuk Automation Outbox (migration 20260807000001,
-- diperluas 20261013000001). Rencana penagihan Owner -- "toko yang mau
-- ditagih" hari itu, definisi dikonfirmasi Founder 2026-08-22: overdue H+1
-- (invoice lewat jatuh tempo minimal 1 hari) DAN/ATAU janji bayar H+1
-- (promises_to_pay masih 'open' tapi promised_date sudah lewat minimal
-- 1 hari). Channel selalu 'whatsapp', dispatch tetap SELALU dry-run (lihat
-- /api/internal/automation/dispatch, tidak berubah migration ini -- dry-run
-- itu channel-based, bukan event-based).
--
-- Scope credential baru yang dipakai: automation.collection_plan.generate
-- (TEXT[] tanpa CHECK constraint terhadap isi, tidak perlu ALTER TABLE
-- terpisah -- lihat catatan migration 20260807000001).
-- =============================================================================

ALTER TABLE public.automation_outbox
  DROP CONSTRAINT automation_outbox_event_type_check;

ALTER TABLE public.automation_outbox
  ADD CONSTRAINT automation_outbox_event_type_check
  CHECK (event_type IN ('MORNING_BRIEF', 'KPI_DAILY_SUMMARY', 'SALES_REPORT_AFTERNOON', 'COLLECTION_PLAN_MORNING'));

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

  IF p_event_type NOT IN ('MORNING_BRIEF', 'KPI_DAILY_SUMMARY', 'SALES_REPORT_AFTERNOON', 'COLLECTION_PLAN_MORNING') THEN
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
