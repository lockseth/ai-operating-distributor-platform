-- =============================================================================
-- Gate 3E-D5-B — Web Kunjungan Sales -> Achievement CALL & EFFECTIVE_CALL
--
-- Keputusan produk (Founder/CTO, lock gate ini) merevisi semantik
-- EFFECTIVE_CALL yang sebelumnya (20260805000001) mensyaratkan order_id:
--   * CALL            = kunjungan Sales yang valid dan selesai.
--   * EFFECTIVE_CALL  = CALL valid yang melibatkan pertemuan dengan pihak
--                        toko serta aktivitas penjualan substantif -- TIDAK
--                        LAGI wajib terhubung ke Sales Order.
--   * ORDER_COUNT/REVENUE/NOO -- TIDAK BERUBAH, tetap kontrak masing-masing
--     (20260917000001, 20260930000001).
--
-- Perubahan constraint MINIMAL: hanya chk_skae_ec_kpi yang dilonggarkan
-- (order_id opsional untuk EFFECTIVE_CALL). Jalur EC lama (order confirmed
-- FIELD_VISIT via credit_effective_call_for_order, 20260805000001) TIDAK
-- disentuh sama sekali -- baris historisnya (call_id+order_id keduanya
-- terisi) tetap valid terhadap constraint baru (superset, bukan pengganti).
-- Identitas "satu kunjungan maksimal satu CALL dan satu EC" ditegakkan lewat
-- call_id yang sama pada kedua event (bukan kolom baru) -- uq_skae_ec_
-- credited_once (unique partial index pada call_id, sudah ada sejak
-- 20260805000001) sudah cukup, tidak perlu diubah.
--
-- Model kunjungan baru: sales_visits (dua fase, IN_PROGRESS -> COMPLETED)
-- adalah workflow web-only yang BERBEDA dari sales_calls Telegram (satu
-- langkah, lewat record_sales_call/RPC lama -- TIDAK disentuh, TIDAK
-- dihapus, tetap dipakai Telegram). sales_calls (ledger CALL) DIPAKAI ULANG
-- sebagai fakta CALL untuk kedua jalur -- bukan ledger paralel. Baris CALL
-- dari kunjungan web ditandai coverage_basis='WEB_VISIT' (nilai enum baru,
-- additive) karena jalur ini SENGAJA tidak menegakkan assignment/area
-- coverage seperti Telegram (kontrak gate ini hanya mensyaratkan "customer
-- dari tenant yang sama", lihat instruksi -- tidak ada skenario out_of_
-- coverage di antara 20 test wajib).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Longgarkan chk_skae_ec_kpi: EFFECTIVE_CALL wajib call_id, order_id
--    sekarang OPSIONAL (NULL untuk EC yang lahir dari kunjungan web; tetap
--    terisi untuk EC historis dari order FIELD_VISIT -- kedua bentuk valid).
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_kpi_achievement_events
  DROP CONSTRAINT chk_skae_ec_kpi;

ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_ec_kpi CHECK (
    kpi_code <> 'EFFECTIVE_CALL' OR call_id IS NOT NULL
  );

COMMENT ON CONSTRAINT chk_skae_ec_kpi ON public.sales_kpi_achievement_events IS
  'EFFECTIVE_CALL selalu butuh call_id (identitas kunjungan/Call yang sama dengan event CALL-nya). order_id OPSIONAL sejak Gate 3E-D5-B -- EC historis dari Sales Order FIELD_VISIT (20260805000001) tetap mengisi order_id, EC dari Kunjungan Sales web (gate ini) tidak.';

-- ---------------------------------------------------------------------------
-- 2. sales_calls.coverage_basis: tambah nilai 'WEB_VISIT' (additive, tidak
--    mengubah baris existing). Dipakai HANYA oleh complete_sales_visit di
--    bawah -- Telegram/record_sales_call tetap ASSIGNED/AREA/EXCEPTION.
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_calls
  DROP CONSTRAINT sales_calls_coverage_basis_check;

ALTER TABLE public.sales_calls
  ADD CONSTRAINT sales_calls_coverage_basis_check
  CHECK (coverage_basis IN ('ASSIGNED', 'AREA', 'EXCEPTION', 'WEB_VISIT'));

