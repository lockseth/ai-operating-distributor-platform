-- =============================================================================
-- Sales KPI Owner Setup & Target Calibration
--
-- Dua perubahan:
--
-- 1. Relaksasi target_value dari (> 0) menjadi (>= 0). Instruksi phase ini
--    eksplisit meminta "target berupa bilangan bulat non-negatif" -- EC=0
--    sah untuk salesman baru/toko yang belum pernah menghasilkan order
--    confirmed. Ini BUKAN membuka kembali keputusan KPI yang sudah LOCK
--    (KPI aktif tetap hanya CALL & EFFECTIVE_CALL, tidak ada KPI baru) --
--    hanya melonggarkan batas bawah nilai target. Migration LAMA
--    (20260804000001) TIDAK diedit -- constraint & function di-replace
--    lewat migration BARU ini (pola forward-fix minimal-diff yang sama
--    dipakai 20260803000001 dan 20260726000001 pada gate sebelumnya).
--
-- 2. RPC baru set_sales_kpi_targets_calibrated: mengatur target CALL dan
--    EFFECTIVE_CALL SEKALIGUS dalam satu transaksi dengan aturan silang
--    baru "target EC tidak boleh melebihi target Call". Desain KOMPOSISI --
--    memanggil public.set_sales_kpi_target(...) yang sudah ada dua kali
--    setelah validasi silang lolos, supaya seluruh validasi existing
--    (actor role, period status, salesperson eligibility, versioning,
--    idempotency "unchanged", audit log) tetap berlaku tanpa disalin ulang.
-- =============================================================================

ALTER TABLE public.sales_kpi_targets
  DROP CONSTRAINT sales_kpi_targets_target_value_check;

ALTER TABLE public.sales_kpi_targets
  ADD CONSTRAINT sales_kpi_targets_target_value_check
  CHECK (target_value >= 0);

-- ---------------------------------------------------------------------------
-- set_sales_kpi_target: salinan PERSIS dari 20260804000001, satu-satunya
-- perubahan adalah baris validasi target_value (<=0 menjadi <0). Diverifikasi
-- lewat diff terhadap migration asal -- lihat catatan di bawah fungsi.
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
  v_actor_allowed BOOLEAN;
  v_salesperson_allowed BOOLEAN;
  v_period_status TEXT;
  v_definition_id UUID;
  v_current_id UUID;
  v_current_value INTEGER;
  v_current_version INTEGER;
  v_new_id UUID;
  v_new_version INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name IN ('owner','manager','super_admin')
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_kpi_code IS NULL OR p_kpi_code NOT IN ('CALL','EFFECTIVE_CALL') THEN
    RETURN QUERY SELECT 'unsupported_kpi'::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  -- FIX (20260806000001): batas bawah dilonggarkan dari <=0 menjadi <0 --
  -- target 0 kini sah (non-negatif), bukan hanya bilangan bulat positif.
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
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
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
    )
  );

  RETURN QUERY SELECT
    CASE WHEN v_current_id IS NULL THEN 'created' ELSE 'updated' END::TEXT,
    v_new_id,
    v_new_version;
END;
$$;

-- ---------------------------------------------------------------------------
-- set_sales_kpi_targets_calibrated: RPC baru. Mengatur CALL+EC sekaligus,
-- menegakkan EC<=Call, lewat komposisi dua panggilan set_sales_kpi_target.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_sales_kpi_targets_calibrated(
  p_company_id UUID,
  p_actor_id UUID,
  p_period_id UUID,
  p_salesperson_id UUID,
  p_call_target INTEGER,
  p_ec_target INTEGER,
  p_change_reason TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  call_outcome TEXT,
  call_target_id UUID,
  call_version INTEGER,
  ec_outcome TEXT,
  ec_target_id UUID,
  ec_version INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_call_row RECORD;
  v_ec_row RECORD;
BEGIN
  -- Actor check di sini SEBELUM validasi EC<=Call supaya caller yang tidak
  -- berwenang tidak bisa memakai pesan error validasi untuk enumerasi state.
  -- set_sales_kpi_target tetap memeriksa ulang actor secara independen di
  -- bawah -- defense in depth, pola yang sama dipakai di seluruh modul ini.
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name IN ('owner','manager','super_admin')
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT, NULL::UUID, NULL::INTEGER, NULL::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_call_target IS NULL OR p_call_target < 0 THEN
    RETURN QUERY SELECT 'invalid_call_target'::TEXT, NULL::TEXT, NULL::UUID, NULL::INTEGER, NULL::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_ec_target IS NULL OR p_ec_target < 0 THEN
    RETURN QUERY SELECT 'invalid_ec_target'::TEXT, NULL::TEXT, NULL::UUID, NULL::INTEGER, NULL::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  IF p_ec_target > p_call_target THEN
    RETURN QUERY SELECT 'ec_exceeds_call'::TEXT, NULL::TEXT, NULL::UUID, NULL::INTEGER, NULL::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  -- Serialize seluruh pasangan CALL+EC untuk salesperson+periode ini supaya
  -- dua submit bersamaan (mis. double-click Simpan) tidak saling balapan.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::TEXT || ':' || p_period_id::TEXT || ':' ||
    p_salesperson_id::TEXT || ':targets-calibrated',
    1
  ));

  SELECT * INTO v_call_row
  FROM public.set_sales_kpi_target(
    p_company_id, p_actor_id, p_period_id, p_salesperson_id, 'CALL', p_call_target, p_change_reason
  );

  IF v_call_row.result_outcome NOT IN ('created','updated','unchanged') THEN
    RETURN QUERY SELECT
      v_call_row.result_outcome, v_call_row.result_outcome, NULL::UUID, NULL::INTEGER,
      NULL::TEXT, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  SELECT * INTO v_ec_row
  FROM public.set_sales_kpi_target(
    p_company_id, p_actor_id, p_period_id, p_salesperson_id, 'EFFECTIVE_CALL', p_ec_target, p_change_reason
  );

  IF v_ec_row.result_outcome NOT IN ('created','updated','unchanged') THEN
    RETURN QUERY SELECT
      v_ec_row.result_outcome, v_call_row.result_outcome, v_call_row.result_target_id, v_call_row.result_version,
      v_ec_row.result_outcome, NULL::UUID, NULL::INTEGER;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'saved'::TEXT,
    v_call_row.result_outcome, v_call_row.result_target_id, v_call_row.result_version,
    v_ec_row.result_outcome, v_ec_row.result_target_id, v_ec_row.result_version;
END;
$$;

REVOKE ALL ON FUNCTION public.set_sales_kpi_targets_calibrated(UUID, UUID, UUID, UUID, INTEGER, INTEGER, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_sales_kpi_targets_calibrated(UUID, UUID, UUID, UUID, INTEGER, INTEGER, TEXT)
  TO service_role;
