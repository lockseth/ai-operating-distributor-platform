-- =============================================================================
-- Owner Control Plane consistency (corrective closure, follow-up dari
-- 20260813000001_company_coverage_area_management.sql).
--
-- Keputusan final: Tambah Salesman, Tambah Wilayah, dan Ubah Wilayah
-- Salesman existing adalah SATU domain Owner Control Plane -- ketiganya
-- WAJIB memakai model otorisasi yang sama persis (owner-only), bukan
-- MANAGE_ROLES lama (owner/manager/admin/super_admin).
--
-- Mempersempit actor check pada assign_salesman_coverage_areas (migration
-- 20260724000001) dari role IN ('owner','manager','admin','super_admin')
-- menjadi role = 'owner'. Semua bagian lain dari function (validasi target
-- harus sales aktif, validasi area terhadap companies.settings.
-- coverage_areas, advisory lock, replace penuh, audit_logs) TIDAK berubah --
-- tenant isolation, semantics replace, dan audit trail tetap identik.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.assign_salesman_coverage_areas(
  p_company_id UUID,
  p_user_id UUID,
  p_areas TEXT[],
  p_actor_id UUID
)
RETURNS TABLE(result_outcome TEXT, assigned_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_target_allowed BOOLEAN;
  v_available_areas JSONB;
  v_area TEXT;
  v_distinct_areas TEXT[];
  v_old_areas JSONB;
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
    RETURN QUERY SELECT 'forbidden'::TEXT, 0;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_user_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'sales'
  ) INTO v_target_allowed;

  IF NOT v_target_allowed THEN
    RETURN QUERY SELECT 'not_eligible'::TEXT, 0;
    RETURN;
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT TRIM(a)
    FROM unnest(COALESCE(p_areas, ARRAY[]::TEXT[])) AS a
    WHERE TRIM(a) <> ''
  ) INTO v_distinct_areas;

  IF v_distinct_areas IS NULL OR array_length(v_distinct_areas, 1) IS NULL THEN
    RETURN QUERY SELECT 'no_areas_provided'::TEXT, 0;
    RETURN;
  END IF;

  SELECT c.settings -> 'coverage_areas'
  INTO v_available_areas
  FROM public.companies c
  WHERE c.id = p_company_id;

  IF v_available_areas IS NULL
     OR jsonb_typeof(v_available_areas) <> 'array'
     OR jsonb_array_length(v_available_areas) = 0 THEN
    RETURN QUERY SELECT 'no_coverage_configured'::TEXT, 0;
    RETURN;
  END IF;

  FOREACH v_area IN ARRAY v_distinct_areas LOOP
    IF NOT (v_available_areas ? v_area) THEN
      RETURN QUERY SELECT 'invalid_area'::TEXT, 0;
      RETURN;
    END IF;
  END LOOP;

  -- Serialize per-Salesman supaya dua submit bersamaan tidak saling balapan.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 1));

  SELECT COALESCE(jsonb_agg(area), '[]'::jsonb)
  INTO v_old_areas
  FROM public.salesman_coverage_areas
  WHERE company_id = p_company_id AND user_id = p_user_id;

  DELETE FROM public.salesman_coverage_areas
  WHERE company_id = p_company_id AND user_id = p_user_id;

  INSERT INTO public.salesman_coverage_areas (company_id, user_id, area, created_by)
  SELECT p_company_id, p_user_id, a, p_actor_id
  FROM unnest(v_distinct_areas) AS a;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id,
    p_actor_id,
    'salesman.coverage_area_updated',
    'salesman_coverage_areas',
    p_user_id,
    jsonb_build_object('areas', v_old_areas),
    jsonb_build_object('areas', to_jsonb(v_distinct_areas))
  );

  RETURN QUERY SELECT 'assigned'::TEXT, array_length(v_distinct_areas, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_salesman_coverage_areas(UUID, UUID, TEXT[], UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_salesman_coverage_areas(UUID, UUID, TEXT[], UUID)
  TO service_role;
