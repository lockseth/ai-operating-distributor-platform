-- =============================================================================
-- Tutup Hari -- blocker "masih ada pekerjaan terbuka". Phase 1
-- (20260810000001) sengaja membuat close_daily_session TANPA blocker supaya
-- migration itu murni fondasi DB. Migration ini menambahkan SATU blocker
-- nyata: delivery non-terminal yang assigned_driver_id = salesman pemilik
-- session (salesman merangkap pengirim -- Waluyo Daily Operating Loop G).
--
-- "Kunjungan belum selesai" TIDAK dijadikan blocker terpisah: sales_calls
-- (20260805000001) tidak memiliki status "in-progress" -- satu Call selalu
-- atomic (tercatat VALID atau tidak pernah tercatat sama sekali, lihat
-- record_sales_call). Mengarang status "visit aktif" di sana akan melanggar
-- larangan "jangan mengubah counting rule KPI yang sudah PASS" dan
-- "jangan mengarang rule baru" -- satu-satunya representasi nyata dari
-- "pekerjaan hari ini belum selesai" pada data model saat ini adalah
-- delivery non-terminal. result_outcome 'blocked_open_visits' TETAP
-- dipertahankan di kontrak RPC (Phase 1) untuk kompatibilitas maju bila
-- Founder mengonfirmasi definisi "visit aktif" eksplisit di masa depan,
-- namun TIDAK PERNAH dikembalikan oleh versi fungsi ini -- lihat LIMITATION
-- di laporan akhir.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.close_daily_session(
  p_company_id UUID,
  p_actor_id UUID,
  p_session_id UUID,
  p_close_summary JSONB DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session RECORD;
  v_actor_allowed BOOLEAN;
  v_open_deliveries INTEGER;
BEGIN
  SELECT id, company_id, salesman_id, status
  INTO v_session
  FROM public.salesman_daily_sessions
  WHERE id = p_session_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    RETURN QUERY SELECT 'session_not_found'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND (u.id = v_session.salesman_id OR r.name IN ('owner','manager','super_admin'))
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF v_session.status = 'CLOSED' THEN
    RETURN QUERY SELECT 'already_closed'::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_open_deliveries
  FROM public.deliveries d
  WHERE d.company_id = p_company_id
    AND d.assigned_driver_id = v_session.salesman_id
    AND d.status NOT IN ('fully_received', 'partially_received', 'rejected', 'store_closed', 'failed', 'verified');

  IF v_open_deliveries > 0 THEN
    RETURN QUERY SELECT 'blocked_open_deliveries'::TEXT;
    RETURN;
  END IF;

  UPDATE public.salesman_daily_sessions
  SET status = 'CLOSED', closed_at = NOW(), closed_by = p_actor_id, close_summary = p_close_summary
  WHERE id = p_session_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'daily_session.closed', 'salesman_daily_sessions', p_session_id,
    jsonb_build_object('status', 'ACTIVE'),
    jsonb_build_object('status', 'CLOSED')
  );

  RETURN QUERY SELECT 'closed'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.close_daily_session(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_daily_session(UUID, UUID, UUID, JSONB)
  TO service_role;
