-- =============================================================================
-- Tambah Toko & PIC — Non-Biometric Master Data Gate
--
-- Toko (store) TIDAK mendapat tabel baru -- public.customers SUDAH cukup
-- (name, phone, address, area, assigned_sales_id, is_active). Gate ini hanya
-- menambah kolom GPS opsional pada customers, plus tabel PIC master baru
-- (belum pernah ada -- lihat komentar forward-compat di
-- order_cancellation_disputes.reported_pic_id, migration 20260725000001).
--
-- Non-biometric (keputusan Pak Waluyo): TIDAK ADA KTP/selfie/face
-- recognition/liveness di mana pun pada gate ini. Validasi PIC memakai data
-- hubungan (siapa mendaftarkan, siapa memverifikasi) dan riwayat transaksi
-- (VERIFIED_BY_ORDER/VERIFIED_ON_DELIVERY -- keduanya HANYA diklaim oleh
-- integrasi masa depan, TIDAK diimplementasikan di gate ini).
--
-- validation_status adalah SATU-SATUNYA sumber kebenaran untuk "aktif/tidak
-- aktif" PIC -- 'INACTIVE' adalah salah satu nilainya sendiri (bukan kolom
-- is_active terpisah). Ini sengaja menghindari dua sumber kebenaran yang
-- bisa saling menimpa, pola arsitektur yang sama dengan keputusan
-- sales_orders.status vs order_cancellation_disputes (migration
-- 20260725000001).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Store: kolom GPS opsional pada customers (additive, nullable -- ketiadaan
-- GPS TIDAK PERNAH menolak pendaftaran toko).
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS latitude  NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

COMMENT ON COLUMN public.customers.latitude IS 'Opsional. Ketiadaan GPS tidak pernah menolak pendaftaran toko (keputusan Pak Waluyo).';
COMMENT ON COLUMN public.customers.longitude IS 'Opsional. Ketiadaan GPS tidak pernah menolak pendaftaran toko (keputusan Pak Waluyo).';

