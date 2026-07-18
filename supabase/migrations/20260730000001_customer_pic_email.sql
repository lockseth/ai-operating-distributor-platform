-- =============================================================================
-- Multi-PIC Telegram & Optional PIC Email
--
-- Additive: customer_pics.email (nullable), normalize_id_email(), dan RPC
-- create_store_with_pic/create_customer_pic/update_customer_pic diperluas
-- dengan parameter email OPSIONAL (DEFAULT NULL, ditambahkan di AKHIR daftar
-- parameter) -- caller lama yang tidak mengirim email (memanggil via
-- named-parameter seperti supabase-js) tetap bekerja tanpa perubahan.
--
-- Email policy (dikunci untuk gate ini):
--   * nullable, trim+lowercase normalization, validasi format HANYA jika diisi;
--   * TIDAK ADA OTP/email verification;
--   * TIDAK PERNAH jadi bukti PIC verified (validation_status tidak
--     dipengaruhi oleh ada/tidaknya email);
--   * TIDAK HARUS unique -- email sama di beberapa PIC murni informational;
--   * perubahan email -> customer_pic_history + customer_relationship_events;
--   * audit_logs TIDAK mencatat nilai email mentah (payload minimal, lihat
--     komentar di masing-masing INSERT audit_logs).
--
-- Karena menambah PARAMETER (bukan sekadar mengganti isi fungsi), signature
-- berubah -- CREATE OR REPLACE tidak cukup (akan membuat overload baru yang
-- ambigu). Fungsi lama di-DROP eksplisit dulu, baru dibuat versi baru --
-- tetap SATU migration baru (bukan mengedit file migration yang sudah
-- diterapkan).
-- =============================================================================

ALTER TABLE public.customer_pics
  ADD COLUMN IF NOT EXISTS email VARCHAR(255);

COMMENT ON COLUMN public.customer_pics.email IS
  'Opsional. Tidak pernah jadi bukti verifikasi, tidak wajib unique, tidak ada OTP/email verification (keputusan Pak Waluyo, gate Multi-PIC & Optional Email).';

-- ---------------------------------------------------------------------------
-- Perluas CHECK change_type/event_type/awaiting untuk mendukung perubahan
-- email dan alur "Tambah PIC" Telegram (additive, tidak menghapus nilai lama).
-- ---------------------------------------------------------------------------
ALTER TABLE public.customer_pic_history
  DROP CONSTRAINT IF EXISTS customer_pic_history_change_type_check;
ALTER TABLE public.customer_pic_history
  ADD CONSTRAINT customer_pic_history_change_type_check
  CHECK (change_type IN ('CREATED', 'NAME_CHANGED', 'PHONE_CHANGED', 'ROLES_CHANGED', 'STATUS_CHANGED', 'EMAIL_CHANGED'));

ALTER TABLE public.customer_relationship_events
  DROP CONSTRAINT IF EXISTS customer_relationship_events_event_type_check;
ALTER TABLE public.customer_relationship_events
  ADD CONSTRAINT customer_relationship_events_event_type_check
  CHECK (event_type IN (
    'PIC_ADDED', 'PIC_NAME_CHANGED', 'PIC_PHONE_CHANGED', 'PIC_ROLES_CHANGED', 'PIC_EMAIL_CHANGED',
    'PIC_VERIFIED', 'PIC_REVERIFY_REQUIRED', 'PIC_DEACTIVATED',
    'DUPLICATE_STORE_DETECTED', 'DUPLICATE_PIC_DETECTED'
  ));

ALTER TABLE public.store_pic_conversation_state
  DROP CONSTRAINT IF EXISTS store_pic_conversation_state_awaiting_check;
ALTER TABLE public.store_pic_conversation_state
  ADD CONSTRAINT store_pic_conversation_state_awaiting_check
  CHECK (awaiting IN (
    'none', 'store_name', 'store_address', 'store_area', 'store_phone',
    'pic_name', 'pic_phone', 'pic_email', 'pic_roles', 'final_confirmation',
    'similar_duplicate_confirmation',
    'add_pic_store_search', 'add_pic_store_select', 'add_pic_name',
    'add_pic_phone', 'add_pic_email', 'add_pic_roles', 'add_pic_confirm'
  ));

