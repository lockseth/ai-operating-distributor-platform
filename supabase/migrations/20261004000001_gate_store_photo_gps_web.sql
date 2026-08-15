-- =============================================================================
-- Gate: Store Photo Capture + Admin Dashboard duplicate-guard parity
--
-- Kontrak (keputusan Pak Waluyo, percakapan 2026-08-15):
--   1. Foto depan toko dan foto PIC toko -- OPSIONAL, tidak ada pun tetap
--      bisa disimpan (ada toko yang mau transaksi CASH cepat, tidak mau
--      diribetkan input lengkap).
--   2. PIC nama+telepon TETAP WAJIB seperti sekarang -- TIDAK diubah.
--   3. Jalur Telegram (TELEGRAM_SALESMAN) di-hold, TIDAK disentuh sama
--      sekali -- perubahan ini murni ADDITIVE (parameter baru DEFAULT NULL
--      di akhir daftar, kolom baru nullable), pola identik migration
--      20260730000001 (penambahan p_pic_email). Caller lama (Telegram) yang
--      tidak mengirim parameter baru tetap bekerja tanpa perubahan apa pun.
--   4. GPS toko sudah didukung RPC sejak awal (p_store_latitude/longitude,
--      opsional) -- gate ini TIDAK mengubah itu, hanya menyambungkan jalur
--      Web (lihat actions.ts) yang sebelumnya tidak mengirim GPS sama
--      sekali karena tidak lewat RPC ini.
--
-- Scope gate ini: (a) kolom foto opsional di customers/customer_pics,
-- (b) parameter foto opsional baru di create_store_with_pic(), (c) storage
-- bucket 'store-photos' + RLS tenant-scoped. TIDAK mengubah validasi PIC,
-- TIDAK mengubah deteksi duplikat, TIDAK mengubah apa pun untuk source
-- TELEGRAM_SALESMAN.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Kolom foto opsional -- nullable murni, tidak ada default/constraint
--    yang memaksa pengisian.
-- ---------------------------------------------------------------------------

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS storefront_photo_url TEXT;

COMMENT ON COLUMN public.customers.storefront_photo_url IS
  'Opsional. Path storage foto depan toko (bucket store-photos). Ketiadaan foto tidak pernah menolak pendaftaran toko (keputusan Pak Waluyo, konsisten dengan latitude/longitude).';

ALTER TABLE public.customer_pics
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

COMMENT ON COLUMN public.customer_pics.photo_url IS
  'Opsional. Path storage foto PIC toko (bucket store-photos). Ketiadaan foto tidak pernah menolak pendaftaran PIC (keputusan Pak Waluyo).';

-- ---------------------------------------------------------------------------
-- 2. create_store_with_pic() -- CREATE OR REPLACE, HANYA menambah 2
--    parameter opsional baru di AKHIR daftar (p_store_photo_url,
--    p_pic_photo_url, keduanya DEFAULT NULL) + menyisipkan kolomnya ke 2
--    INSERT yang sudah ada. TIDAK ADA baris validasi/logic lain yang
--    diubah -- body ini adalah salinan PERSIS dari versi
--    20260730000001_customer_pic_email.sql, hanya 4 titik yang disentuh
--    (ditandai "-- BARU" di bawah).
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
  p_pic_email TEXT DEFAULT NULL,
  p_store_photo_url TEXT DEFAULT NULL, -- BARU
  p_pic_photo_url TEXT DEFAULT NULL    -- BARU
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
  v_available_areas JSONB;
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

  SELECT c.settings -> 'coverage_areas' INTO v_available_areas
  FROM public.companies c WHERE c.id = p_company_id;

  IF p_store_area IS NOT NULL AND TRIM(p_store_area) <> '' THEN
    IF v_available_areas IS NULL OR jsonb_typeof(v_available_areas) <> 'array'
       OR NOT (v_available_areas ? p_store_area) THEN
      RETURN QUERY SELECT 'invalid_area'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  IF v_actor_role = 'sales' THEN
    IF p_assigned_sales_id IS DISTINCT FROM p_actor_id THEN
      RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
    IF p_store_area IS NOT NULL AND TRIM(p_store_area) <> '' AND NOT EXISTS (
      SELECT 1 FROM public.salesman_coverage_areas
      WHERE company_id = p_company_id AND user_id = p_actor_id AND area = p_store_area
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
    company_id, code, name, phone, address, area, latitude, longitude,
    assigned_sales_id, is_active, created_by, storefront_photo_url -- BARU
  ) VALUES (
    p_company_id,
    'STORE-' || substring(replace(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 10),
    TRIM(p_store_name),
    v_normalized_store_phone,
    NULLIF(TRIM(COALESCE(p_store_address, '')), ''),
    NULLIF(p_store_area, ''),
    p_store_latitude,
    p_store_longitude,
    p_assigned_sales_id,
    TRUE,
    p_actor_id,
    NULLIF(TRIM(COALESCE(p_store_photo_url, '')), '') -- BARU
  )
  RETURNING id INTO v_new_customer_id;

  INSERT INTO public.customer_pics (
    company_id, customer_id, name, phone, email, roles, validation_status, created_by, photo_url -- BARU
  ) VALUES (
    p_company_id, v_new_customer_id, TRIM(p_pic_name), v_normalized_pic_phone, v_normalized_pic_email,
    p_pic_roles, 'UNVERIFIED', p_actor_id, NULLIF(TRIM(COALESCE(p_pic_photo_url, '')), '') -- BARU
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
    jsonb_build_object('name', TRIM(p_store_name), 'area', p_store_area, 'source', p_source, 'has_photo', p_store_photo_url IS NOT NULL)
  );
  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    p_company_id, p_actor_id, 'customer_pic.created', 'customer_pics', v_new_pic_id,
    jsonb_build_object('customer_id', v_new_customer_id, 'roles', p_pic_roles, 'source', p_source, 'has_email', v_normalized_pic_email IS NOT NULL, 'has_photo', p_pic_photo_url IS NOT NULL)
  );

  RETURN QUERY SELECT 'created'::TEXT, v_new_customer_id, v_new_pic_id, NULL::UUID;
END;
$$;

-- Signature lama (17 parameter, tanpa foto) di-DROP eksplisit -- menambah
-- parameter mengubah signature, CREATE OR REPLACE saja akan membuat
-- overload baru yang ambigu (pola sama seperti migration email).
DROP FUNCTION IF EXISTS public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT, TEXT
);

REVOKE ALL ON FUNCTION public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT, TEXT, TEXT, TEXT
) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Storage bucket untuk foto toko/PIC -- private, tenant-scoped lewat RLS.
--    Path convention: {company_id}/{actor_id}/{timestamp}-{random}-{filename}
--    (diupload SEBELUM store dibuat -- store belum py id saat foto diambil).
-- ---------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('store-photos', 'store-photos', FALSE, 8388608, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "store_photos_insert_own_company" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'store-photos'
    AND (storage.foldername(name))[1] = public.get_user_company_id()::TEXT
  );

CREATE POLICY "store_photos_select_own_company" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'store-photos'
    AND (storage.foldername(name))[1] = public.get_user_company_id()::TEXT
  );

-- Tidak ada UPDATE/DELETE policy -- foto bersifat evidence, immutable
-- setelah diupload, konsisten dengan pola delivery evidence existing.
