-- =============================================================================
-- Fix kosmetik ditemukan saat verifikasi Gate P4.15 (Morning Brief -> WhatsApp,
-- 2026-08-22): complete_automation_job() menandai job SENT tapi TIDAK
-- membersihkan last_error dari percobaan gagal sebelumnya -- job yang sukses
-- di retry ke-2 tetap menampilkan pesan error lama di kolom last_error,
-- menyesatkan siapa pun yang baca automation_outbox (terlihat error padahal
-- status sudah SENT). Fix: last_error = NULL saat berhasil complete.
-- =============================================================================

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
      last_error = NULL, locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, NULL, 'automation.job_completed', 'automation_outbox', p_job_id,
          jsonb_build_object('provider_message_id', p_provider_message_id, 'credential_id', p_credential_id));

  RETURN QUERY SELECT 'completed'::TEXT;
END;
$$;
