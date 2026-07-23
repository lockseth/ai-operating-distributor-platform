-- =============================================================================
-- Wilayah Penjualan (Coverage Areas) — Master Normalization (Owner Control
-- Gate 1A Closure)
--
-- Masalah yang diperbaiki: companies.settings.coverage_areas (JSONB array of
-- string, migration 20260724000001/20260813000001) dan customers.area (free
-- text, migration 20260626000010) adalah DUA sumber kebenaran wilayah yang
-- terpisah -- Toko dan Salesman tidak pernah mereferensikan record yang sama.
-- Migration ini membuat SATU master ber-ID stabil (public.coverage_areas) dan
-- menyambungkan customers + salesman_coverage_areas ke situ lewat
-- coverage_area_id, tanpa menghapus data lama (kota/area lama tetap ada
-- sebagai data alamat historis, tidak lagi menjadi sumber assignment wilayah).
--
-- Prinsip backfill: HANYA migrasikan yang benar-benar eksplisit dan aman.
--   * companies.settings.coverage_areas -> satu baris coverage_areas per nama
--     unik (case-insensitive) per tenant -- ini SUDAH merupakan daftar resmi
--     wilayah tenant, jadi seluruhnya di-backfill.
--   * customers.area (free text lama) HANYA di-set coverage_area_id bila
--     nilainya persis (case-insensitive, trim) sama dengan salah satu nama
--     wilayah resmi tenant tsb. Sisanya dibiarkan NULL ("Belum ditetapkan")
--     -- tidak pernah menebak.
--   * salesman_coverage_areas.area (sudah tervalidasi terhadap
--     companies.settings.coverage_areas oleh RPC lama) di-backfill by exact
--     match -- seharusnya 100% cocok by construction.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Master table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.coverage_areas (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by  UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_coverage_areas_company_name
  ON public.coverage_areas (company_id, LOWER(TRIM(name)));
CREATE INDEX IF NOT EXISTS idx_coverage_areas_company ON public.coverage_areas (company_id);
CREATE INDEX IF NOT EXISTS idx_coverage_areas_company_active ON public.coverage_areas (company_id, is_active);

COMMENT ON TABLE public.coverage_areas IS
  'Satu-satunya master "Wilayah Penjualan" resmi per tenant. Toko (customers.coverage_area_id) dan Salesman (salesman_coverage_areas.coverage_area_id) WAJIB mereferensikan baris di sini. Tidak pernah hard-delete -- gunakan is_active.';

DROP TRIGGER IF EXISTS trg_coverage_areas_updated_at ON public.coverage_areas;
CREATE TRIGGER trg_coverage_areas_updated_at
  BEFORE UPDATE ON public.coverage_areas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.coverage_areas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coverage_areas_select" ON public.coverage_areas;
CREATE POLICY "coverage_areas_select" ON public.coverage_areas
  FOR SELECT USING (company_id = public.get_user_company_id());

-- Semua mutasi HANYA lewat RPC SECURITY DEFINER di bawah (fail-closed,
-- owner-only, tervalidasi di database) -- tidak ada policy INSERT/UPDATE/
-- DELETE untuk role authenticated.
REVOKE ALL ON TABLE public.coverage_areas FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.coverage_areas TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Backfill dari companies.settings.coverage_areas (+ coverage_area_notes)
-- ---------------------------------------------------------------------------

INSERT INTO public.coverage_areas (company_id, name, description, is_active)
SELECT
  c.id,
  TRIM(area_name),
  NULLIF(TRIM(COALESCE(c.settings -> 'coverage_area_notes' ->> area_name, '')), ''),
  TRUE
FROM public.companies c,
     LATERAL jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(c.settings -> 'coverage_areas') = 'array'
            THEN c.settings -> 'coverage_areas'
            ELSE '[]'::jsonb
       END
     ) AS area_name
WHERE TRIM(area_name) <> ''
ON CONFLICT (company_id, LOWER(TRIM(name))) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. customers.coverage_area_id
-- ---------------------------------------------------------------------------

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS coverage_area_id UUID REFERENCES public.coverage_areas (id);