-- ---------------------------------------------------------------------------
-- Normalisasi email — pure function, dicerminkan persis di TypeScript
-- (lib/customer-pic/email.ts). Trim + lowercase; kosong/null -> NULL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_id_email(p_email TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_email IS NULL OR TRIM(p_email) = '' THEN
    RETURN NULL;
  END IF;
  RETURN lower(trim(p_email));
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_id_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_id_email(TEXT) TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- RPC 1 (v2): create_store_with_pic — + p_pic_email TEXT DEFAULT NULL.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT
);

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
    assigned_sales_id, is_active, created_by
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
    jsonb_build_object('name', TRIM(p_store_name), 'area', p_store_area, 'source', p_source)
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
-- RPC 2 (v2): create_customer_pic — + p_email TEXT DEFAULT NULL, + guard
-- "nomor sama pada toko yang sama" -> mengembalikan record existing (bukan
-- duplicate baru diam-diam).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.create_customer_pic(
  p_company_id UUID,
  p_customer_id UUID,
  p_actor_id UUID,
  p_name TEXT,
  p_phone TEXT,
  p_roles TEXT[],
  p_idempotency_key TEXT,
  p_source TEXT,
  p_email TEXT DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT, customer_pic_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_customer public.customers%ROWTYPE;
  v_actor_role TEXT;
  v_normalized_phone TEXT;
  v_normalized_email TEXT;
  v_new_pic_id UUID;
  v_existing public.customer_pics%ROWTYPE;
  v_existing_phone_pic_id UUID;
BEGIN
  IF p_source NOT IN ('TELEGRAM_SALESMAN', 'ADMIN_DASHBOARD') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF p_name IS NULL OR TRIM(p_name) = '' OR p_phone IS NULL OR TRIM(p_phone) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF p_roles IS NULL OR array_length(p_roles, 1) IS NULL
     OR NOT (p_roles <@ ARRAY['OWNER','ORDERER','RECEIVER','PAYMENT_CONTACT','BACKUP_CONTACT']::TEXT[]) THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF p_email IS NOT NULL AND TRIM(p_email) <> ''
     AND lower(trim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT cp.* INTO v_existing
    FROM public.customer_pics cp
    JOIN public.customer_pic_history h ON h.customer_pic_id = cp.id AND h.change_type = 'CREATED'
    WHERE cp.company_id = p_company_id AND h.reason = 'idempotency_key:' || p_idempotency_key;
    IF FOUND THEN
      RETURN QUERY SELECT 'already_exists'::TEXT, v_existing.id;
      RETURN;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_actor_id AND company_id = p_company_id AND is_active = TRUE) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE id = p_customer_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'customer_not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT r.name INTO v_actor_role
  FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_actor_id AND ur.company_id = p_company_id
  ORDER BY CASE r.name
    WHEN 'super_admin' THEN 1 WHEN 'owner' THEN 2 WHEN 'manager' THEN 3
    WHEN 'admin' THEN 4 WHEN 'sales' THEN 5 ELSE 6 END
  LIMIT 1;

  IF v_actor_role = 'sales' AND v_customer.assigned_sales_id IS DISTINCT FROM p_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  ELSIF v_actor_role IS NULL OR (v_actor_role <> 'sales' AND v_actor_role NOT IN ('owner','manager','admin','super_admin')) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  v_normalized_phone := public.normalize_id_phone(p_phone);
  v_normalized_email := public.normalize_id_email(p_email);

  -- Nomor PIC yang sama pada TOKO YANG SAMA -> kembalikan record existing,
  -- BUKAN membuat duplicate baru secara diam-diam (LANGKAH requirement).
  SELECT id INTO v_existing_phone_pic_id
  FROM public.customer_pics
  WHERE customer_id = p_customer_id AND phone = v_normalized_phone
  LIMIT 1;

  IF v_existing_phone_pic_id IS NOT NULL THEN
    RETURN QUERY SELECT 'phone_exists_on_store'::TEXT, v_existing_phone_pic_id;
    RETURN;
  END IF;

  INSERT INTO public.customer_pics (company_id, customer_id, name, phone, email, roles, validation_status, created_by)
  VALUES (p_company_id, p_customer_id, TRIM(p_name), v_normalized_phone, v_normalized_email, p_roles, 'UNVERIFIED', p_actor_id)
  RETURNING id INTO v_new_pic_id;

  INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, new_value, reason, source, actor_id)
  VALUES (
    p_company_id, v_new_pic_id, p_customer_id, 'CREATED', TRIM(p_name),
    CASE WHEN p_idempotency_key IS NOT NULL THEN 'idempotency_key:' || p_idempotency_key ELSE NULL END,
    p_source, p_actor_id
  );

  INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
  VALUES (p_company_id, p_customer_id, v_new_pic_id, 'PIC_ADDED', 'info',
    jsonb_build_object('pic_name', TRIM(p_name), 'roles', p_roles, 'source', p_source, 'has_email', v_normalized_email IS NOT NULL), p_actor_id);

  IF EXISTS (
    SELECT 1 FROM public.customer_pics
    WHERE company_id = p_company_id AND phone = v_normalized_phone AND customer_id <> p_customer_id
  ) THEN
    INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
    VALUES (p_company_id, p_customer_id, v_new_pic_id, 'DUPLICATE_PIC_DETECTED', 'low',
      jsonb_build_object('phone', v_normalized_phone), p_actor_id);
  END IF;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, p_actor_id, 'customer_pic.created', 'customer_pics', v_new_pic_id,
    jsonb_build_object('customer_id', p_customer_id, 'roles', p_roles, 'source', p_source, 'has_email', v_normalized_email IS NOT NULL));

  RETURN QUERY SELECT 'created'::TEXT, v_new_pic_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 3 (v2): update_customer_pic — + p_new_email TEXT DEFAULT NULL.
