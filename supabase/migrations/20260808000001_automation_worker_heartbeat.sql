-- =============================================================================
-- n8n Automation Foundation -- Worker Heartbeat (targeted closure gate).
--
-- Masalah yang diperbaiki: sebelumnya "n8n_polling_healthy" di /health hanya
-- HEURISTIK dari aktivitas claim (backlog + waktu claim terakhir) -- tidak
-- pernah benar-benar membuktikan n8n itu sendiri hidup/reachable, hanya
-- menebak dari efek sampingnya. Migration ini menambah heartbeat EKSPLISIT:
-- n8n (lewat workflow aodp-health-check) memanggil endpoint baru
-- /api/internal/automation/heartbeat pada setiap jadwalnya; AODP mencatat
-- last_heartbeat_at per credential. Reachability jadi bukti langsung, bukan
-- inferensi. TETAP tidak membuat AODP bergantung pada n8n -- ini murni
-- record-keeping satu kolom, tidak ada alur order/transaksi yang membaca
-- kolom ini; jika n8n tidak pernah memanggil heartbeat, kolom tetap NULL dan
-- /health cukup melaporkan "belum pernah terpakai" (bukan unhealthy).
-- =============================================================================

ALTER TABLE public.n8n_inbound_credentials
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

COMMENT ON COLUMN public.n8n_inbound_credentials.last_heartbeat_at IS
  'Waktu heartbeat terakhir dari n8n via record_automation_heartbeat(). NULL berarti heartbeat belum pernah dipakai credential ini -- bukan tanda tidak sehat.';

CREATE OR REPLACE FUNCTION public.record_automation_heartbeat(
  p_company_id UUID,
  p_credential_id UUID,
  p_worker_label TEXT
)
RETURNS TABLE(result_outcome TEXT, heartbeat_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized BOOLEAN;
  v_heartbeat_at TIMESTAMPTZ;
BEGIN
  v_authorized := public.check_automation_credential_scope(p_credential_id, p_company_id, 'automation.health');
  IF NOT v_authorized THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  UPDATE public.n8n_inbound_credentials
  SET last_heartbeat_at = NOW()
  WHERE id = p_credential_id AND company_id = p_company_id
  RETURNING last_heartbeat_at INTO v_heartbeat_at;

  -- p_worker_label sengaja tidak disimpan (heartbeat frekuensi tinggi, bukan
  -- state transition penting) -- konsisten dengan locked_by yang HANYA untuk
  -- audit trace di claim, bukan diaudit tiap heartbeat.
  PERFORM p_worker_label;

  RETURN QUERY SELECT 'recorded'::TEXT, v_heartbeat_at;
END;
$$;

REVOKE ALL ON FUNCTION public.record_automation_heartbeat(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_automation_heartbeat(UUID, UUID, TEXT)
  TO service_role;
