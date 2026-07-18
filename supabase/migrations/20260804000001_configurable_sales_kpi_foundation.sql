-- =============================================================================
-- Configurable Sales KPI Foundation
--
-- Waluyo v1 contract (18 Juli 2026):
--   * active KPI hanya CALL dan EFFECTIVE_CALL;
--   * EFFECTIVE_CALL = Call valid yang menghasilkan Sales Order confirmed
--     dengan order_source = FIELD_VISIT;
--   * AR/Collection bukan KPI. Penagihan adalah visit-task/regulasi terpisah;
--   * phase ini menyimpan definisi, periode, dan target versioned. Belum ada
--     achievement measurement atau weighted/composite score.
--
-- Security:
--   * semua tabel company-scoped + RLS;
--   * authenticated hanya SELECT sesuai scope;
--   * mutation hanya lewat RPC service_role;
--   * RPC tetap memverifikasi actor, tenant, role, dan state (defence in depth);
--   * perubahan target tidak overwrite history: versi lama disupersede.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission catalog. Mutation tetap lewat server action + service_role RPC.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('sales_kpi.view',   'sales_kpi', 'view',   'View sales KPI definitions, periods, and scoped targets'),
  ('sales_kpi.manage', 'sales_kpi', 'manage', 'Configure sales KPI periods and targets')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.is_system_role = TRUE
  AND (
    (r.name IN ('owner','manager','super_admin') AND p.name IN ('sales_kpi.view','sales_kpi.manage'))
    OR (r.name = 'sales' AND p.name = 'sales_kpi.view')
  )
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tenant KPI definitions. Rows are versioned rather than overwritten.
-- Initializer below creates exactly CALL and EFFECTIVE_CALL per tenant.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_kpi_definitions (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  code                VARCHAR(50)  NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name                VARCHAR(120) NOT NULL,
  description         TEXT         NOT NULL,
  unit                VARCHAR(20)  NOT NULL CHECK (unit IN ('COUNT')),
  measurement_source  VARCHAR(50)  NOT NULL CHECK (measurement_source IN (
                        'VALID_FIELD_VISIT', 'CONFIRMED_FIELD_VISIT_ORDER'
                      )),
  version             INTEGER      NOT NULL DEFAULT 1 CHECK (version > 0),
  effective_from      DATE         NOT NULL DEFAULT CURRENT_DATE,
  superseded_at       TIMESTAMPTZ,
  created_by          UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code, version)
);

CREATE UNIQUE INDEX idx_sales_kpi_definitions_current
  ON public.sales_kpi_definitions (company_id, code)
  WHERE superseded_at IS NULL;

CREATE INDEX idx_sales_kpi_definitions_company
  ON public.sales_kpi_definitions (company_id, code, version DESC);

COMMENT ON TABLE public.sales_kpi_definitions IS
  'Versioned tenant sales KPI catalog. Waluyo v1 initializer creates only CALL and EFFECTIVE_CALL; AR is deliberately excluded.';

-- ---------------------------------------------------------------------------
-- KPI periods. Status transitions are forward-only: DRAFT -> ACTIVE -> LOCKED.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_kpi_periods (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name          VARCHAR(120) NOT NULL,
  start_date    DATE         NOT NULL,
  end_date      DATE         NOT NULL,
  working_days  INTEGER      NOT NULL CHECK (working_days > 0),
  status        VARCHAR(20)  NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT','ACTIVE','LOCKED')),
  created_by    UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  activated_by  UUID         REFERENCES public.users (id) ON DELETE RESTRICT,
  activated_at  TIMESTAMPTZ,
  locked_by     UUID         REFERENCES public.users (id) ON DELETE RESTRICT,
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sales_kpi_period_dates CHECK (start_date <= end_date),
  CONSTRAINT chk_sales_kpi_period_working_days CHECK (working_days <= (end_date - start_date + 1)),
  CONSTRAINT chk_sales_kpi_period_activation_pair CHECK (
    (activated_by IS NULL AND activated_at IS NULL) OR
    (activated_by IS NOT NULL AND activated_at IS NOT NULL)
  ),
  CONSTRAINT chk_sales_kpi_period_lock_pair CHECK (
    (locked_by IS NULL AND locked_at IS NULL) OR
    (locked_by IS NOT NULL AND locked_at IS NOT NULL)
  ),
  UNIQUE (company_id, start_date, end_date)
);

CREATE INDEX idx_sales_kpi_periods_company
  ON public.sales_kpi_periods (company_id, start_date DESC, end_date DESC);