CREATE INDEX IF NOT EXISTS idx_customers_coverage_area_id ON public.customers (coverage_area_id);

COMMENT ON COLUMN public.customers.coverage_area_id IS
  'Wilayah Penjualan resmi (FK coverage_areas). customers.area/city lama tetap ada sebagai data alamat historis -- TIDAK lagi sumber assignment wilayah.';

-- Backfill eksplisit: hanya bila customers.area lama persis cocok (case-
-- insensitive, trim) dengan nama wilayah resmi tenant yang sama. Idempotent
-- (hanya menyentuh baris yang masih NULL).
UPDATE public.customers cu
SET coverage_area_id = ca.id
FROM public.coverage_areas ca
WHERE ca.company_id = cu.company_id
  AND cu.coverage_area_id IS NULL
  AND cu.area IS NOT NULL
  AND LOWER(TRIM(cu.area)) = LOWER(TRIM(ca.name));

-- Tenant isolation enforcement di level database -- independen dari jalur
-- tulis manapun (RLS session client ATAU admin client), supaya
-- coverage_area_id tenant lain selalu ditolak walau app layer lolos.
CREATE OR REPLACE FUNCTION public.enforce_customer_coverage_area_tenant()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.coverage_area_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.coverage_areas ca
      WHERE ca.id = NEW.coverage_area_id AND ca.company_id = NEW.company_id
    ) THEN
      RAISE EXCEPTION 'coverage_area_id % tidak valid untuk tenant %', NEW.coverage_area_id, NEW.company_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_customers_coverage_area_tenant ON public.customers;
CREATE TRIGGER trg_customers_coverage_area_tenant
  BEFORE INSERT OR UPDATE OF coverage_area_id ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_coverage_area_tenant();

-- ---------------------------------------------------------------------------
-- 4. salesman_coverage_areas.coverage_area_id
-- ---------------------------------------------------------------------------

ALTER TABLE public.salesman_coverage_areas
  ADD COLUMN IF NOT EXISTS coverage_area_id UUID REFERENCES public.coverage_areas (id);

CREATE INDEX IF NOT EXISTS idx_sca_coverage_area_id ON public.salesman_coverage_areas (coverage_area_id);

COMMENT ON COLUMN public.salesman_coverage_areas.coverage_area_id IS
  'Wilayah Penjualan resmi (FK coverage_areas). Kolom area (TEXT) dipertahankan sebagai mirror read-only untuk consumer lama (Telegram webhook, n8n directory, daily-session agenda) yang membaca teks langsung -- disinkronkan oleh update_coverage_area saat rename, tidak pernah ditulis independen oleh kode baru.';

-- Backfill: area (TEXT, sudah tervalidasi terhadap companies.settings.
-- coverage_areas oleh RPC lama) dicocokkan exact ke coverage_areas.name pada
-- tenant yang sama -- seharusnya selalu cocok by construction (baris 2 di
-- atas membackfill dari array JSONB yang sama persis).
UPDATE public.salesman_coverage_areas sca
SET coverage_area_id = ca.id
FROM public.coverage_areas ca
WHERE ca.company_id = sca.company_id
  AND sca.coverage_area_id IS NULL
  AND LOWER(TRIM(sca.area)) = LOWER(TRIM(ca.name));

-- ---------------------------------------------------------------------------
-- 5. assign_salesman_coverage_areas — ganti kontrak dari TEXT[] nama wilayah
--    menjadi UUID[] coverage_area_id. Signature berubah (tipe parameter
--    berbeda) -- DROP eksplisit dulu supaya tidak menyisakan overload lama
--    dengan grant yang stale.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.assign_salesman_coverage_areas(UUID, UUID, TEXT[], UUID);

