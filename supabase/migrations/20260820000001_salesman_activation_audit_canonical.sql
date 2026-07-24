-- =============================================================================
-- Gate 1D-B1 — Retrofit audit writer kanonis: Salesman activation/deactivation.
--
-- set_salesman_active_status (migration 20260815000001, Gate 1B) SUDAH menulis
-- audit_logs secara atomik di transaksi yang sama dengan mutasi is_active --
-- BUKAN best-effort/fire-and-forget, BUKAN app-layer server action. Gap
-- sesungguhnya (lihat docs/owner-control/ACTIVITY_AUDIT_COVERAGE_MATRIX.md,
-- baris "Pengguna": status partial): kolom kanonis baru dari migration
-- 20260819000001 (actor_type, event_category, module, source, outcome) belum
-- diisi oleh writer ini.
--
-- Migration ini CREATE OR REPLACE fungsi yang sama dengan signature IDENTIK --
-- HANYA menambah kolom pada INSERT INTO audit_logs yang sudah ada. TIDAK ada
-- perubahan pada logic otorisasi (owner-only, tenant match), advisory lock,
-- atau idempotency Gate 1B -- outcome forbidden/not_found/not_eligible/
-- unchanged persis sama seperti sebelumnya, dan cabang 'unchanged' TETAP
-- return sebelum baris UPDATE/INSERT manapun (tidak ada audit palsu utk no-op).
--
-- Nilai kanonis baru (semua berasal dari state yang sudah divalidasi RPC di
-- atas baris INSERT ini -- bukan dari input client):
--   actor_type     = 'owner'   (v_actor_allowed sudah memastikan actor adalah
--                                owner aktif pada tenant yang sama sebelum
--                                baris ini bisa tercapai)
--   event_category = 'audit'   (perubahan data, bukan activity/security)
--   module         = 'salesman'
--   source         = 'rpc'     (writer SECURITY DEFINER, bukan app-layer)
--   outcome        = 'success' (baris ini hanya tereksekusi saat status BENAR
--                                berubah -- 'unchanged' RETURN QUERY di atas
--                                dan TIDAK PERNAH mencapai INSERT ini)
-- reason/metadata/request_id sengaja TIDAK diisi (tidak ada informasi aman
-- tambahan di luar apa yang sudah tercatat di old_data/new_data/actor/entity).
--
-- Atomicity tidak berubah: masih satu fungsi PL/pgSQL tanpa blok
-- EXCEPTION -- kegagalan INSERT audit (mis. pelanggaran CHECK constraint)
-- membatalkan seluruh pemanggilan fungsi, sehingga UPDATE public.users di
-- atasnya ikut rollback (tidak ada jalur commit-tanpa-audit).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_salesman_active_status(
  p_company_id UUID,
  p_user_id UUID,
  p_active BOOLEAN,
  p_actor_id UUID
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_current_active BOOLEAN;
  v_target_is_sales BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  -- Serialize per-Salesman supaya toggle bersamaan tidak saling balapan
  -- (konsisten dengan advisory lock di assign_salesman_coverage_areas).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 2));

  SELECT u.is_active,
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.user_id = u.id AND ur.company_id = u.company_id AND r.name = 'sales'
    )
  INTO v_current_active, v_target_is_sales
  FROM public.users u
  WHERE u.id = p_user_id AND u.company_id = p_company_id;

  IF v_current_active IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF NOT v_target_is_sales THEN
    RETURN QUERY SELECT 'not_eligible'::TEXT;
    RETURN;
  END IF;

  IF v_current_active = p_active THEN
    RETURN QUERY SELECT 'unchanged'::TEXT;
    RETURN;
  END IF;

  UPDATE public.users
  SET is_active = p_active
  WHERE id = p_user_id AND company_id = p_company_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id,
    p_actor_id,
    CASE WHEN p_active THEN 'salesman.activated' ELSE 'salesman.deactivated' END,
    'users',
    p_user_id,
    jsonb_build_object('is_active', v_current_active),
    jsonb_build_object('is_active', p_active),
    'owner',
    'audit',
    'salesman',
    'rpc',
    'success'
  );

  RETURN QUERY SELECT CASE WHEN p_active THEN 'activated' ELSE 'deactivated' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.set_salesman_active_status(UUID, UUID, BOOLEAN, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_salesman_active_status(UUID, UUID, BOOLEAN, UUID)
  TO service_role;
