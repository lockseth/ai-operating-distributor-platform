-- =============================================================================
-- Coverage Area — Operational Read/Write Path Closure (Gate 1A)
--
-- Masalah: migration 20260816000001 membuat public.coverage_areas sebagai
-- master normalized dan mengalihkan create_coverage_area/update_coverage_area/
-- assign_salesman_coverage_areas ke tabel tsb -- TAPI create_store_with_pic
-- (RPC pembuatan toko, dipakai alur Telegram Salesman & Admin Dashboard)
-- MASIH memvalidasi p_store_area terhadap companies.settings.coverage_areas
-- (JSONB legacy) yang SEJAK migration 20260816 tidak lagi ditulis oleh RPC
-- manapun. Akibatnya: wilayah baru yang dibuat Owner lewat create_coverage_area
-- tidak pernah dikenali create_store_with_pic -> toko baru di wilayah tsb
-- selalu ditolak 'invalid_area' walau wilayahnya valid di master. Ini adalah
-- legacy reader aktif yang menghalangi closure Gate 1A.
--
-- Perbaikan (aditif, tidak menghapus data lama):
--   1. create_store_with_pic memvalidasi p_store_area terhadap
--      public.coverage_areas (tenant-scoped, is_active = TRUE, exact match
--      case-insensitive/trim -- konsisten dengan pencocokan di
--      update_coverage_area & backfill 20260816) -- BUKAN lagi terhadap JSON.
--   2. customers.coverage_area_id (kolom sudah ada sejak 20260816, sebelumnya
--      tidak pernah diisi oleh create_store_with_pic) kini diisi dari hasil
--      pencocokan tsb saat toko baru dibuat -- supaya toko baru langsung
--      tersambung ke master, bukan hanya menyimpan nama teks lama.
--   3. salesman_coverage_areas.area (mirror TEXT untuk consumer lama --
--      Telegram webhook, n8n directory, daily-session agenda) kini
--      DIJAMIN DATABASE selalu sama dengan coverage_areas.name lewat trigger,
--      bukan hanya konvensi "tidak pernah ditulis independen oleh kode baru"
--      seperti sebelumnya -- baris manapun dengan coverage_area_id terisi
--      tidak bisa lagi punya area yang menyimpang, walau lewat SQL langsung.
--
-- companies.settings.coverage_areas TIDAK dihapus -- add_company_coverage_area
-- (20260813, sudah tidak dipanggil kode aplikasi mana pun sejak 20260816)
-- tetap ada sebagai riwayat, service_role-only. Backfill/compatibility belum
-- terbukti aman untuk penghapusan kolom JSON itu sendiri di luar scope ini.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. create_store_with_pic — validasi area & isi coverage_area_id dari master.
--    Signature IDENTIK dengan versi 20260730000001 (hanya body berubah) --
--    CREATE OR REPLACE cukup, tidak perlu DROP FUNCTION.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_store_with_pic(
  p_company_id UUID,
  p_actor_id UUID,
  p_store_name TEXT,
  p_store_phone TEXT,
  p_store_address TEXT,
  p_store_area TEXT,
  p_store_latitude NUMERIC,
  p_store_longitude NUMERIC,
  p_assigned_sales_id UUID,
  p_pic_name TEXT,
  p_pic_phone TEXT,
  p_pic_roles TEXT[],
  p_idempotency_key TEXT,
  p_source TEXT,
  p_override_similar_duplicate BOOLEAN DEFAULT FALSE,
  p_override_reason TEXT DEFAULT NULL,
  p_pic_email TEXT DEFAULT NULL
)
RETURNS TABLE(
  result_outcome TEXT,
  customer_id UUID,
  customer_pic_id UUID,
  duplicate_customer_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor public.users%ROWTYPE;
  v_actor_role TEXT;
  v_area_id UUID;
  v_normalized_store_phone TEXT;
  v_normalized_pic_phone TEXT;
  v_normalized_pic_email TEXT;
  v_exact_id UUID;
  v_similar_id UUID;
  v_new_customer_id UUID;
  v_new_pic_id UUID;
  v_existing public.customers%ROWTYPE;
  v_existing_pic public.customer_pics%ROWTYPE;
BEGIN
  IF p_source NOT IN ('TELEGRAM_SALESMAN', 'ADMIN_DASHBOARD') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF p_store_name IS NULL OR TRIM(p_store_name) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF p_pic_name IS NULL OR TRIM(p_pic_name) = '' OR p_pic_phone IS NULL OR TRIM(p_pic_phone) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF p_pic_roles IS NULL OR array_length(p_pic_roles, 1) IS NULL
     OR NOT (p_pic_roles <@ ARRAY['OWNER','ORDERER','RECEIVER','PAYMENT_CONTACT','BACKUP_CONTACT']::TEXT[]) THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF p_override_similar_duplicate AND (p_override_reason IS NULL OR TRIM(p_override_reason) = '') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  -- Validasi format email HANYA jika diisi -- kosong/NULL selalu valid (opsional).
  IF p_pic_email IS NOT NULL AND TRIM(p_pic_email) <> ''
     AND lower(trim(p_pic_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT cp.* INTO v_existing_pic
    FROM public.customer_pics cp
    JOIN public.customer_pic_history h ON h.customer_pic_id = cp.id AND h.change_type = 'CREATED'
    WHERE cp.company_id = p_company_id
      AND h.reason = 'idempotency_key:' || p_idempotency_key;

    IF FOUND THEN
      RETURN QUERY SELECT 'already_exists'::TEXT, v_existing_pic.customer_id, v_existing_pic.id, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_actor FROM public.users WHERE id = p_actor_id AND company_id = p_company_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  SELECT r.name INTO v_actor_role
  FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_actor_id AND ur.company_id = p_company_id
  ORDER BY CASE r.name
    WHEN 'super_admin' THEN 1 WHEN 'owner' THEN 2 WHEN 'manager' THEN 3
    WHEN 'admin' THEN 4 WHEN 'sales' THEN 5 ELSE 6 END
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Sumber kebenaran wilayah: public.coverage_areas (master, tenant-scoped,
  -- aktif saja) -- BUKAN lagi companies.settings.coverage_areas (JSON legacy
  -- yang sejak 20260816 tidak lagi ditulis oleh create_coverage_area).
  IF p_store_area IS NOT NULL AND TRIM(p_store_area) <> '' THEN
    SELECT ca.id INTO v_area_id
    FROM public.coverage_areas ca
    WHERE ca.company_id = p_company_id
      AND ca.is_active = TRUE
      AND LOWER(TRIM(ca.name)) = LOWER(TRIM(p_store_area));

    IF v_area_id IS NULL THEN
      RETURN QUERY SELECT 'invalid_area'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  IF v_actor_role = 'sales' THEN
    -- Salesman hanya boleh membuat toko untuk dirinya sendiri, pada area
    -- yang DITUGASKAN kepadanya (bukan sembarang area tenant).
    IF p_assigned_sales_id IS DISTINCT FROM p_actor_id THEN
      RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
    IF v_area_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salesman_coverage_areas
      WHERE company_id = p_company_id AND user_id = p_actor_id AND coverage_area_id = v_area_id
    ) THEN
      RETURN QUERY SELECT 'area_not_assigned'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
  ELSIF v_actor_role NOT IN ('owner', 'manager', 'admin', 'super_admin') THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_assigned_sales_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.users u
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
      JOIN public.roles r ON r.id = ur.role_id
      WHERE u.id = p_assigned_sales_id AND u.company_id = p_company_id AND u.is_active = TRUE AND r.name = 'sales'
    ) THEN
      RETURN QUERY SELECT 'invalid_assigned_sales'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  v_normalized_store_phone := public.normalize_id_phone(p_store_phone);
  v_normalized_pic_phone := public.normalize_id_phone(p_pic_phone);
  v_normalized_pic_email := public.normalize_id_email(p_pic_email);

  SELECT id INTO v_exact_id
  FROM public.customers
  WHERE company_id = p_company_id AND is_active = TRUE
    AND lower(trim(name)) = lower(trim(p_store_name))
    AND (
      lower(trim(COALESCE(address, ''))) = lower(trim(COALESCE(p_store_address, '')))
      OR (v_normalized_store_phone IS NOT NULL AND public.normalize_id_phone(phone) = v_normalized_store_phone)
    )
  LIMIT 1;

  IF v_exact_id IS NOT NULL THEN
    RETURN QUERY SELECT 'exact_duplicate_store'::TEXT, NULL::UUID, NULL::UUID, v_exact_id;
    RETURN;
  END IF;

  SELECT id INTO v_similar_id
  FROM public.customers
  WHERE company_id = p_company_id AND is_active = TRUE
    AND (
      (v_normalized_store_phone IS NOT NULL AND public.normalize_id_phone(phone) = v_normalized_store_phone
        AND lower(trim(name)) <> lower(trim(p_store_name)))
      OR (area IS NOT DISTINCT FROM p_store_area AND length(trim(p_store_name)) >= 4
        AND (lower(name) LIKE '%' || lower(trim(p_store_name)) || '%'
             OR lower(trim(p_store_name)) LIKE '%' || lower(name) || '%'))
      OR (lower(trim(COALESCE(address, ''))) = lower(trim(COALESCE(p_store_address, '')))
          AND trim(COALESCE(p_store_address, '')) <> ''
          AND lower(trim(name)) <> lower(trim(p_store_name)))
    )
  LIMIT 1;

  IF v_similar_id IS NOT NULL AND NOT p_override_similar_duplicate THEN
    RETURN QUERY SELECT 'similar_duplicate_warning'::TEXT, NULL::UUID, NULL::UUID, v_similar_id;
    RETURN;
  END IF;

  INSERT INTO public.customers (
    company_id, code, name, phone, address, area, coverage_area_id, latitude, longitude,
    assigned_sales_id, is_active, created_by
  ) VALUES (
    p_company_id,
    'STORE-' || substring(replace(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 10),
    TRIM(p_store_name),
    v_normalized_store_phone,
    NULLIF(TRIM(COALESCE(p_store_address, '')), ''),
    NULLIF(p_store_area, ''),
    v_area_id,
    p_store_latitude,
    p_store_longitude,
    p_assigned_sales_id,
    TRUE,
    p_actor_id
  )
  RETURNING id INTO v_new_customer_id;

  INSERT INTO public.customer_pics (
    company_id, customer_id, name, phone, email, roles, validation_status, created_by
  ) VALUES (
    p_company_id, v_new_customer_id, TRIM(p_pic_name), v_normalized_pic_phone, v_normalized_pic_email,
    p_pic_roles, 'UNVERIFIED', p_actor_id
  )
  RETURNING id INTO v_new_pic_id;

  INSERT INTO public.customer_pic_history (
    company_id, customer_pic_id, customer_id, change_type, new_value, reason, source, actor_id
  ) VALUES (
    p_company_id, v_new_pic_id, v_new_customer_id, 'CREATED', TRIM(p_pic_name),
    CASE WHEN p_idempotency_key IS NOT NULL THEN 'idempotency_key:' || p_idempotency_key ELSE NULL END,
    p_source, p_actor_id
  );

  INSERT INTO public.customer_relationship_events (
    company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id
  ) VALUES (
    p_company_id, v_new_customer_id, v_new_pic_id, 'PIC_ADDED', 'info',
    jsonb_build_object('pic_name', TRIM(p_pic_name), 'roles', p_pic_roles, 'source', p_source, 'has_email', v_normalized_pic_email IS NOT NULL),
    p_actor_id
  );

  IF v_similar_id IS NOT NULL AND p_override_similar_duplicate THEN
    INSERT INTO public.customer_relationship_events (
      company_id, customer_id, event_type, severity, payload, actor_id
    ) VALUES (
      p_company_id, v_new_customer_id, 'DUPLICATE_STORE_DETECTED', 'medium',
      jsonb_build_object('similar_customer_id', v_similar_id, 'override_reason', p_override_reason),
      p_actor_id
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_pics cp3
    WHERE cp3.company_id = p_company_id AND cp3.phone = v_normalized_pic_phone AND cp3.customer_id <> v_new_customer_id
  ) THEN
    INSERT INTO public.customer_relationship_events (
      company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id
    ) VALUES (
      p_company_id, v_new_customer_id, v_new_pic_id, 'DUPLICATE_PIC_DETECTED', 'low',
      jsonb_build_object('phone', v_normalized_pic_phone), p_actor_id
    );
  END IF;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    p_company_id, p_actor_id, 'customer.store_created', 'customers', v_new_customer_id,
    jsonb_build_object('name', TRIM(p_store_name), 'area', p_store_area, 'coverage_area_id', v_area_id, 'source', p_source)
  );
  -- Audit TIDAK menyimpan nilai email mentah -- cukup penanda ada/tidaknya
  -- (nilai sebenarnya hanya di customer_pic_history/relationship_events,
  -- yang sudah dibatasi akses RLS yang sama).
  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    p_company_id, p_actor_id, 'customer_pic.created', 'customer_pics', v_new_pic_id,
    jsonb_build_object('customer_id', v_new_customer_id, 'roles', p_pic_roles, 'source', p_source, 'has_email', v_normalized_pic_email IS NOT NULL)
  );

  RETURN QUERY SELECT 'created'::TEXT, v_new_customer_id, v_new_pic_id, NULL::UUID;
END;
$$;

REVOKE ALL ON FUNCTION public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT, TEXT
) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Mirror lock — salesman_coverage_areas.area tidak boleh lagi menyimpang
--    dari coverage_areas.name walau lewat SQL langsung (sebelumnya hanya
--    dijamin oleh konvensi assign_salesman_coverage_areas/update_coverage_area,
--    bukan oleh database). BEFORE trigger menimpa NEW.area dari master setiap
--    kali coverage_area_id terisi -- baris tanpa coverage_area_id (data lama
--    yang belum ter-backfill) tidak disentuh, dibiarkan apa adanya.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_salesman_coverage_area_mirror()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.coverage_area_id IS NOT NULL THEN
    SELECT name INTO NEW.area FROM public.coverage_areas WHERE id = NEW.coverage_area_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'coverage_area_id % tidak ditemukan di coverage_areas', NEW.coverage_area_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;

DROP TRIGGER IF EXISTS trg_sca_mirror_area ON public.salesman_coverage_areas;
CREATE TRIGGER trg_sca_mirror_area
  BEFORE INSERT OR UPDATE ON public.salesman_coverage_areas
  FOR EACH ROW EXECUTE FUNCTION public.sync_salesman_coverage_area_mirror();
