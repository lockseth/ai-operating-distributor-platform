-- =============================================================================
-- Company Coverage Area Management (Owner Control Gate 1A)
--
-- Owner AODP membuat wilayah kerja tenant langsung dari form Tambah Salesman.
-- Reuse penuh struktur existing: companies.settings.coverage_areas (JSONB
-- array of string) tetap sumber kebenaran yang sudah dipakai
-- assign_salesman_coverage_areas, create_store_with_pic, telegram webhook,
-- n8n directory, dan daily-session agenda (migration 20260724000001 dst) --
-- TIDAK diubah bentuknya, hanya ditambah (append) lewat RPC baru ini supaya
-- seluruh consumer existing tetap kompatibel tanpa perubahan.
--
-- Keterangan (opsional) disimpan terpisah di companies.settings.
-- coverage_area_notes (map nama wilayah -> keterangan) -- murni aditif,
-- tidak pernah dibaca oleh consumer existing manapun.
--
-- Security contract: SECURITY DEFINER, fail-closed. Actor WAJIB role
-- 'owner' aktif pada tenant tsb (lebih ketat dari
-- assign_salesman_coverage_areas yang mengizinkan manager/admin/super_admin
-- untuk mengubah assignment Salesman existing -- gate ini KHUSUS untuk
-- kemampuan baru "membuat wilayah", bukan perubahan wewenang fitur lama).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.add_company_coverage_area(
  p_company_id UUID,
  p_actor_id UUID,
  p_name TEXT,
  p_description TEXT
)
RETURNS TABLE(result_outcome TEXT, updated_areas TEXT[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_name TEXT;
  v_description TEXT;
  v_settings JSONB;
  v_areas JSONB;
  v_notes JSONB;
  v_existing TEXT;
  v_new_areas JSONB;
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
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT[];
    RETURN;
  END IF;

  v_name := TRIM(COALESCE(p_name, ''));
  IF v_name = '' OR LENGTH(v_name) > 100 THEN
    RETURN QUERY SELECT 'invalid_name'::TEXT, NULL::TEXT[];
    RETURN;
  END IF;

  v_description := NULLIF(TRIM(COALESCE(p_description, '')), '');

  -- Serialize per-tenant supaya dua submit "wilayah baru" bersamaan tidak
  -- saling balapan dan tidak menghasilkan duplikat.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::TEXT, 3));

  SELECT COALESCE(c.settings, '{}'::jsonb) INTO v_settings
  FROM public.companies c
  WHERE c.id = p_company_id
  FOR UPDATE;

  v_areas := COALESCE(v_settings -> 'coverage_areas', '[]'::jsonb);
  IF jsonb_typeof(v_areas) <> 'array' THEN
    v_areas := '[]'::jsonb;
  END IF;

  FOR v_existing IN SELECT jsonb_array_elements_text(v_areas) LOOP
    IF LOWER(TRIM(v_existing)) = LOWER(v_name) THEN
      RETURN QUERY SELECT 'duplicate_area'::TEXT, NULL::TEXT[];
      RETURN;
    END IF;
  END LOOP;

  v_new_areas := v_areas || to_jsonb(v_name);
  v_settings := jsonb_set(v_settings, '{coverage_areas}', v_new_areas, true);

  IF v_description IS NOT NULL THEN
    v_notes := COALESCE(v_settings -> 'coverage_area_notes', '{}'::jsonb);
    IF jsonb_typeof(v_notes) <> 'object' THEN
      v_notes := '{}'::jsonb;
    END IF;
    v_notes := v_notes || jsonb_build_object(v_name, v_description);
    v_settings := jsonb_set(v_settings, '{coverage_area_notes}', v_notes, true);
  END IF;

  UPDATE public.companies SET settings = v_settings WHERE id = p_company_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id,
    p_actor_id,
    'tenant.coverage_area_created',
    'companies',
    p_company_id,
    jsonb_build_object('areas', v_areas),
    jsonb_build_object('area', v_name, 'description', v_description)
  );

  RETURN QUERY SELECT 'created'::TEXT, ARRAY(SELECT jsonb_array_elements_text(v_new_areas));
END;
$$;

REVOKE ALL ON FUNCTION public.add_company_coverage_area(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_company_coverage_area(UUID, UUID, TEXT, TEXT)
  TO service_role;