-- Semantik sama seperti p_new_name/p_new_phone/p_new_roles: NULL = tidak
-- diubah. Email TIDAK mempengaruhi validation_status (beda dengan nomor
-- telepon) -- email tidak pernah jadi bukti verifikasi.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.update_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.update_customer_pic(
  p_company_id UUID,
  p_customer_pic_id UUID,
  p_actor_id UUID,
  p_new_name TEXT,
  p_new_phone TEXT,
  p_new_roles TEXT[],
  p_reason TEXT,
  p_source TEXT,
  p_new_email TEXT DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pic public.customer_pics%ROWTYPE;
  v_normalized_phone TEXT;
  v_normalized_email TEXT;
  v_email_changed BOOLEAN := FALSE;
  v_new_status TEXT;
  v_changed BOOLEAN := FALSE;
BEGIN
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;
  IF p_source NOT IN ('TELEGRAM_SALESMAN', 'ADMIN_DASHBOARD', 'ORDER_VERIFICATION', 'DELIVERY_VERIFICATION') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;
  IF p_new_roles IS NOT NULL AND (array_length(p_new_roles, 1) IS NULL
     OR NOT (p_new_roles <@ ARRAY['OWNER','ORDERER','RECEIVER','PAYMENT_CONTACT','BACKUP_CONTACT']::TEXT[])) THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;
  IF p_new_email IS NOT NULL AND TRIM(p_new_email) <> ''
     AND lower(trim(p_new_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id AND u.company_id = p_company_id AND u.is_active = TRUE
      AND r.name IN ('owner','manager','admin','super_admin')
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_pic FROM public.customer_pics WHERE id = p_customer_pic_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  v_new_status := v_pic.validation_status;

  IF p_new_name IS NOT NULL AND TRIM(p_new_name) <> '' AND TRIM(p_new_name) IS DISTINCT FROM v_pic.name THEN
    INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, field_name, old_value, new_value, reason, source, actor_id)
    VALUES (p_company_id, p_customer_pic_id, v_pic.customer_id, 'NAME_CHANGED', 'name', v_pic.name, TRIM(p_new_name), p_reason, p_source, p_actor_id);
    INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
    VALUES (p_company_id, v_pic.customer_id, p_customer_pic_id, 'PIC_NAME_CHANGED', 'info',
      jsonb_build_object('old', v_pic.name, 'new', TRIM(p_new_name), 'reason', p_reason), p_actor_id);
    v_changed := TRUE;
  END IF;

  IF p_new_phone IS NOT NULL AND TRIM(p_new_phone) <> '' THEN
    v_normalized_phone := public.normalize_id_phone(p_new_phone);
    IF v_normalized_phone IS DISTINCT FROM v_pic.phone THEN
      INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, field_name, old_value, new_value, reason, source, actor_id)
      VALUES (p_company_id, p_customer_pic_id, v_pic.customer_id, 'PHONE_CHANGED', 'phone', v_pic.phone, v_normalized_phone, p_reason, p_source, p_actor_id);
      INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
      VALUES (p_company_id, v_pic.customer_id, p_customer_pic_id, 'PIC_PHONE_CHANGED', 'medium',
        jsonb_build_object('old', v_pic.phone, 'new', v_normalized_phone, 'reason', p_reason), p_actor_id);
      IF v_pic.validation_status NOT IN ('UNVERIFIED', 'INACTIVE') THEN
        v_new_status := 'REVERIFY_REQUIRED';
      END IF;
      v_changed := TRUE;
    END IF;
  END IF;

  IF p_new_roles IS NOT NULL AND p_new_roles IS DISTINCT FROM v_pic.roles THEN
    INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, field_name, old_value, new_value, reason, source, actor_id)
    VALUES (p_company_id, p_customer_pic_id, v_pic.customer_id, 'ROLES_CHANGED', 'roles', array_to_string(v_pic.roles, ','), array_to_string(p_new_roles, ','), p_reason, p_source, p_actor_id);
    INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
    VALUES (p_company_id, v_pic.customer_id, p_customer_pic_id, 'PIC_ROLES_CHANGED', 'info',
      jsonb_build_object('old', v_pic.roles, 'new', p_new_roles, 'reason', p_reason), p_actor_id);
    v_changed := TRUE;
  END IF;

  -- Email TIDAK PERNAH mempengaruhi v_new_status -- bukan bukti verifikasi.
  IF p_new_email IS NOT NULL THEN
    v_normalized_email := public.normalize_id_email(p_new_email);
    IF v_normalized_email IS DISTINCT FROM v_pic.email THEN
      INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, field_name, old_value, new_value, reason, source, actor_id)
      VALUES (p_company_id, p_customer_pic_id, v_pic.customer_id, 'EMAIL_CHANGED', 'email', v_pic.email, v_normalized_email, p_reason, p_source, p_actor_id);
      INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
      VALUES (p_company_id, v_pic.customer_id, p_customer_pic_id, 'PIC_EMAIL_CHANGED', 'info',
        jsonb_build_object('reason', p_reason), p_actor_id);
      v_changed := TRUE;
      v_email_changed := TRUE;
    END IF;
  END IF;

  IF NOT v_changed THEN
    RETURN QUERY SELECT 'no_changes'::TEXT;
    RETURN;
  END IF;

  UPDATE public.customer_pics SET
    name = COALESCE(NULLIF(TRIM(p_new_name), ''), name),
    phone = COALESCE(v_normalized_phone, phone),
    roles = COALESCE(p_new_roles, roles),
    email = CASE WHEN v_email_changed THEN v_normalized_email ELSE email END,
    validation_status = v_new_status
  WHERE id = p_customer_pic_id;

  -- Audit TIDAK mencatat nilai email mentah, hanya penanda perubahan terjadi.
  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (p_company_id, p_actor_id, 'customer_pic.updated', 'customer_pics', p_customer_pic_id,
    jsonb_build_object('name', v_pic.name, 'phone', v_pic.phone, 'roles', v_pic.roles, 'validation_status', v_pic.validation_status),
    jsonb_build_object('name', COALESCE(NULLIF(TRIM(p_new_name), ''), v_pic.name), 'phone', COALESCE(v_normalized_phone, v_pic.phone), 'roles', COALESCE(p_new_roles, v_pic.roles), 'validation_status', v_new_status, 'email_changed', p_new_email IS NOT NULL, 'reason', p_reason));

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.update_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, TEXT)
  TO service_role;