CREATE OR REPLACE FUNCTION public.assign_salesman_coverage_areas(
  p_company_id UUID,
  p_user_id UUID,
  p_area_ids UUID[],
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
  v_distinct_ids UUID[];
  v_existing_ids UUID[];
  v_id UUID;
  v_area RECORD;
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

  SELECT ARRAY(SELECT DISTINCT a FROM unnest(COALESCE(p_area_ids, ARRAY[]::UUID[])) AS a)
  INTO v_distinct_ids;

  IF v_distinct_ids IS NULL OR array_length(v_distinct_ids, 1) IS NULL THEN
    RETURN QUERY SELECT 'no_areas_provided'::TEXT, 0;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.coverage_areas WHERE company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'no_coverage_configured'::TEXT, 0;
    RETURN;
  END IF;

  -- Serialize per-Salesman supaya dua submit bersamaan tidak saling balapan.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 1));

  SELECT COALESCE(array_agg(coverage_area_id), ARRAY[]::UUID[])
  INTO v_existing_ids
  FROM public.salesman_coverage_areas
  WHERE company_id = p_company_id AND user_id = p_user_id;

  FOREACH v_id IN ARRAY v_distinct_ids LOOP
    SELECT * INTO v_area FROM public.coverage_areas
    WHERE id = v_id AND company_id = p_company_id;

    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invalid_area'::TEXT, 0;
      RETURN;
    END IF;

    -- Wilayah nonaktif tidak boleh dipilih untuk assignment BARU -- tapi
    -- assignment existing ke wilayah yang belakangan dinonaktifkan tetap
    -- boleh dipertahankan (histori tidak hilang).
    IF NOT v_area.is_active AND NOT (v_id = ANY(v_existing_ids)) THEN
      RETURN QUERY SELECT 'invalid_area'::TEXT, 0;
      RETURN;
    END IF;
  END LOOP;

  SELECT COALESCE(jsonb_agg(area), '[]'::jsonb)
  INTO v_old_areas
  FROM public.salesman_coverage_areas
  WHERE company_id = p_company_id AND user_id = p_user_id;

  DELETE FROM public.salesman_coverage_areas
  WHERE company_id = p_company_id AND user_id = p_user_id;

  INSERT INTO public.salesman_coverage_areas (company_id, user_id, area, coverage_area_id, created_by)
  SELECT p_company_id, p_user_id, ca.name, ca.id, p_actor_id
  FROM public.coverage_areas ca
  WHERE ca.id = ANY(v_distinct_ids);

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id,
    p_actor_id,
    'salesman.coverage_area_updated',
    'salesman_coverage_areas',
    p_user_id,
    jsonb_build_object('areas', v_old_areas),
    jsonb_build_object('area_ids', to_jsonb(v_distinct_ids))
  );

  RETURN QUERY SELECT 'assigned'::TEXT, array_length(v_distinct_ids, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.assign_salesman_coverage_areas(UUID, UUID, UUID[], UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_salesman_coverage_areas(UUID, UUID, UUID[], UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6. create_coverage_area — Owner Control Gate 1A, menulis LANGSUNG ke master
--    normalized (menggantikan add_company_coverage_area berbasis JSONB pada
--    migration 20260813000001 -- fungsi lama TETAP ADA sebagai riwayat tak
--    terpakai, service_role-only, tidak lagi dipanggil kode aplikasi mana pun
--    setelah migration ini).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_coverage_area(
  p_company_id UUID,
  p_actor_id UUID,
  p_name TEXT,
  p_description TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  area_id UUID,
  area_name TEXT,
  area_description TEXT,
  area_is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_name TEXT;
  v_description TEXT;
  v_new_id UUID;
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
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  v_name := TRIM(COALESCE(p_name, ''));
  IF v_name = '' OR LENGTH(v_name) > 100 THEN
    RETURN QUERY SELECT 'invalid_name'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  v_description := NULLIF(TRIM(COALESCE(p_description, '')), '');

  -- Serialize per-tenant supaya dua submit "wilayah baru" bersamaan tidak
  -- saling balapan dan tidak menghasilkan duplikat.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::TEXT, 3));

  IF EXISTS (
    SELECT 1 FROM public.coverage_areas
    WHERE company_id = p_company_id AND LOWER(TRIM(name)) = LOWER(v_name)
  ) THEN
    RETURN QUERY SELECT 'duplicate_area'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  INSERT INTO public.coverage_areas (company_id, name, description, is_active, created_by)
  VALUES (p_company_id, v_name, v_description, TRUE, p_actor_id)
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'coverage_area.created', 'coverage_areas', v_new_id,
    NULL, jsonb_build_object('name', v_name, 'description', v_description)
  );

  RETURN QUERY SELECT 'created'::TEXT, v_new_id, v_name, v_description, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.create_coverage_area(UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_coverage_area(UUID, UUID, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. update_coverage_area — rename/keterangan. Menyinkronkan mirror
--    salesman_coverage_areas.area supaya consumer lama tetap konsisten tanpa
--    perlu diubah (di luar scope gate ini).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_coverage_area(
  p_company_id UUID,
  p_actor_id UUID,
  p_area_id UUID,
  p_name TEXT,
  p_description TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  area_id UUID,
  area_name TEXT,
  area_description TEXT,
  area_is_active BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_name TEXT;
  v_description TEXT;
  v_old RECORD;
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
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  v_name := TRIM(COALESCE(p_name, ''));
  IF v_name = '' OR LENGTH(v_name) > 100 THEN
    RETURN QUERY SELECT 'invalid_name'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;
  v_description := NULLIF(TRIM(COALESCE(p_description, '')), '');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::TEXT, 3));

  SELECT * INTO v_old FROM public.coverage_areas
  WHERE id = p_area_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.coverage_areas
    WHERE company_id = p_company_id
      AND id <> p_area_id
      AND LOWER(TRIM(name)) = LOWER(v_name)
  ) THEN
    RETURN QUERY SELECT 'duplicate_area'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN;
    RETURN;
  END IF;

  UPDATE public.coverage_areas
  SET name = v_name, description = v_description
  WHERE id = p_area_id AND company_id = p_company_id;

  -- Sinkronkan mirror TEXT untuk consumer lama (Telegram webhook, n8n
  -- directory, daily-session agenda) -- satu-satunya penulis kolom area
  -- sekarang adalah fungsi ini + assign_salesman_coverage_areas.
  UPDATE public.salesman_coverage_areas
  SET area = v_name
  WHERE coverage_area_id = p_area_id AND company_id = p_company_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'coverage_area.updated', 'coverage_areas', p_area_id,
    jsonb_build_object('name', v_old.name, 'description', v_old.description),
    jsonb_build_object('name', v_name, 'description', v_description)
  );

  RETURN QUERY SELECT 'updated'::TEXT, p_area_id, v_name, v_description, v_old.is_active;