-- ---------------------------------------------------------------------------
-- 3. sales_visits: workflow dua-fase (Mulai Kunjungan -> Selesaikan
--    Kunjungan) khusus web. BUKAN ledger achievement -- achievement tetap
--    hanya lahir di sales_calls + sales_kpi_achievement_events lewat RPC di
--    bawah. Kolom fakta "mulai" append-only (trigger), kolom "selesai" hanya
--    boleh terisi SEKALI (IN_PROGRESS -> COMPLETED), lalu seluruh baris
--    immutable -- pola yang sama dengan sales_calls.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_visits (
  id                        UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID              NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  salesperson_id            UUID              NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  customer_id                UUID              NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  visit_purpose             VARCHAR(30)       NOT NULL CHECK (visit_purpose IN (
                               'OFFER_PRODUCT', 'CHECK_STOCK', 'COLLECTION', 'HANDLE_COMPLAINT',
                               'FOLLOW_UP', 'RELATIONSHIP', 'OTHER'
                             )),
  plan_notes                TEXT,
  start_latitude             DOUBLE PRECISION NOT NULL CHECK (start_latitude BETWEEN -90 AND 90),
  start_longitude            DOUBLE PRECISION NOT NULL CHECK (start_longitude BETWEEN -180 AND 180),
  started_at                TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  status                    VARCHAR(20)       NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  visit_result              VARCHAR(30)       CHECK (visit_result IN (
                               'MET_STORE', 'STORE_CLOSED', 'PERSON_NOT_AVAILABLE',
                               'ADDRESS_NOT_FOUND', 'VISIT_CANCELLED', 'OTHER'
                             )),
  met_with                  VARCHAR(30)       CHECK (met_with IN ('OWNER', 'PURCHASING', 'CASHIER', 'EMPLOYEE', 'OTHER')),
  met_person_name           TEXT,
  activities                TEXT[]            NOT NULL DEFAULT '{}',
  result_notes              TEXT,
  follow_up_needed          BOOLEAN           NOT NULL DEFAULT FALSE,
  follow_up_plan            TEXT,
  follow_up_date            DATE,
  photo_url                 TEXT,
  end_latitude               DOUBLE PRECISION CHECK (end_latitude IS NULL OR end_latitude BETWEEN -90 AND 90),
  end_longitude               DOUBLE PRECISION CHECK (end_longitude IS NULL OR end_longitude BETWEEN -180 AND 180),
  completed_at               TIMESTAMPTZ,
  call_id                    UUID              REFERENCES public.sales_calls (id) ON DELETE SET NULL,
  start_idempotency_key       TEXT              NOT NULL,
  complete_idempotency_key    TEXT,
  created_by                 UUID              NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at                 TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, start_idempotency_key),
  CONSTRAINT chk_sales_visits_completion_pair CHECK (
    (status = 'IN_PROGRESS' AND completed_at IS NULL AND visit_result IS NULL) OR
    (status = 'COMPLETED' AND completed_at IS NOT NULL AND visit_result IS NOT NULL)
  ),
  CONSTRAINT chk_sales_visits_met_with CHECK (
    visit_result IS DISTINCT FROM 'MET_STORE' OR met_with IS NOT NULL
  ),
  CONSTRAINT chk_sales_visits_met_with_scope CHECK (
    visit_result = 'MET_STORE' OR met_with IS NULL
  ),
  CONSTRAINT chk_sales_visits_follow_up CHECK (
    follow_up_needed = FALSE OR (
      follow_up_plan IS NOT NULL AND length(trim(follow_up_plan)) >= 3 AND follow_up_date IS NOT NULL
    )
  ),
  CONSTRAINT chk_sales_visits_result_notes CHECK (
    status = 'IN_PROGRESS' OR (result_notes IS NOT NULL AND length(trim(result_notes)) >= 3)
  )
);

CREATE UNIQUE INDEX uq_sales_visits_one_active_per_salesperson
  ON public.sales_visits (company_id, salesperson_id)
  WHERE status = 'IN_PROGRESS';

CREATE INDEX idx_sales_visits_salesperson
  ON public.sales_visits (company_id, salesperson_id, started_at DESC);

COMMENT ON TABLE public.sales_visits IS
  'Workflow web dua-fase Kunjungan Sales (Gate 3E-D5-B). Kolom "mulai" append-only, kolom "selesai" hanya boleh terisi sekali (trg_sales_visits_enforce_transition). BUKAN ledger achievement -- CALL/EFFECTIVE_CALL tetap hanya lahir di sales_calls/sales_kpi_achievement_events lewat complete_sales_visit.';

ALTER TABLE public.sales_visits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_visits_select" ON public.sales_visits
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner', 'manager', 'super_admin'])
    )
  );

