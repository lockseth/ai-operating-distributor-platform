-- =============================================================================
-- Gate 1D-B (K1) — Retrofit audit writer kanonis: KPI configuration & period
-- target.
--
-- Empat RPC di bawah (20260804000001 + 20260806000001) SUDAH menulis
-- audit_logs secara atomik di transaksi yang sama dengan mutasi (bukan
-- best-effort/fire-and-forget) -- gap sesungguhnya (lihat
-- docs/owner-control/ACTIVITY_AUDIT_COVERAGE_MATRIX.md, baris "KPI Salesman":
-- partial) hanya kolom kanonis Gate 1D-A (actor_type, event_category, module,
-- source, outcome) belum diisi.
--
-- Migration ini CREATE OR REPLACE fungsi yang SAMA dengan signature IDENTIK --
-- HANYA menambah kolom pada INSERT INTO audit_logs yang sudah ada, dan
-- menambah satu variabel v_actor_role untuk menangkap role AKTUAL actor
-- (owner/manager/super_admin -- ketiganya berwenang untuk RPC ini, berbeda
-- dari salesman activation yang hanya owner) supaya actor_type mencerminkan
-- role sesungguhnya, bukan nilai hardcoded. Predikat otorisasi (WHERE ...
-- r.name IN (...)) TIDAK berubah -- hanya SELECT target dari EXISTS(...)
-- menjadi SELECT r.name ... LIMIT 1 dengan urutan prioritas deterministik
-- untuk kasus (jarang/tidak mungkin di data existing) satu user punya lebih
-- dari satu role yang memenuhi syarat.
--
-- `action` existing (sales_kpi.foundation_initialized, sales_kpi.period_created,
-- sales_kpi.period_status_changed, sales_kpi.target_created/target_revised)
-- SENGAJA TIDAK diganti nama -- konsisten dengan prinsip 20260819000001 (tidak
-- menggandakan/mengubah makna kolom existing) dan 20260820000001 (retrofit
-- kolom kanonis, bukan taksonomi action baru). event_category='audit' (semua
-- ini perubahan data KPI/target, bukan activity/security), module='sales_kpi',
-- source='rpc' (writer SECURITY DEFINER, bukan app-layer), outcome='success'
-- (semua cabang no-op/forbidden/invalid RETURN QUERY sebelum baris INSERT ini
-- -- tidak ada audit palsu untuk no-op, tidak berubah dari sebelumnya).
--
-- set_sales_kpi_targets_calibrated (20260806000001) TIDAK disentuh -- fungsi
-- itu mengomposisi dua panggilan set_sales_kpi_target di bawah dalam
-- transaksi yang sama, jadi otomatis mewarisi kolom kanonis baru tanpa
-- duplikasi INSERT.
--
-- create_sales_call_task/record_sales_call/link_sales_order_call/
-- reverse_sales_call (20260805000001, domain achievement/call, bukan
-- configuration/target) TIDAK termasuk scope K1 -- lihat instruksi audit
-- Kelompok 1 (K1 hanya configuration & period target); tetap partial,
-- direncanakan untuk gate lain.
--
-- Manual achievement override: TIDAK ADA di codebase ini (ditegakkan
-- struktural -- sales_kpi_achievement_events append-only via trigger
-- trg_skae_append_only) -- event kpi.achievement_overridden SENGAJA TIDAK
-- dibuat, sesuai instruksi "jangan membuat event palsu untuk capability yang
-- belum ada".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. initialize_sales_kpi_foundation
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
        'codes', jsonb_build_array('CALL','EFFECTIVE_CALL'),
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
        AND d.code IN ('CALL','EFFECTIVE_CALL')
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. create_sales_kpi_period
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_sales_kpi_period(
  p_company_id UUID,
  p_actor_id UUID,
  p_name TEXT,
  p_start_date DATE,
  p_end_date DATE,
  p_working_days INTEGER
)
RETURNS TABLE(result_outcome TEXT, result_period_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_period_id UUID;
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
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) < 3 THEN
    RETURN QUERY SELECT 'invalid_name'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_start_date IS NULL OR p_end_date IS NULL OR p_start_date > p_end_date THEN
    RETURN QUERY SELECT 'invalid_date_range'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_working_days IS NULL OR p_working_days <= 0
     OR p_working_days > (p_end_date - p_start_date + 1) THEN
    RETURN QUERY SELECT 'invalid_working_days'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::TEXT || ':sales-kpi-period', 1));

  IF EXISTS (
    SELECT 1
    FROM public.sales_kpi_periods p
    WHERE p.company_id = p_company_id
      AND daterange(p.start_date, p.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) THEN
    RETURN QUERY SELECT 'overlapping_period'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.sales_kpi_periods (
    company_id, name, start_date, end_date, working_days, status, created_by
  ) VALUES (
    p_company_id, trim(p_name), p_start_date, p_end_date, p_working_days, 'DRAFT', p_actor_id
  )
  RETURNING id INTO v_period_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id,
    p_actor_id,
    'sales_kpi.period_created',
    'sales_kpi_periods',
    v_period_id,
    jsonb_build_object(
      'name', trim(p_name),
      'start_date', p_start_date,
      'end_date', p_end_date,
      'working_days', p_working_days,
      'status', 'DRAFT'
    ),
    v_actor_role,
    'audit',
    'sales_kpi',
    'rpc',
    'success'
  );

  RETURN QUERY SELECT 'created'::TEXT, v_period_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. set_sales_kpi_period_status
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_sales_kpi_period_status(
  p_company_id UUID,
  p_actor_id UUID,
  p_period_id UUID,
  p_next_status TEXT
)
RETURNS TABLE(result_outcome TEXT, result_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_current_status TEXT;
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
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT p.status
  INTO v_current_status
  FROM public.sales_kpi_periods p
  WHERE p.id = p_period_id AND p.company_id = p_company_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF p_next_status = v_current_status THEN
    RETURN QUERY SELECT 'already_status'::TEXT, v_current_status;
    RETURN;
  END IF;

  IF NOT (
    (v_current_status = 'DRAFT' AND p_next_status = 'ACTIVE') OR
    (v_current_status = 'ACTIVE' AND p_next_status = 'LOCKED')
  ) THEN
    RETURN QUERY SELECT 'invalid_transition'::TEXT, v_current_status;
    RETURN;
  END IF;

  UPDATE public.sales_kpi_periods
  SET status = p_next_status,
      activated_by = CASE WHEN p_next_status = 'ACTIVE' THEN p_actor_id ELSE activated_by END,
      activated_at = CASE WHEN p_next_status = 'ACTIVE' THEN NOW() ELSE activated_at END,
      locked_by = CASE WHEN p_next_status = 'LOCKED' THEN p_actor_id ELSE locked_by END,
      locked_at = CASE WHEN p_next_status = 'LOCKED' THEN NOW() ELSE locked_at END
  WHERE id = p_period_id AND company_id = p_company_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id,
    p_actor_id,
    'sales_kpi.period_status_changed',
    'sales_kpi_periods',
    p_period_id,
    jsonb_build_object('status', v_current_status),
    jsonb_build_object('status', p_next_status),
    v_actor_role,
    'audit',
    'sales_kpi',
    'rpc',
    'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT, p_next_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. set_sales_kpi_target -- CREATE OR REPLACE berbasis body LIVE
--    (20260806000001: target_value >= 0), bukan body asal 20260804000001
--    yang sudah di-superseded.
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

  IF p_kpi_code IS NULL OR p_kpi_code NOT IN ('CALL','EFFECTIVE_CALL') THEN
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

-- ---------------------------------------------------------------------------
-- 5. Grants (re-issued, defense-in-depth -- signature identik, tidak berubah
--    dari 20260804000001/20260806000001).
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.initialize_sales_kpi_foundation(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_sales_kpi_period(UUID, UUID, TEXT, DATE, DATE, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_sales_kpi_period_status(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_sales_kpi_target(UUID, UUID, UUID, UUID, TEXT, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.initialize_sales_kpi_foundation(UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.create_sales_kpi_period(UUID, UUID, TEXT, DATE, DATE, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_sales_kpi_period_status(UUID, UUID, UUID, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_sales_kpi_target(UUID, UUID, UUID, UUID, TEXT, INTEGER, TEXT)
  TO service_role;