CREATE TRIGGER trg_sales_kpi_periods_updated_at
  BEFORE UPDATE ON public.sales_kpi_periods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.sales_kpi_periods IS
  'Tenant KPI periods with forward-only lifecycle DRAFT -> ACTIVE -> LOCKED.';

-- ---------------------------------------------------------------------------
-- Versioned targets. Current row has status ACTIVE and superseded_at NULL.
-- A change creates a new row and links previous_target_id.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_kpi_targets (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  period_id           UUID          NOT NULL REFERENCES public.sales_kpi_periods (id) ON DELETE CASCADE,
  salesperson_id      UUID          NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  kpi_definition_id   UUID          NOT NULL REFERENCES public.sales_kpi_definitions (id) ON DELETE RESTRICT,
  target_value        INTEGER       NOT NULL CHECK (target_value > 0),
  version             INTEGER       NOT NULL CHECK (version > 0),
  status              VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUPERSEDED')),
  previous_target_id  UUID          REFERENCES public.sales_kpi_targets (id) ON DELETE RESTRICT,
  change_reason       TEXT          NOT NULL CHECK (length(trim(change_reason)) >= 3),
  created_by          UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  superseded_at       TIMESTAMPTZ,
  CONSTRAINT chk_sales_kpi_target_status_pair CHECK (
    (status = 'ACTIVE' AND superseded_at IS NULL) OR
    (status = 'SUPERSEDED' AND superseded_at IS NOT NULL)
  ),
  UNIQUE (company_id, period_id, salesperson_id, kpi_definition_id, version)
);

CREATE UNIQUE INDEX idx_sales_kpi_targets_current
  ON public.sales_kpi_targets (company_id, period_id, salesperson_id, kpi_definition_id)
  WHERE status = 'ACTIVE';

CREATE INDEX idx_sales_kpi_targets_salesperson
  ON public.sales_kpi_targets (company_id, salesperson_id, period_id);

CREATE INDEX idx_sales_kpi_targets_period
  ON public.sales_kpi_targets (company_id, period_id, status);

COMMENT ON TABLE public.sales_kpi_targets IS
  'Versioned target per tenant+period+salesman+KPI. Achievement measurements are intentionally outside this foundation phase.';

-- ---------------------------------------------------------------------------
-- RLS: manager roles see tenant configuration; Salesman sees definitions,
-- periods, and only their own targets.
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_kpi_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_kpi_periods     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_kpi_targets     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_kpi_definitions_select" ON public.sales_kpi_definitions
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','sales','super_admin'])
  );

CREATE POLICY "sales_kpi_periods_select" ON public.sales_kpi_periods
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','sales','super_admin'])
  );

CREATE POLICY "sales_kpi_targets_select" ON public.sales_kpi_targets
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','super_admin'])
    )
  );

REVOKE ALL ON TABLE public.sales_kpi_definitions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sales_kpi_periods     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sales_kpi_targets     FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.sales_kpi_definitions TO authenticated;
GRANT SELECT ON TABLE public.sales_kpi_periods     TO authenticated;
GRANT SELECT ON TABLE public.sales_kpi_targets     TO authenticated;

-- ---------------------------------------------------------------------------
-- Initialize per-tenant Waluyo v1 foundation. Idempotent and never creates
-- AR/COLLECTION/OMZET/weighted KPI definitions.
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
  v_actor_allowed BOOLEAN;
  v_inserted INTEGER := 0;
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
      company_id, user_id, action, entity_type, entity_id, new_data
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
      )
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
-- Create a non-overlapping KPI period in DRAFT state.
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
  v_actor_allowed BOOLEAN;
  v_period_id UUID;
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
    company_id, user_id, action, entity_type, entity_id, new_data
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
    )
  );

  RETURN QUERY SELECT 'created'::TEXT, v_period_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Forward-only period status transition. LOCKED is terminal.
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
  v_actor_allowed BOOLEAN;
  v_current_status TEXT;
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
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id,
    p_actor_id,
    'sales_kpi.period_status_changed',
    'sales_kpi_periods',
    p_period_id,
    jsonb_build_object('status', v_current_status),
    jsonb_build_object('status', p_next_status)
  );

  RETURN QUERY SELECT 'updated'::TEXT, p_next_status;
END;
$$;

-- ---------------------------------------------------------------------------
-- Set/version one target. Only CALL and EFFECTIVE_CALL are supported in
-- Waluyo v1. A locked period rejects all changes.
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

  IF p_target_value IS NULL OR p_target_value <= 0 THEN
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
-- Routine exposure hardening. Browser/authenticated cannot forge company_id
-- or actor_id; server action must authenticate first, then use admin client.
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