END;
$$;

REVOKE ALL ON FUNCTION public.update_coverage_area(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_coverage_area(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 8. set_coverage_area_active_status — aktifkan/nonaktifkan. Tidak pernah
--    menghapus baris atau assignment existing manapun.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_coverage_area_active_status(
  p_company_id UUID,
  p_actor_id UUID,
  p_area_id UUID,
  p_is_active BOOLEAN
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_old RECORD;
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

  SELECT * INTO v_old FROM public.coverage_areas
  WHERE id = p_area_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF v_old.is_active = p_is_active THEN
    RETURN QUERY SELECT 'unchanged'::TEXT;
    RETURN;
  END IF;

  UPDATE public.coverage_areas SET is_active = p_is_active
  WHERE id = p_area_id AND company_id = p_company_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id,
    CASE WHEN p_is_active THEN 'coverage_area.activated' ELSE 'coverage_area.deactivated' END,
    'coverage_areas', p_area_id,
    jsonb_build_object('is_active', v_old.is_active),
    jsonb_build_object('is_active', p_is_active)
  );

  RETURN QUERY SELECT (CASE WHEN p_is_active THEN 'activated' ELSE 'deactivated' END)::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.set_coverage_area_active_status(UUID, UUID, UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_coverage_area_active_status(UUID, UUID, UUID, BOOLEAN)
  TO service_role;
