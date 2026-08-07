-- =============================================================================
-- Gate 3E-D5-A — KPI Salesman: Target Periode NOO (New Outlet Opening / Buka
-- Toko Baru)
--
-- Menambah SATU kode KPI governed baru ke sistem yang sudah ada
-- (public.sales_kpi_*, sales_kpi_achievement_events) -- TIDAK membuat sistem
-- KPI ketiga, mengikuti pola persis 20260917000001 (ORDER_COUNT/REVENUE):
-- extend constraint, extend initializer, extend set_sales_kpi_target,
-- tambah trigger crediting pada sales_orders.
--
-- Kontrak NOO (lock, gate ini):
--   1. NOO tercapai ketika CUSTOMER menghasilkan sales order berstatus
--      'confirmed' UNTUK PERTAMA KALINYA sepanjang histori tenant/company --
--      BUKAN saat customer dibuat, BUKAN customers.created_at.
--   2. Kredit diberikan ke salesperson_id = sales_orders.sales_id order
--      tersebut (atribusi order, sama seperti ORDER_COUNT/REVENUE) --
--      order tanpa sales_id TIDAK PERNAH mengkredit siapa pun.
--   3. Maksimal SATU kredit NOO CREDITED seumur hidup per customer --
--      ditegakkan lewat UNIQUE INDEX partial pada customer_id (bukan hanya
--      idempotency_key), sehingga invariant ini berlaku di level database,
--      bukan hanya di logic trigger.
--   4. "Pernah confirmed sebelumnya" dihitung dari SELURUH histori
--      sales_orders customer tsb (termasuk order is_historical=TRUE) --
--      customer dengan legacy-imported confirmed order TIDAK LAGI dianggap
--      NOO baru, sesuai kontrak "sudah pernah confirmed sebelum periode
--      aktif bukan NOO lagi".
--   5. Draft/pending/rejected/cancelled TIDAK PERNAH mengkredit (trigger
--      hanya fire saat status benar-benar menjadi 'confirmed').
--   6. Retry/idempotent confirmation & concurrent confirmation tidak pernah
--      menggandakan kredit -- pg_advisory_xact_lock per (company,customer)
--      menyerialkan keputusan "first-ever" antar transaksi konkuren, PLUS
--      ON CONFLICT idempotency_key, PLUS UNIQUE INDEX customer_id sebagai
--      backstop berlapis (defense in depth, pola yang sama seperti seluruh
--      modul ini).
--   7. Legacy import (is_historical=TRUE) pada order YANG SEDANG diproses
--      tidak pernah mengkredit (pola sama seperti CALL/EC/ORDER_COUNT/
--      REVENUE) -- tapi TETAP dihitung sebagai "pernah confirmed" untuk
--      order lain di customer yang sama (lihat poin 4).
--   8. Reversal-on-cancel TIDAK diimplementasikan pada gate ini -- kontrak
--      instruksi eksplisit menyebut "maksimal satu kredit NOO seumur
--      hidup" (bukan "net credit saat ini"), dan tidak ada skenario test
--      yang meminta reversal. Jika order pertama yang mengkredit NOO
--      kemudian dibatalkan/dispute, kredit NOO TETAP ada (limitation
--      eksplisit -- dicatat di laporan gate, konsisten dengan pola
--      20260917000001 mencatat limitation REVENUE vs credit note).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. sales_kpi_definitions: measurement_source baru untuk NOO.
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_kpi_definitions
  DROP CONSTRAINT sales_kpi_definitions_measurement_source_check;

ALTER TABLE public.sales_kpi_definitions
  ADD CONSTRAINT sales_kpi_definitions_measurement_source_check
  CHECK (measurement_source IN (
    'VALID_FIELD_VISIT',
    'CONFIRMED_FIELD_VISIT_ORDER',
    'CONFIRMED_SALES_ORDER_COUNT',
    'CONFIRMED_SALES_ORDER_REVENUE',
    'FIRST_CONFIRMED_ORDER_PER_CUSTOMER'
  ));

-- ---------------------------------------------------------------------------
-- 2. sales_kpi_achievement_events: kpi_code NOO + kolom customer_id (dipakai
--    HANYA oleh NOO -- CALL/EFFECTIVE_CALL/ORDER_COUNT/REVENUE tidak
--    memerlukannya, tetap NULL untuk baris lama/baris KPI lain).
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_kpi_achievement_events
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers (id) ON DELETE RESTRICT;

