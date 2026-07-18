-- =============================================================================
-- Salesman Daily Session -- fondasi lifecycle harian Waluyo Daily Operating
-- Loop (Mulai Hari -> ... -> Tutup Hari).
--
-- NOT_STARTED TIDAK dimodelkan sebagai baris -- mengikuti konvensi yang sudah
-- ada di codebase ini (sales_calls, sales_call_tasks: "belum ada baris" =
-- "belum terjadi"). Baris hanya lahir lewat start_daily_session. Ini membuat
-- uniqueness (company_id, salesman_id, business_date) trivial dan cek
-- "apakah hari ini sudah dimulai" jadi satu SELECT sederhana.
--
-- Koreksi (jika Founder salah tutup hari, dsb) memakai reopen_daily_session
-- (manager-only) yang mengubah status kembali ke ACTIVE dan menulis
-- audit_logs -- BUKAN reversal-row bergaya sales_kpi_achievement_events.
-- Session adalah container operasional satu-hari, bukan ledger KPI yang
-- dijumlahkan sebagai numerator -- tidak ada risiko double-counting dari
-- koreksi status, sehingga reversal-row terpisah adalah over-engineering di
-- sini. audit_logs sendiri sudah immutable (tidak pernah di-UPDATE di
-- seluruh codebase), sehingga jejak siapa-menutup-kapan-kenapa tetap utuh.
--
-- Business date: DATE murni disuplai eksplisit oleh caller (app layer
-- memakai businessDateJakarta() dari lib/n8n-automation/timezone.ts) --
-- sama seperti sales_calls.call_date, TIDAK ada konversi TZ implisit di DB.
-- =============================================================================

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('daily_session.manage_own', 'daily_session', 'manage_own', 'Start/close own daily operating session (Waluyo Daily Loop)')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.is_system_role = TRUE
  AND p.name = 'daily_session.manage_own'
  AND r.name IN ('owner','manager','super_admin','sales')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- salesman_daily_sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.salesman_daily_sessions (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  salesman_id       UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  business_date     DATE         NOT NULL,
  status            VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_by        UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  closed_at         TIMESTAMPTZ,
  closed_by         UUID         REFERENCES public.users (id) ON DELETE RESTRICT,
  close_summary     JSONB,
  idempotency_key   TEXT         NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sds_close_pair CHECK (
    (status = 'ACTIVE' AND closed_at IS NULL AND closed_by IS NULL) OR
    (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
  ),
  UNIQUE (company_id, salesman_id, business_date),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_sds_salesman_lookup
  ON public.salesman_daily_sessions (company_id, salesman_id, business_date);

COMMENT ON TABLE public.salesman_daily_sessions IS
  'Lifecycle harian salesman (Mulai Hari/Tutup Hari). NOT_STARTED = tidak ada baris. Kolom fakta append-only (trg_sds_fact_immutable); hanya status/closed_*/close_summary boleh berubah, lewat close_daily_session/reopen_daily_session.';

ALTER TABLE public.salesman_daily_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salesman_daily_sessions_select" ON public.salesman_daily_sessions
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      salesman_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','super_admin'])
    )
  );

REVOKE ALL ON TABLE public.salesman_daily_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.salesman_daily_sessions TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_sds_fact_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id           IS DISTINCT FROM OLD.company_id
     OR NEW.salesman_id       IS DISTINCT FROM OLD.salesman_id
     OR NEW.business_date     IS DISTINCT FROM OLD.business_date
     OR NEW.started_at        IS DISTINCT FROM OLD.started_at
     OR NEW.started_by        IS DISTINCT FROM OLD.started_by
     OR NEW.idempotency_key   IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'salesman_daily_sessions: kolom fakta bersifat append-only, tidak boleh diubah (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sds_fact_immutable
  BEFORE UPDATE ON public.salesman_daily_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sds_fact_immutable();

CREATE OR REPLACE FUNCTION public.forbid_sds_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'salesman_daily_sessions: DELETE dilarang (id=%)', OLD.id;
END;
$$;

CREATE TRIGGER trg_sds_forbid_delete
  BEFORE DELETE ON public.salesman_daily_sessions
  FOR EACH ROW EXECUTE FUNCTION public.forbid_sds_delete();