REVOKE ALL ON TABLE public.sales_visits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sales_visits TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_sales_visits_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'sales_visits: kunjungan yang sudah selesai bersifat immutable (id=%)', OLD.id;
  END IF;
  IF NEW.company_id              IS DISTINCT FROM OLD.company_id
     OR NEW.salesperson_id       IS DISTINCT FROM OLD.salesperson_id
     OR NEW.customer_id          IS DISTINCT FROM OLD.customer_id
     OR NEW.visit_purpose        IS DISTINCT FROM OLD.visit_purpose
     OR NEW.plan_notes           IS DISTINCT FROM OLD.plan_notes
     OR NEW.start_latitude       IS DISTINCT FROM OLD.start_latitude
     OR NEW.start_longitude      IS DISTINCT FROM OLD.start_longitude
     OR NEW.started_at           IS DISTINCT FROM OLD.started_at
     OR NEW.start_idempotency_key IS DISTINCT FROM OLD.start_idempotency_key
     OR NEW.created_by           IS DISTINCT FROM OLD.created_by
     OR NEW.created_at           IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'sales_visits: kolom awal kunjungan bersifat append-only (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_visits_enforce_transition
  BEFORE UPDATE ON public.sales_visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_visits_transition();

CREATE OR REPLACE FUNCTION public.forbid_sales_visits_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sales_visits: DELETE dilarang (id=%)', OLD.id;
END;
$$;

CREATE TRIGGER trg_sales_visits_forbid_delete
  BEFORE DELETE ON public.sales_visits
  FOR EACH ROW EXECUTE FUNCTION public.forbid_sales_visits_delete();