ALTER TABLE public.sales_kpi_achievement_events
  DROP CONSTRAINT sales_kpi_achievement_events_kpi_code_check;
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT sales_kpi_achievement_events_kpi_code_check
  CHECK (kpi_code IN ('CALL', 'EFFECTIVE_CALL', 'ORDER_COUNT', 'REVENUE', 'NOO'));

ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_noo_kpi CHECK (
    kpi_code <> 'NOO' OR (order_id IS NOT NULL AND customer_id IS NOT NULL)
  );

ALTER TABLE public.sales_kpi_achievement_events
  DROP CONSTRAINT chk_skae_value_by_kpi;
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_value_by_kpi CHECK (
    (kpi_code IN ('CALL', 'EFFECTIVE_CALL', 'ORDER_COUNT', 'NOO') AND value = 1) OR
    (kpi_code = 'REVENUE' AND value >= 0)
  );

COMMENT ON COLUMN public.sales_kpi_achievement_events.customer_id IS
  'Toko yang dikreditkan -- HANYA diisi untuk kpi_code=NOO (order pertama yang confirmed untuk customer ini). NULL untuk baris KPI lain.';

-- Invariant inti: maksimal SATU baris NOO CREDITED seumur hidup per
-- customer -- database-level, bukan hanya trigger logic.
CREATE UNIQUE INDEX uq_skae_noo_credited_once
  ON public.sales_kpi_achievement_events (customer_id)
  WHERE kpi_code = 'NOO' AND event_type = 'CREDITED';