-- ---------------------------------------------------------------------------
-- RPC: start_daily_session. Actor = salesman sendiri ATAU owner/manager/
-- super_admin. Satu session ACTIVE/CLOSED per salesman per business_date --
-- ditegakkan lewat UNIQUE (company_id, salesman_id, business_date).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_daily_session(
  p_company_id UUID,
  p_actor_id UUID,
  p_salesman_id UUID,
  p_business_date DATE,
  p_idempotency_key TEXT
)
RETURNS TABLE(result_outcome TEXT, result_session_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_salesman_ok BOOLEAN;
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
      AND (u.id = p_salesman_id OR r.name IN ('owner','manager','super_admin'))
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_business_date IS NULL THEN
    RETURN QUERY SELECT 'invalid_date'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN QUERY SELECT 'idempotency_key_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_salesman_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'sales'
  ) INTO v_salesman_ok;

  IF NOT v_salesman_ok THEN
    RETURN QUERY SELECT 'salesperson_not_eligible'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::TEXT || ':daily_session:' || p_salesman_id::TEXT || ':' || p_business_date::TEXT,
    1
  ));

  SELECT id INTO v_existing_id
  FROM public.salesman_daily_sessions
  WHERE company_id = p_company_id AND salesman_id = p_salesman_id AND business_date = p_business_date;

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_started'::TEXT, v_existing_id;
    RETURN;
  END IF;

  INSERT INTO public.salesman_daily_sessions (
    company_id, salesman_id, business_date, started_by, idempotency_key
  ) VALUES (
    p_company_id, p_salesman_id, p_business_date, p_actor_id, trim(p_idempotency_key)
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'daily_session.started', 'salesman_daily_sessions', v_new_id,
    jsonb_build_object('salesman_id', p_salesman_id, 'business_date', p_business_date)
  );

  RETURN QUERY SELECT 'started'::TEXT, v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: close_daily_session. Actor = salesman sendiri ATAU owner/manager/
-- super_admin. Blocker "masih ada pekerjaan terbuka" ditambahkan Phase 7
-- (CREATE OR REPLACE FUNCTION di migration berikutnya) -- versi ini murni
-- menutup session, idempotent terhadap close ganda.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.close_daily_session(
  p_company_id UUID,
  p_actor_id UUID,
  p_session_id UUID,
  p_close_summary JSONB DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session RECORD;
  v_actor_allowed BOOLEAN;
BEGIN
  SELECT id, company_id, salesman_id, status
  INTO v_session
  FROM public.salesman_daily_sessions
  WHERE id = p_session_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    RETURN QUERY SELECT 'session_not_found'::TEXT;
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
      AND (u.id = v_session.salesman_id OR r.name IN ('owner','manager','super_admin'))
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF v_session.status = 'CLOSED' THEN
    RETURN QUERY SELECT 'already_closed'::TEXT;
    RETURN;
  END IF;

  UPDATE public.salesman_daily_sessions
  SET status = 'CLOSED', closed_at = NOW(), closed_by = p_actor_id, close_summary = p_close_summary
  WHERE id = p_session_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'daily_session.closed', 'salesman_daily_sessions', p_session_id,
    jsonb_build_object('status', 'ACTIVE'),
    jsonb_build_object('status', 'CLOSED')
  );

  RETURN QUERY SELECT 'closed'::TEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: reopen_daily_session. Manager-only. Koreksi append-only lewat
-- audit_logs (bukan reversal-row) -- lihat catatan di kepala file.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reopen_daily_session(
  p_company_id UUID,
  p_actor_id UUID,
  p_session_id UUID,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session RECORD;
  v_actor_allowed BOOLEAN;
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
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RETURN QUERY SELECT 'reason_required'::TEXT;
    RETURN;
  END IF;

  SELECT id, company_id, status
  INTO v_session
  FROM public.salesman_daily_sessions
  WHERE id = p_session_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    RETURN QUERY SELECT 'session_not_found'::TEXT;
    RETURN;
  END IF;

  IF v_session.status = 'ACTIVE' THEN
    RETURN QUERY SELECT 'already_active'::TEXT;
    RETURN;
  END IF;

  UPDATE public.salesman_daily_sessions
  SET status = 'ACTIVE', closed_at = NULL, closed_by = NULL, close_summary = NULL
  WHERE id = p_session_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'daily_session.reopened', 'salesman_daily_sessions', p_session_id,
    jsonb_build_object('status', 'CLOSED'),
    jsonb_build_object('status', 'ACTIVE', 'reason', trim(p_reason))
  );

  RETURN QUERY SELECT 'reopened'::TEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Routine exposure hardening.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.start_daily_session(UUID, UUID, UUID, DATE, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_daily_session(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reopen_daily_session(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_daily_session(UUID, UUID, UUID, DATE, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.close_daily_session(UUID, UUID, UUID, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reopen_daily_session(UUID, UUID, UUID, TEXT)
  TO service_role;
