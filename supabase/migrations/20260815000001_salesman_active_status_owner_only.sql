-- =============================================================================
-- Gate 1B — Owner-Only Salesman Activation Lifecycle.
--
-- Menambahkan RPC untuk mengaktifkan/menonaktifkan Salesman existing.
-- Reuse field public.users.is_active (sudah ada sejak
-- 20260626000002_create_users_roles_permissions.sql) sebagai satu-satunya
-- sumber kebenaran status -- tidak ada field/tabel status paralel baru.
--
-- Mengikuti persis pola otorisasi & struktur assign_salesman_coverage_areas
-- (migration 20260814000001): actor harus role 'owner' aktif pada tenant yang
-- sama dengan target; target harus role 'sales' pada tenant yang sama (target
-- TIDAK disyaratkan is_active = TRUE di sini -- justru salesman yang SEDANG
-- nonaktif harus bisa ditemukan supaya bisa diaktifkan kembali); repeated
-- request terhadap status yang sama bersifat idempotent eksplisit ('unchanged',
-- tanpa audit palsu berulang); audit_logs ditulis dalam transaksi yang sama
-- dengan mutasi (bukan best-effort app-level).
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
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id,
    p_actor_id,
    CASE WHEN p_active THEN 'salesman.activated' ELSE 'salesman.deactivated' END,
    'users',
    p_user_id,
    jsonb_build_object('is_active', v_current_active),
    jsonb_build_object('is_active', p_active)
  );

  RETURN QUERY SELECT CASE WHEN p_active THEN 'activated' ELSE 'deactivated' END::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.set_salesman_active_status(UUID, UUID, BOOLEAN, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_salesman_active_status(UUID, UUID, BOOLEAN, UUID)
  TO service_role;