-- ---------------------------------------------------------------------------
-- 3. initialize_sales_kpi_foundation: CREATE OR REPLACE berbasis body LIVE
--    20260917000001, menambah definisi NOO. Idempotent lewat ON CONFLICT
--    DO NOTHING yang sudah ada -- tenant existing yang memanggil ulang RPC
--    ini hanya akan mendapat NOO baru ditambahkan, definisi lain tidak
--    disentuh.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.initialize_sales_kpi_foundation(
  p_company_id UUID,
  p_actor_id UUID
)
RETURNS TABLE(result_outcome TEXT, definition_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_inserted INTEGER := 0;
BEGIN
  SELECT r.name INTO v_actor_role
  FROM public.users u
  JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
  JOIN public.roles r ON r.id = ur.role_id
  WHERE u.id = p_actor_id
    AND u.company_id = p_company_id
    AND u.is_active = TRUE
    AND r.name IN ('owner','manager','super_admin')
  ORDER BY CASE r.name WHEN 'owner' THEN 1 WHEN 'super_admin' THEN 2 WHEN 'manager' THEN 3 END
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, 0;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::TEXT || ':sales-kpi-init', 1));

  INSERT INTO public.sales_kpi_definitions (
    company_id, code, name, description, unit, measurement_source,
    version, effective_from, created_by
  ) VALUES
    (
      p_company_id,
      'CALL',
      'Call',
      'Kunjungan operasional valid Salesman ke toko assignment/coverage.',
      'COUNT',
      'VALID_FIELD_VISIT',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'EFFECTIVE_CALL',
      'Effective Call',
      'Call valid yang menghasilkan Sales Order confirmed dengan order_source FIELD_VISIT.',
      'COUNT',
      'CONFIRMED_FIELD_VISIT_ORDER',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'ORDER_COUNT',
      'Order Count',
      'Jumlah Sales Order confirmed pada periode ini -- semua channel/order_source (bukan hanya Telegram, bukan hanya FIELD_VISIT).',
      'COUNT',
      'CONFIRMED_SALES_ORDER_COUNT',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'REVENUE',
      'Revenue',
      'Total omzet (final_amount) Sales Order confirmed pada periode ini, dikurangi order yang dibatalkan -- semua channel/order_source.',
      'IDR',
      'CONFIRMED_SALES_ORDER_REVENUE',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'NOO',
      'NOO / Buka Toko Baru',
      'Jumlah toko baru produktif -- customer yang sales order confirmed PERTAMA KALInya jatuh pada periode ini, sepanjang histori tenant.',
      'COUNT',
      'FIRST_CONFIRMED_ORDER_PER_CUSTOMER',
      1,
      CURRENT_DATE,
      p_actor_id
    )
  ON CONFLICT (company_id, code, version) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted > 0 THEN
    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id,
      p_actor_id,
      'sales_kpi.foundation_initialized',
      'sales_kpi_definitions',
      NULL,
      jsonb_build_object(
        'codes', jsonb_build_array('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE','NOO'),
        'definition_count', v_inserted,
        'ar_is_kpi', FALSE,
        'weighted_score_enabled', FALSE
      ),
      v_actor_role,
      'audit',
      'sales_kpi',
      'rpc',
      'success'
    );
  END IF;

  RETURN QUERY SELECT
    CASE WHEN v_inserted = 0 THEN 'already_initialized' ELSE 'initialized' END::TEXT,
    (
      SELECT COUNT(*)::INTEGER
      FROM public.sales_kpi_definitions d
      WHERE d.company_id = p_company_id
        AND d.superseded_at IS NULL
        AND d.code IN ('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE','NOO')
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. set_sales_kpi_target: CREATE OR REPLACE berbasis body LIVE
--    20260917000001, satu-satunya perubahan adalah daftar kpi_code yang
--    didukung (menambah NOO). Signature TIDAK berubah.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_sales_kpi_target(
  p_company_id UUID,
  p_actor_id UUID,
  p_period_id UUID,
  p_salesperson_id UUID,
  p_kpi_code TEXT,
  p_target_value INTEGER,
  p_change_reason TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  result_target_id UUID,
  result_version INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_salesperson_allowed BOOLEAN;
  v_period_status TEXT;
  v_definition_id UUID;
  v_current_id UUID;
  v_current_value INTEGER;
  v_current_version INTEGER;
  v_new_id UUID;
  v_new_version INTEGER;
BEGIN
  SELECT r.name INTO v_actor_role
  FROM public.users u
  JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
  JOIN public.roles r ON r.id = ur.role_id
  WHERE u.id = p_actor_id
    AND u.company_id = p_company_id
    AND u.is_active = TRUE
    AND r.name IN ('owner','manager','super_admin')
  ORDER BY CASE r.name WHEN 'owner' THEN 1 WHEN 'super_admin' THEN 2 WHEN 'manager' THEN 3 END
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_kpi_code IS NULL OR p_kpi_code NOT IN ('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE','NOO') THEN
    RETURN QUERY SELECT 'unsupported_kpi'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_target_value IS NULL OR p_target_value < 0 THEN
    RETURN QUERY SELECT 'invalid_target'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_change_reason IS NULL OR length(trim(p_change_reason)) < 3 THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT p.status
  INTO v_period_status
  FROM public.sales_kpi_periods p
  WHERE p.id = p_period_id AND p.company_id = p_company_id
  FOR UPDATE;

  IF v_period_status IS NULL THEN
    RETURN QUERY SELECT 'period_not_found'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF v_period_status = 'LOCKED' THEN
    RETURN QUERY SELECT 'period_locked'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_salesperson_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'sales'
  ) INTO v_salesperson_allowed;

  IF NOT v_salesperson_allowed THEN
    RETURN QUERY SELECT 'salesperson_not_eligible'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT d.id
  INTO v_definition_id
  FROM public.sales_kpi_definitions d
  WHERE d.company_id = p_company_id
    AND d.code = p_kpi_code
    AND d.superseded_at IS NULL;

  IF v_definition_id IS NULL THEN
    RETURN QUERY SELECT 'foundation_not_initialized'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::TEXT || ':' || p_period_id::TEXT || ':' ||
    p_salesperson_id::TEXT || ':' || p_kpi_code,
    1
  ));

  SELECT t.id, t.target_value, t.version
  INTO v_current_id, v_current_value, v_current_version
  FROM public.sales_kpi_targets t
  WHERE t.company_id = p_company_id
    AND t.period_id = p_period_id
    AND t.salesperson_id = p_salesperson_id
    AND t.kpi_definition_id = v_definition_id
    AND t.status = 'ACTIVE'
  FOR UPDATE;

  IF v_current_id IS NOT NULL AND v_current_value = p_target_value THEN
    RETURN QUERY SELECT 'unchanged'::TEXT, v_current_id, v_current_version;
    RETURN;
  END IF;

  v_new_version := COALESCE(v_current_version, 0) + 1;

  IF v_current_id IS NOT NULL THEN
    UPDATE public.sales_kpi_targets
    SET status = 'SUPERSEDED', superseded_at = NOW()
    WHERE id = v_current_id;
  END IF;

  INSERT INTO public.sales_kpi_targets (
    company_id, period_id, salesperson_id, kpi_definition_id,
    target_value, version, status, previous_target_id,
    change_reason, created_by
  ) VALUES (
    p_company_id, p_period_id, p_salesperson_id, v_definition_id,
    p_target_value, v_new_version, 'ACTIVE', v_current_id,
    trim(p_change_reason), p_actor_id
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id,
    p_actor_id,
    CASE WHEN v_current_id IS NULL
      THEN 'sales_kpi.target_created'
      ELSE 'sales_kpi.target_revised'
    END,
    'sales_kpi_targets',
    v_new_id,
    CASE WHEN v_current_id IS NULL THEN NULL ELSE jsonb_build_object(
      'target_id', v_current_id,
      'target_value', v_current_value,
      'version', v_current_version
    ) END,
    jsonb_build_object(
      'period_id', p_period_id,
      'salesperson_id', p_salesperson_id,
      'kpi_code', p_kpi_code,
      'target_value', p_target_value,
      'version', v_new_version,
      'previous_target_id', v_current_id,
      'change_reason', trim(p_change_reason)
    ),
    v_actor_role,
    'audit',
    'sales_kpi',
    'rpc',
    'success'
  );

  RETURN QUERY SELECT
    CASE WHEN v_current_id IS NULL THEN 'created' ELSE 'updated' END::TEXT,
    v_new_id,
    v_new_version;
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_sales_kpi_foundation(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_sales_kpi_target(UUID, UUID, UUID, UUID, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_sales_kpi_foundation(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_sales_kpi_target(UUID, UUID, UUID, UUID, TEXT, INTEGER, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Kredit NOO otomatis. Fires pada SETIAP order confirmed (insert langsung
--    confirmed, ATAU transisi status -> confirmed), SEMUA channel/
--    order_source -- sama seperti ORDER_COUNT/REVENUE. Advisory lock per
--    (company,customer) menyerialkan keputusan "first-ever confirmed order"
--    terhadap order LAIN pada customer yang sama yang mungkin sedang
--    confirmed bersamaan di transaksi lain.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.credit_noo_for_sales_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_business_date DATE;
  v_prior_confirmed_exists BOOLEAN;
BEGIN
  IF NEW.status <> 'confirmed' OR NEW.is_historical OR NEW.sales_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.company_id::TEXT || ':noo:' || NEW.customer_id::TEXT, 1
  ));

  -- "Pernah confirmed sebelumnya" = ADA order LAIN (bukan NEW.id sendiri)
  -- milik customer ini yang statusnya confirmed -- mencakup order
  -- is_historical=TRUE (legacy import), sesuai kontrak poin 10 instruksi
  -- (customer dengan confirmed order sebelum periode aktif bukan NOO lagi).
  SELECT EXISTS (
    SELECT 1 FROM public.sales_orders so
    WHERE so.customer_id = NEW.customer_id
      AND so.company_id = NEW.company_id
      AND so.status = 'confirmed'
      AND so.id <> NEW.id
  ) INTO v_prior_confirmed_exists;

  IF v_prior_confirmed_exists THEN
    RETURN NEW;
  END IF;

  v_business_date := (COALESCE(NEW.confirmed_at, NOW()) AT TIME ZONE 'Asia/Jakarta')::DATE;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, order_id, customer_id, idempotency_key, value, actor_type
  ) VALUES (
    NEW.company_id, NEW.sales_id, 'NOO', 'CREDITED', v_business_date,
    'SALES_ORDER', NEW.id, NEW.id, NEW.customer_id, 'noo:' || NEW.customer_id::TEXT, 1, 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_credit_noo
  AFTER INSERT OR UPDATE OF status ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.status = 'confirmed')
  EXECUTE FUNCTION public.credit_noo_for_sales_order();

COMMENT ON FUNCTION public.credit_noo_for_sales_order() IS
  'Mengkredit NOO (New Outlet Opening) saat customer menghasilkan sales order confirmed pertama kalinya sepanjang histori tenant. Reversal-on-cancel SENGAJA TIDAK diimplementasikan (limitation eksplisit, lihat header migrasi 20260930000001) -- kontrak "maksimal satu kredit NOO seumur hidup" per customer ditegakkan permanen lewat uq_skae_noo_credited_once.';
