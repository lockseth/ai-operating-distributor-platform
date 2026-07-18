-- =============================================================================
-- Salesman Coverage Area
--
-- Model relasi (bukan kolom users.area tunggal) supaya satu Salesman dapat
-- menangani beberapa wilayah. Wilayah yang valid berasal dari konfigurasi
-- tenant (companies.settings.coverage_areas, JSONB array of string — sudah
-- dipakai gate Demo Environment), bukan hardcode nama wilayah/tenant apa
-- pun di core platform.
--
-- Security contract:
--   * Semua mutasi (assign/replace) HANYA lewat RPC SECURITY DEFINER
--     assign_salesman_coverage_areas — memvalidasi actor, target, dan
--     keanggotaan wilayah terhadap companies.settings.coverage_areas SEBELUM
--     menyentuh baris apa pun (fail-closed, tidak ada state parsial).
--   * Read langsung ke tabel tetap diizinkan (RLS) untuk role
--     owner/manager/admin/super_admin pada tenant yang sama, dipakai UI
--     daftar/detail Salesman.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.salesman_coverage_areas (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  user_id     UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  area        VARCHAR(100) NOT NULL,
  created_by  UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id, area)
);

CREATE INDEX idx_salesman_coverage_company ON public.salesman_coverage_areas (company_id);
CREATE INDEX idx_salesman_coverage_user    ON public.salesman_coverage_areas (company_id, user_id);

COMMENT ON TABLE public.salesman_coverage_areas IS
  'Wilayah kerja Salesman (relasi many-to-many company-scoped). area harus anggota companies.settings.coverage_areas pada saat assignment — divalidasi di RPC, bukan CHECK statis (daftar wilayah per-tenant, dinamis).';

ALTER TABLE public.salesman_coverage_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sca_select" ON public.salesman_coverage_areas
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

REVOKE ALL ON TABLE public.salesman_coverage_areas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.salesman_coverage_areas TO authenticated;

-- ---------------------------------------------------------------------------
-- Atomic assign/replace. company_id dan actor_id datang dari sesi server
-- (Server Action) — RPC tetap independen memverifikasi actor, target, dan
-- keanggotaan wilayah. Pola "replace penuh" (hapus lalu insert ulang) dalam
-- satu function call membuat pemanggilan berulang dengan wilayah yang sama
-- otomatis idempotent, dan tidak pernah menyisakan state parsial karena
-- seluruh validasi terjadi SEBELUM baris apa pun disentuh.
-- ---------------------------------------------------------------------------
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
      AND r.name IN ('owner','manager','admin','super_admin')
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