-- ---------------------------------------------------------------------------
-- Normalisasi nomor telepon Indonesia -- pure function, dicerminkan persis
-- di TypeScript (lib/customer-pic/phone.ts) untuk parity InMemory/RPC.
-- Aturan: buang semua karakter non-digit/plus, deteksi prefix 0/62/+62,
-- normalisasi ke +62<sisanya>. Selain itu dikembalikan apa adanya (trimmed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_id_phone(p_phone TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_digits TEXT;
BEGIN
  IF p_phone IS NULL OR TRIM(p_phone) = '' THEN
    RETURN NULL;
  END IF;

  v_digits := regexp_replace(TRIM(p_phone), '[^0-9]', '', 'g');

  IF v_digits = '' THEN
    RETURN NULL;
  ELSIF v_digits LIKE '62%' THEN
    RETURN '+62' || substring(v_digits FROM 3);
  ELSIF v_digits LIKE '0%' THEN
    RETURN '+62' || substring(v_digits FROM 2);
  ELSE
    RETURN '+62' || v_digits;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- customer_pics — PIC master. Satu toko dapat memiliki beberapa PIC (relasi
-- one-to-many customer_id -> customer_pics, bukan array di customers --
-- konsisten dengan pola salesman_coverage_areas: relasi, bukan kolom array
-- di parent, supaya masing-masing PIC punya siklus hidup/validation_status
-- sendiri).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_pics (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id        UUID         NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,

  name               VARCHAR(255) NOT NULL,
  phone              VARCHAR(30)  NOT NULL, -- selalu tersimpan dalam bentuk normalize_id_phone()

  roles              TEXT[]       NOT NULL,
  validation_status  VARCHAR(30)  NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (validation_status IN (
      'UNVERIFIED', 'VERIFIED_BY_ADMIN', 'VERIFIED_BY_ORDER',
      'VERIFIED_ON_DELIVERY', 'REVERIFY_REQUIRED', 'INACTIVE'
    )),

  created_by         UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  verified_by        UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  verified_at        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_cp_roles_valid CHECK (
    array_length(roles, 1) > 0
    AND roles <@ ARRAY['OWNER','ORDERER','RECEIVER','PAYMENT_CONTACT','BACKUP_CONTACT']::TEXT[]
  ),
  CONSTRAINT chk_cp_verified_pair CHECK (
    (verified_by IS NULL AND verified_at IS NULL) OR
    (verified_by IS NOT NULL AND verified_at IS NOT NULL)
  )
);

CREATE INDEX idx_cp_company_customer ON public.customer_pics (company_id, customer_id);
CREATE INDEX idx_cp_phone            ON public.customer_pics (company_id, phone);
CREATE INDEX idx_cp_status           ON public.customer_pics (company_id, validation_status);

COMMENT ON TABLE public.customer_pics IS
  'PIC (contact person) toko. validation_status adalah satu-satunya sumber kebenaran aktif/tidak aktif -- lihat INACTIVE. Non-biometric: tidak ada kolom KTP/foto/face-embedding.';
COMMENT ON COLUMN public.customer_pics.validation_status IS
  'VERIFIED_BY_ORDER/VERIFIED_ON_DELIVERY HANYA boleh di-set oleh integrasi order/delivery masa depan setelah transaksi nyata terjadi -- RPC verify_customer_pic() di gate ini SENGAJA menolak kedua nilai tsb.';

ALTER TABLE public.customer_pics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cp_select" ON public.customer_pics
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

REVOKE ALL ON TABLE public.customer_pics FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.customer_pics TO authenticated;

CREATE TRIGGER trg_customer_pics_updated_at
  BEFORE UPDATE ON public.customer_pics
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- customer_pic_history — append-only, TIDAK PERNAH di-UPDATE/DELETE (bahkan
-- oleh service_role) -- ini adalah log fakta historis itu sendiri, bukan
-- baris hidup seperti customer_pics. Trigger menolak SEMUA UPDATE/DELETE.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_pic_history (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_pic_id  UUID         NOT NULL REFERENCES public.customer_pics (id) ON DELETE CASCADE,
  customer_id      UUID         NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,

  change_type      VARCHAR(30)  NOT NULL
    CHECK (change_type IN ('CREATED', 'NAME_CHANGED', 'PHONE_CHANGED', 'ROLES_CHANGED', 'STATUS_CHANGED')),
  field_name       VARCHAR(50),
  old_value        TEXT,
  new_value        TEXT,
  reason           TEXT,
  source           VARCHAR(30)  NOT NULL
    CHECK (source IN ('TELEGRAM_SALESMAN', 'ADMIN_DASHBOARD', 'ORDER_VERIFICATION', 'DELIVERY_VERIFICATION')),

  actor_id         UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cph_customer_pic ON public.customer_pic_history (customer_pic_id, created_at DESC);
CREATE INDEX idx_cph_customer     ON public.customer_pic_history (company_id, customer_id, created_at DESC);

COMMENT ON TABLE public.customer_pic_history IS
  'Riwayat perubahan PIC, append-only murni (tidak ada baris yang pernah di-UPDATE/DELETE, lihat trg_cph_immutable). PIC lama tidak pernah ditimpa tanpa jejak.';

ALTER TABLE public.customer_pic_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cph_select" ON public.customer_pic_history
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

REVOKE ALL ON TABLE public.customer_pic_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.customer_pic_history TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_cph_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'customer_pic_history: baris riwayat immutable, tidak boleh diubah/dihapus (id=%)',
    COALESCE(OLD.id, NEW.id);
END;
$$;

CREATE TRIGGER trg_cph_no_update
  BEFORE UPDATE ON public.customer_pic_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cph_immutable();

CREATE TRIGGER trg_cph_no_delete
  BEFORE DELETE ON public.customer_pic_history
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cph_immutable();

-- ---------------------------------------------------------------------------
-- customer_relationship_events — ledger generik "Customer DNA" (dikonsepkan
-- di Knowledge Pack Waluyo sebagai DV-05/CH-02). Gate ini hanya mengisi
-- event terkait PIC/toko; gate masa depan (Order Validation, Delivery
-- Verification lanjutan) dapat menambah event_type baru tanpa migration
-- ulang tabel ini.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_relationship_events (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  customer_id      UUID         NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  customer_pic_id  UUID         REFERENCES public.customer_pics (id) ON DELETE SET NULL,

  event_type       VARCHAR(40)  NOT NULL
    CHECK (event_type IN (
      'PIC_ADDED', 'PIC_NAME_CHANGED', 'PIC_PHONE_CHANGED', 'PIC_ROLES_CHANGED',
      'PIC_VERIFIED', 'PIC_REVERIFY_REQUIRED', 'PIC_DEACTIVATED',
      'DUPLICATE_STORE_DETECTED', 'DUPLICATE_PIC_DETECTED'
    )),
  severity         VARCHAR(20)  NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'low', 'medium', 'high')),
  payload          JSONB        NOT NULL DEFAULT '{}',

  actor_id         UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cre_customer ON public.customer_relationship_events (company_id, customer_id, created_at DESC);
CREATE INDEX idx_cre_type     ON public.customer_relationship_events (company_id, event_type);

COMMENT ON TABLE public.customer_relationship_events IS
  'Customer DNA / relationship-health signal ledger (DV-05, CH-02 di Knowledge Pack Waluyo). Perubahan PIC TIDAK PERNAH otomatis memblokir transaksi -- murni sinyal untuk Order Validation di gate masa depan.';

ALTER TABLE public.customer_relationship_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cre_select" ON public.customer_relationship_events
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

REVOKE ALL ON TABLE public.customer_relationship_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.customer_relationship_events TO authenticated;

-- ---------------------------------------------------------------------------
-- Forward-compat: identifier stabil customer_pic_id pada modul lain, untuk
-- gate berikutnya (Order Validation Integration) -- TIDAK dipopulasi atau
-- dipakai oleh workflow apa pun di gate ini, murni kesiapan skema (additive,
-- nullable, tidak mengubah perilaku existing).
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_cancellation_disputes
  ADD CONSTRAINT fk_ocd_reported_pic_id
  FOREIGN KEY (reported_pic_id) REFERENCES public.customer_pics (id) ON DELETE SET NULL;

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS customer_pic_id UUID REFERENCES public.customer_pics (id) ON DELETE SET NULL;

ALTER TABLE public.delivery_recipients
  ADD COLUMN IF NOT EXISTS customer_pic_id UUID REFERENCES public.customer_pics (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sales_orders.customer_pic_id IS
  'Forward-compat (Tambah Toko & PIC gate) -- belum dipopulasi workflow mana pun. Disiapkan untuk gate Order Validation Integration berikutnya.';
COMMENT ON COLUMN public.delivery_recipients.customer_pic_id IS
  'Forward-compat (Tambah Toko & PIC gate) -- belum dipopulasi workflow mana pun. Disiapkan untuk gate Delivery Verification lanjutan berikutnya.';

-- ---------------------------------------------------------------------------
-- RPC 1: create_store_with_pic — atomic toko + PIC pertama. Duplicate
-- detection tenant-scoped: exact -> ditolak/redirect (tidak pernah dibuat
-- ulang); similar -> warning, butuh p_override_similar_duplicate eksplisit
-- + alasan; PIC dengan nomor sama di toko lain -> TIDAK PERNAH memblokir,
-- hanya event informational (DUPLICATE_PIC_DETECTED, severity low).
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
  p_override_reason TEXT DEFAULT NULL
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

  -- Idempotency: gunakan tabel event ledger idempotency generik lewat kolom
  -- custom_fields? TIDAK -- pola project memakai UNIQUE(company_id, key) di
  -- tabel dedicated. customers tidak punya kolom idempotency_key (tabel
  -- lama) -- simpan sebagai baris pertama customer_pic_history dengan
  -- change_type='CREATED' + reason berisi idempotency_key untuk pencarian.
  -- Lebih bersih: cek dulu apakah sudah ada customer_pics yang dibuat
  -- dengan idempotency_key yang sama (disimpan di kolom reason, prefix unik).
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
    -- Salesman hanya boleh membuat toko untuk dirinya sendiri, pada area
    -- yang DITUGASKAN kepadanya (bukan sembarang area tenant).
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

  -- Duplicate detection: tenant-scoped saja (company_id = p_company_id di
  -- setiap kondisi WHERE -- tidak pernah lintas tenant).
  SELECT id INTO v_exact_id
  FROM public.customers
  WHERE company_id = p_company_id AND is_active = TRUE
    AND (
      (v_normalized_store_phone IS NOT NULL AND public.normalize_id_phone(phone) = v_normalized_store_phone)
      OR (lower(trim(name)) = lower(trim(p_store_name))
          AND lower(trim(COALESCE(address, ''))) = lower(trim(COALESCE(p_store_address, ''))))
    )
  LIMIT 1;

  IF v_exact_id IS NOT NULL THEN
    RETURN QUERY SELECT 'exact_duplicate_store'::TEXT, NULL::UUID, NULL::UUID, v_exact_id;
    RETURN;
  END IF;

  IF NOT p_override_similar_duplicate THEN
    SELECT id INTO v_similar_id
    FROM public.customers
    WHERE company_id = p_company_id AND is_active = TRUE
      AND (
        (area IS NOT DISTINCT FROM p_store_area AND length(trim(p_store_name)) >= 4
          AND (lower(name) LIKE '%' || lower(trim(p_store_name)) || '%'
               OR lower(trim(p_store_name)) LIKE '%' || lower(name) || '%'))
        OR (lower(trim(COALESCE(address, ''))) = lower(trim(COALESCE(p_store_address, '')))
            AND trim(COALESCE(p_store_address, '')) <> ''
            AND lower(trim(name)) <> lower(trim(p_store_name)))
      )
    LIMIT 1;

    IF v_similar_id IS NOT NULL THEN
      RETURN QUERY SELECT 'similar_duplicate_warning'::TEXT, NULL::UUID, NULL::UUID, v_similar_id;
      RETURN;
    END IF;
  END IF;

  -- ---- Atomic insert: toko + PIC pertama dalam satu transaksi implisit
  -- (kegagalan apa pun setelah titik ini otomatis rollback seluruhnya --
  -- tidak ada record yatim). ----
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
    company_id, customer_id, name, phone, roles, validation_status, created_by
  ) VALUES (
    p_company_id, v_new_customer_id, TRIM(p_pic_name), v_normalized_pic_phone,
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
    jsonb_build_object('pic_name', TRIM(p_pic_name), 'roles', p_pic_roles, 'source', p_source),
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

  -- PIC dengan nomor sama di toko lain -- TIDAK PERNAH memblokir, hanya
  -- sinyal informational (bisa terjadi sah, mis. pemilik grup toko).
  IF EXISTS (
    SELECT 1 FROM public.customer_pics
    WHERE company_id = p_company_id AND phone = v_normalized_pic_phone AND customer_id <> v_new_customer_id
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
  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    p_company_id, p_actor_id, 'customer_pic.created', 'customer_pics', v_new_pic_id,
    jsonb_build_object('customer_id', v_new_customer_id, 'roles', p_pic_roles, 'source', p_source)
  );

  RETURN QUERY SELECT 'created'::TEXT, v_new_customer_id, v_new_pic_id, NULL::UUID;
END;
$$;

REVOKE ALL ON FUNCTION public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_store_with_pic(
  UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT, BOOLEAN, TEXT
) TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 2: create_customer_pic — tambah PIC ke toko yang SUDAH ADA (dashboard
-- admin, atau Salesman lewat Telegram pada toko yang jadi tanggung
-- jawabnya). Selalu UNVERIFIED.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_customer_pic(
  p_company_id UUID,
  p_customer_id UUID,
  p_actor_id UUID,
  p_name TEXT,
  p_phone TEXT,
  p_roles TEXT[],
  p_idempotency_key TEXT,
  p_source TEXT
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
  v_new_pic_id UUID;
  v_existing public.customer_pics%ROWTYPE;
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

  INSERT INTO public.customer_pics (company_id, customer_id, name, phone, roles, validation_status, created_by)
  VALUES (p_company_id, p_customer_id, TRIM(p_name), v_normalized_phone, p_roles, 'UNVERIFIED', p_actor_id)
  RETURNING id INTO v_new_pic_id;

  INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, new_value, reason, source, actor_id)
  VALUES (
    p_company_id, v_new_pic_id, p_customer_id, 'CREATED', TRIM(p_name),
    CASE WHEN p_idempotency_key IS NOT NULL THEN 'idempotency_key:' || p_idempotency_key ELSE NULL END,
    p_source, p_actor_id
  );

  INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
  VALUES (p_company_id, p_customer_id, v_new_pic_id, 'PIC_ADDED', 'info',
    jsonb_build_object('pic_name', TRIM(p_name), 'roles', p_roles, 'source', p_source), p_actor_id);

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
    jsonb_build_object('customer_id', p_customer_id, 'roles', p_roles, 'source', p_source));

  RETURN QUERY SELECT 'created'::TEXT, v_new_pic_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 3: update_customer_pic — koreksi nama/nomor/roles pada baris YANG
-- SAMA (bukan orang berbeda -- untuk PIC berbeda, admin pakai
-- verify_customer_pic(...,'INACTIVE') pada yang lama + create_customer_pic
-- untuk yang baru, supaya "PIC lama tidak dihapus" dan "PIC baru = record
-- baru" tidak butuh RPC mega gabungan). Wajib alasan. Perubahan nomor
-- otomatis menurunkan validation_status ke REVERIFY_REQUIRED (kecuali
-- sudah UNVERIFIED/INACTIVE) -- kepercayaan yang sudah diverifikasi tidak
-- aman lagi dipertahankan pada kontak yang berubah.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_customer_pic(
  p_company_id UUID,
  p_customer_pic_id UUID,
  p_actor_id UUID,
  p_new_name TEXT,
  p_new_phone TEXT,
  p_new_roles TEXT[],
  p_reason TEXT,
  p_source TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pic public.customer_pics%ROWTYPE;
  v_normalized_phone TEXT;
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

  IF NOT v_changed THEN
    RETURN QUERY SELECT 'no_changes'::TEXT;
    RETURN;
  END IF;

  UPDATE public.customer_pics SET
    name = COALESCE(NULLIF(TRIM(p_new_name), ''), name),
    phone = COALESCE(v_normalized_phone, phone),
    roles = COALESCE(p_new_roles, roles),
    validation_status = v_new_status
  WHERE id = p_customer_pic_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (p_company_id, p_actor_id, 'customer_pic.updated', 'customer_pics', p_customer_pic_id,
    jsonb_build_object('name', v_pic.name, 'phone', v_pic.phone, 'roles', v_pic.roles, 'validation_status', v_pic.validation_status),
    jsonb_build_object('name', COALESCE(NULLIF(TRIM(p_new_name), ''), v_pic.name), 'phone', COALESCE(v_normalized_phone, v_pic.phone), 'roles', COALESCE(p_new_roles, v_pic.roles), 'validation_status', v_new_status, 'reason', p_reason));

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.update_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_customer_pic(UUID, UUID, UUID, TEXT, TEXT, TEXT[], TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- RPC 4: verify_customer_pic — Human Review PIC. p_new_status hanya boleh
-- VERIFIED_BY_ADMIN / REVERIFY_REQUIRED / INACTIVE (VERIFIED_BY_ORDER dan
-- VERIFIED_ON_DELIVERY DITOLAK di sini -- reserved untuk integrasi masa
-- depan setelah transaksi nyata terjadi). Reviewer wajib bukan pembuat PIC
-- (self-verify ditolak, dua lapis: cek RPC + CHECK constraint tidak
-- diperlukan di sini karena created_by/verified_by adalah kolom berbeda
-- tanpa constraint DB langsung -- guard murni di RPC, didokumentasikan).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_customer_pic(
  p_company_id UUID,
  p_customer_pic_id UUID,
  p_reviewer_id UUID,
  p_new_status TEXT,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pic public.customer_pics%ROWTYPE;
BEGIN
  IF p_new_status NOT IN ('VERIFIED_BY_ADMIN', 'REVERIFY_REQUIRED', 'INACTIVE') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_reviewer_id AND u.company_id = p_company_id AND u.is_active = TRUE
      AND r.name IN ('owner','manager','admin','super_admin')
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_pic FROM public.customer_pics WHERE id = p_customer_pic_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_pic.created_by = p_reviewer_id THEN
    RETURN QUERY SELECT 'self_verify_forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  UPDATE public.customer_pics
  SET validation_status = p_new_status, verified_by = p_reviewer_id, verified_at = NOW()
  WHERE id = p_customer_pic_id;

  INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, field_name, old_value, new_value, reason, source, actor_id)
  VALUES (p_company_id, p_customer_pic_id, v_pic.customer_id, 'STATUS_CHANGED', 'validation_status', v_pic.validation_status, p_new_status, p_reason, 'ADMIN_DASHBOARD', p_reviewer_id);

  INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
  VALUES (
    p_company_id, v_pic.customer_id, p_customer_pic_id,
    CASE p_new_status
      WHEN 'VERIFIED_BY_ADMIN' THEN 'PIC_VERIFIED'
      WHEN 'REVERIFY_REQUIRED' THEN 'PIC_REVERIFY_REQUIRED'
      ELSE 'PIC_DEACTIVATED'
    END,
    CASE WHEN p_new_status = 'VERIFIED_BY_ADMIN' THEN 'info' ELSE 'medium' END,
    jsonb_build_object('old_status', v_pic.validation_status, 'new_status', p_new_status, 'reason', p_reason),
    p_reviewer_id
  );

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (p_company_id, p_reviewer_id, 'customer_pic.verified', 'customer_pics', p_customer_pic_id,
    jsonb_build_object('validation_status', v_pic.validation_status),
    jsonb_build_object('validation_status', p_new_status, 'reason', p_reason));

  RETURN QUERY SELECT 'verified'::TEXT, p_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_customer_pic(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_customer_pic(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.normalize_id_phone(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_id_phone(TEXT) TO service_role, authenticated;

-- ---------------------------------------------------------------------------
-- Permission baru untuk manual verification (dashboard admin) -- terpisah
-- dari customers.create/update supaya bisa diberikan granular.
-- ---------------------------------------------------------------------------
INSERT INTO public.permissions (name, module, action, description) VALUES
  ('customers.pic_verify', 'customers', 'pic_verify', 'Manual verify/reverify/deactivate customer PIC')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner','manager','admin','super_admin')
  AND p.name = 'customers.pic_verify'
ON CONFLICT DO NOTHING;