-- ---------------------------------------------------------------------------
-- 4. RPC: start_sales_visit. Actor = Salesman sendiri, TIDAK ADA proxy
--    manager (berbeda dari record_sales_call) -- kontrak gate ini eksplisit
--    "Sales hanya boleh membuat, melihat, dan menyelesaikan kunjungannya
--    sendiri". Satu kunjungan aktif per salesman ditegakkan advisory lock +
--    UNIQUE INDEX partial (defense in depth).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_sales_visit(
  p_company_id UUID,
  p_actor_id UUID,
  p_customer_id UUID,
  p_visit_purpose TEXT,
  p_plan_notes TEXT,
  p_start_latitude DOUBLE PRECISION,
  p_start_longitude DOUBLE PRECISION,
  p_idempotency_key TEXT
)
RETURNS TABLE(result_outcome TEXT, result_visit_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_ok BOOLEAN;
  v_customer_ok BOOLEAN;
  v_existing_id UUID;
  v_new_id UUID;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'sales'
  ) INTO v_actor_ok;

  IF NOT v_actor_ok THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_visit_purpose IS NULL OR p_visit_purpose NOT IN (
    'OFFER_PRODUCT', 'CHECK_STOCK', 'COLLECTION', 'HANDLE_COMPLAINT', 'FOLLOW_UP', 'RELATIONSHIP', 'OTHER'
  ) THEN
    RETURN QUERY SELECT 'invalid_purpose'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_start_latitude IS NULL OR p_start_longitude IS NULL
     OR p_start_latitude < -90 OR p_start_latitude > 90
     OR p_start_longitude < -180 OR p_start_longitude > 180
  THEN
    RETURN QUERY SELECT 'invalid_location'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN QUERY SELECT 'idempotency_key_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::TEXT || ':visit-start:' || p_actor_id::TEXT, 1
  ));

  SELECT id INTO v_existing_id
  FROM public.sales_visits
  WHERE company_id = p_company_id AND start_idempotency_key = trim(p_idempotency_key);

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_started'::TEXT, v_existing_id;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.customers c
    WHERE c.id = p_customer_id AND c.company_id = p_company_id AND c.is_active = TRUE
  ) INTO v_customer_ok;

  IF NOT v_customer_ok THEN
    RETURN QUERY SELECT 'customer_not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.sales_visits
    WHERE company_id = p_company_id AND salesperson_id = p_actor_id AND status = 'IN_PROGRESS'
  ) THEN
    RETURN QUERY SELECT 'visit_already_active'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.sales_visits (
    company_id, salesperson_id, customer_id, visit_purpose, plan_notes,
    start_latitude, start_longitude, start_idempotency_key, created_by
  ) VALUES (
    p_company_id, p_actor_id, p_customer_id, p_visit_purpose,
    NULLIF(trim(COALESCE(p_plan_notes, '')), ''),
    p_start_latitude, p_start_longitude, trim(p_idempotency_key), p_actor_id
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'sales_visit.started', 'sales_visits', v_new_id,
    jsonb_build_object('customer_id', p_customer_id, 'visit_purpose', p_visit_purpose)
  );

  RETURN QUERY SELECT 'started'::TEXT, v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. RPC: complete_sales_visit. Actor = Salesman pemilik kunjungan (self
--    only). Menegakkan seluruh matriks CALL/EC gate ini dalam SATU transaksi
--    atomik: update sales_visits -> COMPLETED, lalu (jika bukan dibatalkan
--    DAN periode KPI aktif) insert sales_calls + kredit CALL, lalu (jika
--    efektif) kredit EFFECTIVE_CALL -- TANPA order_id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_sales_visit(
  p_company_id UUID,
  p_actor_id UUID,
  p_visit_id UUID,
  p_visit_result TEXT,
  p_met_with TEXT,
  p_met_person_name TEXT,
  p_activities TEXT[],
  p_result_notes TEXT,
  p_follow_up_needed BOOLEAN,
  p_follow_up_plan TEXT,
  p_follow_up_date DATE,
  p_photo_url TEXT,
  p_end_latitude DOUBLE PRECISION,
  p_end_longitude DOUBLE PRECISION,
  p_idempotency_key TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  result_visit_id UUID,
  result_call_credited BOOLEAN,
  result_ec_credited BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_ok BOOLEAN;
  v_visit RECORD;
  v_activity TEXT;
  v_valid_activities TEXT[] := ARRAY[
    'OFFER_PRODUCT', 'CHECK_STOCK', 'EXPLAIN_PROMO', 'COLLECT_PAYMENT',
    'HANDLE_COMPLAINT', 'MARKET_INFO', 'AGREE_FOLLOW_UP'
  ];
  v_is_effective BOOLEAN;
  v_business_date DATE;
  v_call_id UUID;
  v_period_active BOOLEAN;
  v_call_credited BOOLEAN := FALSE;
  v_ec_credited BOOLEAN := FALSE;
BEGIN
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN QUERY SELECT 'idempotency_key_required'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'sales'
  ) INTO v_actor_ok;

  IF NOT v_actor_ok THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::TEXT || ':visit-complete:' || p_visit_id::TEXT, 1
  ));

  SELECT * INTO v_visit
  FROM public.sales_visits
  WHERE id = p_visit_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_visit.id IS NULL THEN
    RETURN QUERY SELECT 'visit_not_found'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF v_visit.salesperson_id <> p_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF v_visit.status = 'COMPLETED' THEN
    IF v_visit.complete_idempotency_key = trim(p_idempotency_key) THEN
      RETURN QUERY SELECT
        'already_recorded'::TEXT,
        v_visit.id,
        (v_visit.call_id IS NOT NULL),
        EXISTS (
          SELECT 1 FROM public.sales_kpi_achievement_events
          WHERE call_id = v_visit.call_id AND kpi_code = 'EFFECTIVE_CALL' AND event_type = 'CREDITED'
        );
      RETURN;
    END IF;
    RETURN QUERY SELECT 'already_completed'::TEXT, v_visit.id, FALSE, FALSE;
    RETURN;
  END IF;

  IF p_visit_result IS NULL OR p_visit_result NOT IN (
    'MET_STORE', 'STORE_CLOSED', 'PERSON_NOT_AVAILABLE', 'ADDRESS_NOT_FOUND', 'VISIT_CANCELLED', 'OTHER'
  ) THEN
    RETURN QUERY SELECT 'invalid_result'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF p_visit_result = 'MET_STORE' AND (
    p_met_with IS NULL OR p_met_with NOT IN ('OWNER', 'PURCHASING', 'CASHIER', 'EMPLOYEE', 'OTHER')
  ) THEN
    RETURN QUERY SELECT 'met_with_required'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;
  IF p_visit_result <> 'MET_STORE' AND p_met_with IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF p_result_notes IS NULL OR length(trim(p_result_notes)) < 3 THEN
    RETURN QUERY SELECT 'result_notes_required'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF COALESCE(p_follow_up_needed, FALSE) AND (
    p_follow_up_plan IS NULL OR length(trim(p_follow_up_plan)) < 3 OR p_follow_up_date IS NULL
  ) THEN
    RETURN QUERY SELECT 'follow_up_required'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF p_end_latitude IS NULL OR p_end_longitude IS NULL
     OR p_end_latitude < -90 OR p_end_latitude > 90
     OR p_end_longitude < -180 OR p_end_longitude > 180
  THEN
    RETURN QUERY SELECT 'invalid_location'::TEXT, NULL::UUID, FALSE, FALSE;
    RETURN;
  END IF;

  IF p_activities IS NOT NULL THEN
    FOREACH v_activity IN ARRAY p_activities LOOP
      IF NOT (v_activity = ANY(v_valid_activities)) THEN
        RETURN QUERY SELECT 'invalid_activity'::TEXT, NULL::UUID, FALSE, FALSE;
        RETURN;
      END IF;
    END LOOP;
  END IF;

  v_business_date := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
  v_is_effective := (
    p_visit_result = 'MET_STORE'
    AND p_met_with IS NOT NULL
    AND p_activities IS NOT NULL
    AND array_length(p_activities, 1) > 0
  );

  -- Kredit CALL/EC (jika berlaku) dihitung DULU, lalu sales_visits di-UPDATE
  -- TEPAT SEKALI di bawah -- trg_sales_visits_enforce_transition menolak
  -- UPDATE kedua pada baris yang statusnya sudah COMPLETED (termasuk dari
  -- pemanggil fungsi ini sendiri), jadi status/hasil/call_id harus lahir
  -- dalam satu UPDATE yang sama, bukan dua UPDATE berurutan.
  IF p_visit_result <> 'VISIT_CANCELLED' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.sales_kpi_periods
      WHERE company_id = p_company_id
        AND status = 'ACTIVE'
        AND v_business_date BETWEEN start_date AND end_date
    ) INTO v_period_active;

    IF v_period_active THEN
      INSERT INTO public.sales_calls (
        company_id, salesperson_id, customer_id, call_date, outcome_notes,
        coverage_basis, idempotency_key, created_by
      ) VALUES (
        p_company_id, v_visit.salesperson_id, v_visit.customer_id, v_business_date, trim(p_result_notes),
        'WEB_VISIT', 'web-visit:' || v_visit.id::TEXT, p_actor_id
      )
      RETURNING id INTO v_call_id;

      INSERT INTO public.sales_kpi_achievement_events (
        company_id, salesperson_id, kpi_code, event_type, business_date,
        source_type, source_id, call_id, idempotency_key, actor_type, actor_id
      ) VALUES (
        p_company_id, v_visit.salesperson_id, 'CALL', 'CREDITED', v_business_date,
        'SALES_CALL', v_call_id, v_call_id, 'call:' || v_call_id::TEXT, 'USER', p_actor_id
      )
      ON CONFLICT (company_id, idempotency_key) DO NOTHING;
      v_call_credited := TRUE;

      IF v_is_effective THEN
        INSERT INTO public.sales_kpi_achievement_events (
          company_id, salesperson_id, kpi_code, event_type, business_date,
          source_type, source_id, call_id, idempotency_key, actor_type, actor_id
        ) VALUES (
          p_company_id, v_visit.salesperson_id, 'EFFECTIVE_CALL', 'CREDITED', v_business_date,
          'SALES_CALL', v_call_id, v_call_id, 'ec:' || v_call_id::TEXT, 'USER', p_actor_id
        )
        ON CONFLICT (company_id, idempotency_key) DO NOTHING;
        v_ec_credited := TRUE;
      END IF;
    END IF;
  END IF;

  UPDATE public.sales_visits SET
    status = 'COMPLETED',
    visit_result = p_visit_result,
    met_with = p_met_with,
    met_person_name = NULLIF(trim(COALESCE(p_met_person_name, '')), ''),
    activities = COALESCE(p_activities, '{}'),
    result_notes = trim(p_result_notes),
    follow_up_needed = COALESCE(p_follow_up_needed, FALSE),
    follow_up_plan = NULLIF(trim(COALESCE(p_follow_up_plan, '')), ''),
    follow_up_date = p_follow_up_date,
    photo_url = NULLIF(trim(COALESCE(p_photo_url, '')), ''),
    end_latitude = p_end_latitude,
    end_longitude = p_end_longitude,
    completed_at = NOW(),
    complete_idempotency_key = trim(p_idempotency_key),
    call_id = v_call_id
  WHERE id = p_visit_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, p_actor_id, 'sales_visit.completed', 'sales_visits', v_visit.id,
    jsonb_build_object(
      'visit_result', p_visit_result, 'call_id', v_call_id,
      'call_credited', v_call_credited, 'ec_credited', v_ec_credited
    ));

  IF p_visit_result = 'VISIT_CANCELLED' THEN
    RETURN QUERY SELECT 'completed_cancelled'::TEXT, v_visit.id, FALSE, FALSE;
  ELSIF NOT v_call_credited THEN
    RETURN QUERY SELECT 'completed_no_active_period'::TEXT, v_visit.id, FALSE, FALSE;
  ELSE
    RETURN QUERY SELECT 'completed'::TEXT, v_visit.id, v_call_credited, v_ec_credited;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.start_sales_visit(UUID, UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_sales_visit(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, DATE, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_sales_visit(UUID, UUID, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_sales_visit(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, DATE, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT)
  TO service_role;
