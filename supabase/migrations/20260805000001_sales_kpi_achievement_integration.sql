-- =============================================================================
-- Sales KPI Achievement Integration
--
-- Menyambungkan Configurable Sales KPI Foundation (20260804000001) ke data
-- operasional nyata. Achievement TIDAK PERNAH diinput/di-override manual --
-- hanya lahir dari lifecycle Call/Sales Order yang sah, lewat RPC
-- SECURITY DEFINER dan trigger DB, sesuai kontrak Waluyo v1:
--   * CALL      = kunjungan operasional valid Salesman ke toko
--                 assignment/coverage (atau approved exception).
--   * EFFECTIVE_CALL (EC) = Call valid yang terhubung ke Sales Order
--                 confirmed dengan order_source = FIELD_VISIT. Maksimal
--                 SATU EC aktif per Call, ditegakkan lewat idempotency key
--                 turunan deterministik dari call_id + partial unique index.
--
-- Arsitektur:
--   1. sales_call_tasks    -- referensi approval eksplisit untuk exception
--                              (REPEAT_VISIT / COVERAGE_EXCEPTION), dibuat
--                              manager, auditable, "one task = one call".
--   2. sales_calls          -- catatan operasional kunjungan (append-only
--                              untuk kolom fakta, mirip order_cancellation_
--                              disputes; hanya status/reversed_* yang boleh
--                              berubah, lewat RPC reverse_sales_call).
--   3. sales_kpi_achievement_events -- ledger append-only murni (TIDAK ADA
--                              UPDATE/DELETE sama sekali). Correction/
--                              reversal selalu baris BARU yang mereferensi
--                              event asal (reversal_of_event_id).
--   4. sales_orders.call_id -- linkage nullable, tenant/salesman/toko-safe
--                              (trigger konsistensi), immutable setelah
--                              ditautkan.
--
-- Kredit EC dan reversal EC dipasang sebagai trigger DB pada sales_orders
-- (bukan panggilan eksplisit dari TS) supaya BERLAKU UNTUK SEMUA jalur yang
-- pernah/akan mengubah status order (confirm di repository.ts, resolusi
-- dispute di order_cancellation_disputes RPC, koreksi admin) tanpa perlu
-- menyisipkan panggilan yang sama di banyak tempat dan tanpa mengubah kode
-- confirm()/dispute resolution yang sudah teruji. idempotency_key trigger
-- diturunkan dari call_id (BUKAN order_id) sehingga order kedua pada Call
-- yang sama otomatis ON CONFLICT DO NOTHING -- tidak pernah EC ganda.
--
-- Timezone/business-date: codebase TIDAK memiliki authoritative timezone
-- helper (diverifikasi eksplisit). call_date adalah DATE yang disuplai
-- eksplisit oleh caller (RPC/UI) -- pola yang SAMA seperti
-- sales_kpi_periods.start_date/end_date (DATE murni, tanpa konversi TZ
-- implisit). Ini menghindari mengarang aturan timezone baru.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Permission tambahan: merekam Call adalah tindakan operasional milik
-- Salesman sendiri, terpisah dari sales_kpi.manage (konfigurasi periode/
-- target). sales_kpi.view/manage yang sudah ada dipakai ulang untuk baca
-- projection dan untuk task/reversal (manager-only).
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('sales_kpi.record_call', 'sales_kpi', 'record_call', 'Record own field visit (Call) toward Sales KPI achievement')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.is_system_role = TRUE
  AND p.name = 'sales_kpi.record_call'
  AND r.name IN ('owner','manager','super_admin','sales')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- sales_call_tasks: referensi approval eksplisit untuk exception. Tanpa
-- baris di sini, RPC record_sales_call TIDAK PERNAH menerima override
-- coverage/duplikat-hari lewat boolean bebas -- harus menunjuk baris nyata,
-- auditable (approved_by/approved_at), company-scoped.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_call_tasks (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  salesperson_id  UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  customer_id     UUID         NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  task_type       VARCHAR(30)  NOT NULL CHECK (task_type IN ('REPEAT_VISIT', 'COVERAGE_EXCEPTION')),
  valid_date      DATE         NOT NULL,
  reason          TEXT         NOT NULL CHECK (length(trim(reason)) >= 3),
  status          VARCHAR(20)  NOT NULL DEFAULT 'APPROVED' CHECK (status IN ('APPROVED', 'REVOKED')),
  approved_by     UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  approved_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  revoked_by      UUID         REFERENCES public.users (id) ON DELETE RESTRICT,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sct_revoke_pair CHECK (
    (revoked_by IS NULL AND revoked_at IS NULL) OR
    (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX idx_sct_lookup
  ON public.sales_call_tasks (company_id, salesperson_id, customer_id, valid_date, task_type);

COMMENT ON TABLE public.sales_call_tasks IS
  'Approval eksplisit auditable untuk exception Call (repeat-visit hari sama, atau out-of-coverage). Satu task hanya bisa dipakai satu Call -- ditegakkan uq_sales_calls_one_per_task.';

ALTER TABLE public.sales_call_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_call_tasks_select" ON public.sales_call_tasks
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','super_admin'])
    )
  );

REVOKE ALL ON TABLE public.sales_call_tasks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sales_call_tasks TO authenticated;

-- ---------------------------------------------------------------------------
-- sales_calls: catatan operasional kunjungan. Kolom fakta append-only
-- (trigger di bawah); hanya status/reversed_by/reversed_at/reversal_reason
-- boleh berubah, lewat reverse_sales_call.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_calls (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  salesperson_id          UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  customer_id             UUID         NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  call_date               DATE         NOT NULL,
  occurred_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  outcome_notes           TEXT         NOT NULL CHECK (length(trim(outcome_notes)) >= 3),
  coverage_basis          VARCHAR(20)  NOT NULL CHECK (coverage_basis IN ('ASSIGNED', 'AREA', 'EXCEPTION')),
  authorization_task_id   UUID         REFERENCES public.sales_call_tasks (id) ON DELETE RESTRICT,
  idempotency_key         TEXT         NOT NULL,
  status                  VARCHAR(20)  NOT NULL DEFAULT 'VALID' CHECK (status IN ('VALID', 'REVERSED')),
  reversed_by             UUID         REFERENCES public.users (id) ON DELETE RESTRICT,
  reversed_at             TIMESTAMPTZ,
  reversal_reason         TEXT,
  created_by              UUID         NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_sales_calls_reversal_pair CHECK (
    (status = 'VALID' AND reversed_by IS NULL AND reversed_at IS NULL) OR
    (status = 'REVERSED' AND reversed_by IS NOT NULL AND reversed_at IS NOT NULL)
  ),
  UNIQUE (company_id, idempotency_key)
);

-- Satu Call valid per toko+salesman+hari operasional, KECUALI diberi
-- authorization_task_id (repeat-visit sah). Ditegakkan di database, bukan
-- hanya TypeScript.
CREATE UNIQUE INDEX uq_sales_calls_one_per_day
  ON public.sales_calls (company_id, salesperson_id, customer_id, call_date)
  WHERE status = 'VALID' AND authorization_task_id IS NULL;

-- Satu task exception hanya bisa dipakai untuk satu Call.
CREATE UNIQUE INDEX uq_sales_calls_one_per_task
  ON public.sales_calls (authorization_task_id)
  WHERE authorization_task_id IS NOT NULL;

CREATE INDEX idx_sales_calls_salesperson
  ON public.sales_calls (company_id, salesperson_id, call_date);

COMMENT ON TABLE public.sales_calls IS
  'Sumber operasional Call. Kolom fakta append-only (trg_sales_calls_fact_immutable); hanya status/reversed_* boleh berubah lewat reverse_sales_call.';

ALTER TABLE public.sales_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_calls_select" ON public.sales_calls
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','super_admin'])
    )
  );

REVOKE ALL ON TABLE public.sales_calls FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sales_calls TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_sales_calls_fact_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id             IS DISTINCT FROM OLD.company_id
     OR NEW.salesperson_id      IS DISTINCT FROM OLD.salesperson_id
     OR NEW.customer_id         IS DISTINCT FROM OLD.customer_id
     OR NEW.call_date           IS DISTINCT FROM OLD.call_date
     OR NEW.occurred_at         IS DISTINCT FROM OLD.occurred_at
     OR NEW.outcome_notes       IS DISTINCT FROM OLD.outcome_notes
     OR NEW.coverage_basis      IS DISTINCT FROM OLD.coverage_basis
     OR NEW.authorization_task_id IS DISTINCT FROM OLD.authorization_task_id
     OR NEW.idempotency_key     IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_by          IS DISTINCT FROM OLD.created_by
     OR NEW.created_at          IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'sales_calls: kolom fakta bersifat append-only, tidak boleh diubah (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_calls_fact_immutable
  BEFORE UPDATE ON public.sales_calls
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_calls_fact_immutable();

CREATE OR REPLACE FUNCTION public.forbid_sales_calls_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'sales_calls: DELETE dilarang, gunakan reverse_sales_call (id=%)', OLD.id;
END;
$$;

CREATE TRIGGER trg_sales_calls_forbid_delete
  BEFORE DELETE ON public.sales_calls
  FOR EACH ROW EXECUTE FUNCTION public.forbid_sales_calls_delete();

-- ---------------------------------------------------------------------------
-- sales_kpi_achievement_events: ledger append-only murni. TIDAK ADA UPDATE
-- ATAU DELETE sama sekali (trigger di bawah menolak keduanya tanpa
-- pengecualian). Correction/reversal selalu INSERT baris baru dengan
-- event_type='REVERSED' + reversal_of_event_id.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sales_kpi_achievement_events (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  salesperson_id        UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  kpi_code              VARCHAR(50)  NOT NULL CHECK (kpi_code IN ('CALL', 'EFFECTIVE_CALL')),
  event_type            VARCHAR(20)  NOT NULL CHECK (event_type IN ('CREDITED', 'REVERSED')),
  business_date         DATE         NOT NULL,
  source_type           VARCHAR(20)  NOT NULL CHECK (source_type IN ('SALES_CALL', 'SALES_ORDER')),
  source_id             UUID         NOT NULL,
  call_id               UUID         REFERENCES public.sales_calls (id) ON DELETE RESTRICT,
  order_id              UUID         REFERENCES public.sales_orders (id) ON DELETE RESTRICT,
  idempotency_key       TEXT         NOT NULL,
  reversal_of_event_id  UUID         REFERENCES public.sales_kpi_achievement_events (id) ON DELETE RESTRICT,
  reversal_reason       TEXT,
  actor_type             VARCHAR(10) NOT NULL CHECK (actor_type IN ('SYSTEM', 'USER')),
  actor_id               UUID        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_skae_call_kpi CHECK (kpi_code <> 'CALL' OR call_id IS NOT NULL),
  CONSTRAINT chk_skae_ec_kpi CHECK (
    kpi_code <> 'EFFECTIVE_CALL' OR (call_id IS NOT NULL AND order_id IS NOT NULL)
  ),
  CONSTRAINT chk_skae_reversal_pair CHECK (
    (event_type = 'CREDITED' AND reversal_of_event_id IS NULL AND reversal_reason IS NULL) OR
    (event_type = 'REVERSED' AND reversal_of_event_id IS NOT NULL AND reversal_reason IS NOT NULL)
  ),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_skae_projection
  ON public.sales_kpi_achievement_events (company_id, salesperson_id, kpi_code, business_date);

-- Maksimal SATU event CALL CREDITED per Call.
CREATE UNIQUE INDEX uq_skae_call_credited_once
  ON public.sales_kpi_achievement_events (call_id)
  WHERE kpi_code = 'CALL' AND event_type = 'CREDITED';

-- Invarian inti: maksimal SATU event EFFECTIVE_CALL CREDITED per Call --
-- order kedua dari Call yang sama tidak pernah menghasilkan EC kedua.
CREATE UNIQUE INDEX uq_skae_ec_credited_once
  ON public.sales_kpi_achievement_events (call_id)
  WHERE kpi_code = 'EFFECTIVE_CALL' AND event_type = 'CREDITED';

-- Maksimal satu reversal per event asal -- retry reversal tidak pernah ganda.
CREATE UNIQUE INDEX uq_skae_reversal_once
  ON public.sales_kpi_achievement_events (reversal_of_event_id)
  WHERE event_type = 'REVERSED';

COMMENT ON TABLE public.sales_kpi_achievement_events IS
  'Ledger append-only achievement CALL/EFFECTIVE_CALL. Tidak ada UPDATE/DELETE (trg_skae_append_only). Projection = SUM(CREDITED) - SUM(REVERSED) per business_date/periode. Tidak boleh diisi/diubah manual -- hanya lewat record_sales_call, reverse_sales_call, dan trigger sales_orders confirm/cancel.';

ALTER TABLE public.sales_kpi_achievement_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sales_kpi_achievement_events_select" ON public.sales_kpi_achievement_events
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      salesperson_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','super_admin'])
    )
  );

REVOKE ALL ON TABLE public.sales_kpi_achievement_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sales_kpi_achievement_events TO authenticated;

CREATE OR REPLACE FUNCTION public.enforce_achievement_events_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales_kpi_achievement_events: DELETE dilarang, ledger append-only (id=%)', OLD.id;
  END IF;
  RAISE EXCEPTION 'sales_kpi_achievement_events: UPDATE dilarang, ledger append-only (id=%). Gunakan event REVERSED baru.', OLD.id;
END;
$$;

CREATE TRIGGER trg_skae_append_only
  BEFORE UPDATE OR DELETE ON public.sales_kpi_achievement_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_achievement_events_append_only();

-- ---------------------------------------------------------------------------
-- sales_orders.call_id: linkage nullable, tenant-safe. Immutable setelah
-- ditautkan (tidak bisa dipakai untuk "klaim ulang" EC dari Call lain).
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS call_id UUID REFERENCES public.sales_calls (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_orders_call_id
  ON public.sales_orders (call_id)
  WHERE call_id IS NOT NULL;

COMMENT ON COLUMN public.sales_orders.call_id IS
  'Linkage opsional ke sales_calls -- TIDAK diwajibkan untuk remote order (order_source CUSTOMER_WHATSAPP/CUSTOMER_PHONE/REPEAT_ORDER/OTHER tetap sah tanpa call_id). Hanya order dengan call_id terisi DAN order_source=FIELD_VISIT yang bisa menghasilkan Effective Call saat confirmed. Immutable setelah diisi (trg_sales_orders_call_link_consistency).';

CREATE OR REPLACE FUNCTION public.enforce_sales_order_call_link_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_call RECORD;
BEGIN
  IF NEW.call_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.call_id IS NOT NULL AND NEW.call_id IS DISTINCT FROM OLD.call_id THEN
    RAISE EXCEPTION 'sales_orders.call_id tidak boleh diubah setelah ditautkan (order=%)', NEW.id;
  END IF;

  SELECT company_id, salesperson_id, customer_id, status
  INTO v_call
  FROM public.sales_calls
  WHERE id = NEW.call_id;

  IF v_call IS NULL THEN
    RAISE EXCEPTION 'call_id tidak ditemukan (order=%, call=%)', NEW.id, NEW.call_id;
  END IF;
  IF v_call.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'call_id lintas tenant tidak diizinkan (order=%, call=%)', NEW.id, NEW.call_id;
  END IF;
  IF v_call.customer_id IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'call_id toko tidak sesuai order (order=%, call=%)', NEW.id, NEW.call_id;
  END IF;
  IF NEW.sales_id IS DISTINCT FROM v_call.salesperson_id THEN
    RAISE EXCEPTION 'call_id salesman tidak sesuai order (order=%, call=%)', NEW.id, NEW.call_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_call_link_consistency
  BEFORE INSERT OR UPDATE OF call_id ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_order_call_link_consistency();

-- ---------------------------------------------------------------------------
-- Kredit EC otomatis. Fires setiap kali status ATAU call_id sales_orders
-- berubah (mencakup: order dikonfirmasi setelah ditautkan, ATAU ditautkan
-- setelah confirmed) -- WHEN clause hanya lolos ketika kombinasi akhir baris
-- adalah status='confirmed' DAN call_id terisi, sehingga aman dari urutan
-- operasi apa pun. Idempotent murni lewat ON CONFLICT pada idempotency_key
-- yang diturunkan dari call_id (bukan order_id) -- order kedua pada Call
-- yang sama otomatis tidak menghasilkan EC kedua.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.credit_effective_call_for_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_call RECORD;
BEGIN
  IF NEW.status <> 'confirmed' OR NEW.call_id IS NULL OR NEW.is_historical THEN
    RETURN NEW;
  END IF;
  IF NEW.order_source <> 'FIELD_VISIT' THEN
    RETURN NEW;
  END IF;

  SELECT id, company_id, salesperson_id, call_date, status
  INTO v_call
  FROM public.sales_calls
  WHERE id = NEW.call_id
  FOR UPDATE;

  IF v_call IS NULL OR v_call.status <> 'VALID' THEN
    RETURN NEW;
  END IF;
  IF v_call.company_id IS DISTINCT FROM NEW.company_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, call_id, order_id, idempotency_key, actor_type
  ) VALUES (
    NEW.company_id, v_call.salesperson_id, 'EFFECTIVE_CALL', 'CREDITED', v_call.call_date,
    'SALES_ORDER', NEW.id, v_call.id, NEW.id, 'ec:' || v_call.id::TEXT, 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_credit_ec
  AFTER INSERT OR UPDATE OF status, call_id ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.status = 'confirmed' AND NEW.call_id IS NOT NULL)
  EXECUTE FUNCTION public.credit_effective_call_for_order();

-- ---------------------------------------------------------------------------
-- Reversal EC otomatis saat order dinyatakan tidak sah (status -> cancelled)
-- lewat resolusi dispute (order_cancellation_disputes) ATAU jalur cancel
-- lain manapun -- satu-satunya kolom yang diperiksa adalah
-- sales_orders.status, sehingga tidak perlu menyentuh RPC dispute yang
-- sudah teruji. business_date reversal diwariskan dari event asal supaya
-- projection periode historis tetap benar meski reversal terjadi belakangan.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_effective_call_for_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event RECORD;
BEGIN
  IF NEW.status <> 'cancelled' OR OLD.status IS NOT DISTINCT FROM 'cancelled' THEN
    RETURN NEW;
  END IF;

  SELECT id, company_id, salesperson_id, business_date, call_id, order_id
  INTO v_event
  FROM public.sales_kpi_achievement_events
  WHERE order_id = NEW.id
    AND kpi_code = 'EFFECTIVE_CALL'
    AND event_type = 'CREDITED'
  LIMIT 1;

  IF v_event IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, call_id, order_id, idempotency_key,
    reversal_of_event_id, reversal_reason, actor_type
  ) VALUES (
    v_event.company_id, v_event.salesperson_id, 'EFFECTIVE_CALL', 'REVERSED', v_event.business_date,
    'SALES_ORDER', NEW.id, v_event.call_id, v_event.order_id, 'ec-reversal:' || v_event.id::TEXT,
    v_event.id, 'Order dinyatakan tidak sah melalui resolusi dispute/cancellation', 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_reverse_ec
  AFTER UPDATE OF status ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.reverse_effective_call_for_order();

-- ---------------------------------------------------------------------------
-- RPC: create_sales_call_task. Manager-only. Membuat referensi approval
-- exception yang eksplisit, auditable -- satu-satunya cara sah melewati
-- coverage/duplikat-hari selain assignment/area langsung.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_sales_call_task(
  p_company_id UUID,
  p_actor_id UUID,
  p_salesperson_id UUID,
  p_customer_id UUID,
  p_task_type TEXT,
  p_valid_date DATE,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT, result_task_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_salesperson_ok BOOLEAN;
  v_customer_ok BOOLEAN;
  v_task_id UUID;
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

  IF p_task_type IS NULL OR p_task_type NOT IN ('REPEAT_VISIT', 'COVERAGE_EXCEPTION') THEN
    RETURN QUERY SELECT 'invalid_task_type'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_valid_date IS NULL THEN
    RETURN QUERY SELECT 'invalid_date'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_reason IS NULL OR length(trim(p_reason)) < 3 THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::UUID;
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
  ) INTO v_salesperson_ok;

  IF NOT v_salesperson_ok THEN
    RETURN QUERY SELECT 'salesperson_not_eligible'::TEXT, NULL::UUID;
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

  INSERT INTO public.sales_call_tasks (
    company_id, salesperson_id, customer_id, task_type, valid_date, reason, approved_by
  ) VALUES (
    p_company_id, p_salesperson_id, p_customer_id, p_task_type, p_valid_date, trim(p_reason), p_actor_id
  )
  RETURNING id INTO v_task_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'sales_kpi.call_task_created', 'sales_call_tasks', v_task_id,
    jsonb_build_object(
      'salesperson_id', p_salesperson_id,
      'customer_id', p_customer_id,
      'task_type', p_task_type,
      'valid_date', p_valid_date,
      'reason', trim(p_reason)
    )
  );

  RETURN QUERY SELECT 'created'::TEXT, v_task_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: record_sales_call. Actor = Salesman sendiri ATAU manager. Menegakkan
-- seluruh CALL VALID rules di satu tempat (central domain service):
-- eligibility, coverage/assignment atau exception task, duplikat-hari,
-- idempotency -- lalu mengkredit CALL achievement dalam transaksi yang sama.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_sales_call(
  p_company_id UUID,
  p_actor_id UUID,
  p_salesperson_id UUID,
  p_customer_id UUID,
  p_call_date DATE,
  p_outcome_notes TEXT,
  p_idempotency_key TEXT,
  p_coverage_exception_task_id UUID DEFAULT NULL,
  p_repeat_visit_task_id UUID DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT, result_call_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_salesperson_ok BOOLEAN;
  v_customer RECORD;
  v_existing_id UUID;
  v_coverage_basis TEXT;
  v_authorization_task_id UUID := NULL;
  v_task RECORD;
  v_new_id UUID;
BEGIN
  IF p_coverage_exception_task_id IS NOT NULL AND p_repeat_visit_task_id IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID;
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
      AND (u.id = p_salesperson_id OR r.name IN ('owner','manager','super_admin'))
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_call_date IS NULL THEN
    RETURN QUERY SELECT 'invalid_date'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_outcome_notes IS NULL OR length(trim(p_outcome_notes)) < 3 THEN
    RETURN QUERY SELECT 'outcome_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RETURN QUERY SELECT 'idempotency_key_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_company_id::TEXT || ':call:' || p_salesperson_id::TEXT || ':' ||
    p_customer_id::TEXT || ':' || p_call_date::TEXT,
    1
  ));

  SELECT id INTO v_existing_id
  FROM public.sales_calls
  WHERE company_id = p_company_id AND idempotency_key = trim(p_idempotency_key);

  IF v_existing_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_recorded'::TEXT, v_existing_id;
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
  ) INTO v_salesperson_ok;

  IF NOT v_salesperson_ok THEN
    RETURN QUERY SELECT 'salesperson_not_eligible'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT id, area, assigned_sales_id, is_active
  INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id AND company_id = p_company_id;

  IF v_customer.id IS NULL OR NOT v_customer.is_active THEN
    RETURN QUERY SELECT 'customer_not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_customer.assigned_sales_id = p_salesperson_id THEN
    v_coverage_basis := 'ASSIGNED';
  ELSIF v_customer.area IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.salesman_coverage_areas sca
    WHERE sca.company_id = p_company_id AND sca.user_id = p_salesperson_id AND sca.area = v_customer.area
  ) THEN
    v_coverage_basis := 'AREA';
  ELSE
    v_coverage_basis := NULL;
  END IF;

  IF v_coverage_basis IS NULL THEN
    IF p_coverage_exception_task_id IS NULL THEN
      RETURN QUERY SELECT 'out_of_coverage'::TEXT, NULL::UUID;
      RETURN;
    END IF;

    SELECT * INTO v_task
    FROM public.sales_call_tasks
    WHERE id = p_coverage_exception_task_id
      AND company_id = p_company_id
      AND salesperson_id = p_salesperson_id
      AND customer_id = p_customer_id
      AND task_type = 'COVERAGE_EXCEPTION'
      AND status = 'APPROVED'
      AND valid_date = p_call_date
    FOR UPDATE;

    IF v_task.id IS NULL THEN
      RETURN QUERY SELECT 'invalid_authorization_task'::TEXT, NULL::UUID;
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.sales_calls WHERE authorization_task_id = v_task.id) THEN
      RETURN QUERY SELECT 'authorization_task_already_used'::TEXT, NULL::UUID;
      RETURN;
    END IF;

    v_coverage_basis := 'EXCEPTION';
    v_authorization_task_id := v_task.id;
  ELSIF p_repeat_visit_task_id IS NOT NULL THEN
    SELECT * INTO v_task
    FROM public.sales_call_tasks
    WHERE id = p_repeat_visit_task_id
      AND company_id = p_company_id
      AND salesperson_id = p_salesperson_id
      AND customer_id = p_customer_id
      AND task_type = 'REPEAT_VISIT'
      AND status = 'APPROVED'
      AND valid_date = p_call_date
    FOR UPDATE;

    IF v_task.id IS NULL THEN
      RETURN QUERY SELECT 'invalid_authorization_task'::TEXT, NULL::UUID;
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.sales_calls WHERE authorization_task_id = v_task.id) THEN
      RETURN QUERY SELECT 'authorization_task_already_used'::TEXT, NULL::UUID;
      RETURN;
    END IF;

    v_authorization_task_id := v_task.id;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.sales_calls
      WHERE company_id = p_company_id
        AND salesperson_id = p_salesperson_id
        AND customer_id = p_customer_id
        AND call_date = p_call_date
        AND status = 'VALID'
        AND authorization_task_id IS NULL
    ) THEN
      RETURN QUERY SELECT 'duplicate_same_day'::TEXT, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.sales_calls (
    company_id, salesperson_id, customer_id, call_date, outcome_notes,
    coverage_basis, authorization_task_id, idempotency_key, created_by
  ) VALUES (
    p_company_id, p_salesperson_id, p_customer_id, p_call_date, trim(p_outcome_notes),
    v_coverage_basis, v_authorization_task_id, trim(p_idempotency_key), p_actor_id
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, call_id, idempotency_key, actor_type, actor_id
  ) VALUES (
    p_company_id, p_salesperson_id, 'CALL', 'CREDITED', p_call_date,
    'SALES_CALL', v_new_id, v_new_id, 'call:' || v_new_id::TEXT, 'USER', p_actor_id
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'sales_kpi.call_recorded', 'sales_calls', v_new_id,
    jsonb_build_object(
      'salesperson_id', p_salesperson_id,
      'customer_id', p_customer_id,
      'call_date', p_call_date,
      'coverage_basis', v_coverage_basis,
      'authorization_task_id', v_authorization_task_id
    )
  );

  RETURN QUERY SELECT 'recorded'::TEXT, v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: link_sales_order_call. Menautkan order (draft ATAU sudah confirmed --
-- kredit EC tetap benar di kedua urutan, lihat trigger di atas) ke Call.
-- Tenant-safe, tidak mewajibkan remote order, tidak mengubah validitas order.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.link_sales_order_call(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_call_id UUID
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_order RECORD;
  v_call RECORD;
BEGIN
  SELECT id, company_id, customer_id, sales_id, call_id
  INTO v_order
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RETURN QUERY SELECT 'order_not_found'::TEXT;
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
      AND (u.id = v_order.sales_id OR r.name IN ('owner','manager','super_admin'))
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF v_order.call_id IS NOT NULL THEN
    RETURN QUERY SELECT 'already_linked'::TEXT;
    RETURN;
  END IF;

  SELECT id, company_id, salesperson_id, customer_id, status
  INTO v_call
  FROM public.sales_calls
  WHERE id = p_call_id AND company_id = p_company_id;

  IF v_call.id IS NULL THEN
    RETURN QUERY SELECT 'call_not_found'::TEXT;
    RETURN;
  END IF;
  IF v_call.status <> 'VALID' THEN
    RETURN QUERY SELECT 'call_not_valid'::TEXT;
    RETURN;
  END IF;
  IF v_call.customer_id IS DISTINCT FROM v_order.customer_id THEN
    RETURN QUERY SELECT 'customer_mismatch'::TEXT;
    RETURN;
  END IF;
  IF v_order.sales_id IS DISTINCT FROM v_call.salesperson_id THEN
    RETURN QUERY SELECT 'salesperson_mismatch'::TEXT;
    RETURN;
  END IF;

  UPDATE public.sales_orders SET call_id = p_call_id WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'sales_kpi.order_call_linked', 'sales_orders', p_order_id,
    jsonb_build_object('call_id', p_call_id)
  );

  RETURN QUERY SELECT 'linked'::TEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPC: reverse_sales_call. Manager-only. Membatalkan Call yang keliru/tidak
-- valid -- mengoreksi Call DAN (jika ada) EC turunannya sekaligus, append-only.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_sales_call(
  p_company_id UUID,
  p_actor_id UUID,
  p_call_id UUID,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_call RECORD;
  v_call_event RECORD;
  v_ec_event RECORD;
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
  INTO v_call
  FROM public.sales_calls
  WHERE id = p_call_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_call.id IS NULL THEN
    RETURN QUERY SELECT 'call_not_found'::TEXT;
    RETURN;
  END IF;
  IF v_call.status = 'REVERSED' THEN
    RETURN QUERY SELECT 'already_reversed'::TEXT;
    RETURN;
  END IF;

  UPDATE public.sales_calls
  SET status = 'REVERSED', reversed_by = p_actor_id, reversed_at = NOW(), reversal_reason = trim(p_reason)
  WHERE id = p_call_id;

  SELECT id, company_id, salesperson_id, business_date
  INTO v_call_event
  FROM public.sales_kpi_achievement_events
  WHERE call_id = p_call_id AND kpi_code = 'CALL' AND event_type = 'CREDITED';

  IF v_call_event.id IS NOT NULL THEN
    INSERT INTO public.sales_kpi_achievement_events (
      company_id, salesperson_id, kpi_code, event_type, business_date,
      source_type, source_id, call_id, idempotency_key, reversal_of_event_id, reversal_reason, actor_type, actor_id
    ) VALUES (
      v_call_event.company_id, v_call_event.salesperson_id, 'CALL', 'REVERSED', v_call_event.business_date,
      'SALES_CALL', p_call_id, p_call_id, 'call-reversal:' || v_call_event.id::TEXT,
      v_call_event.id, trim(p_reason), 'USER', p_actor_id
    )
    ON CONFLICT (company_id, idempotency_key) DO NOTHING;
  END IF;

  SELECT id, company_id, salesperson_id, business_date, order_id
  INTO v_ec_event
  FROM public.sales_kpi_achievement_events
  WHERE call_id = p_call_id AND kpi_code = 'EFFECTIVE_CALL' AND event_type = 'CREDITED';

  IF v_ec_event.id IS NOT NULL THEN
    INSERT INTO public.sales_kpi_achievement_events (
      company_id, salesperson_id, kpi_code, event_type, business_date,
      source_type, source_id, call_id, order_id, idempotency_key, reversal_of_event_id, reversal_reason, actor_type, actor_id
    ) VALUES (
      v_ec_event.company_id, v_ec_event.salesperson_id, 'EFFECTIVE_CALL', 'REVERSED', v_ec_event.business_date,
      'SALES_CALL', p_call_id, p_call_id, v_ec_event.order_id, 'ec-reversal-by-call:' || v_ec_event.id::TEXT,
      v_ec_event.id, trim(p_reason), 'USER', p_actor_id
    )
    ON CONFLICT (company_id, idempotency_key) DO NOTHING;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_actor_id, 'sales_kpi.call_reversed', 'sales_calls', p_call_id,
    jsonb_build_object('status', 'VALID'),
    jsonb_build_object('status', 'REVERSED', 'reason', trim(p_reason))
  );

  RETURN QUERY SELECT 'reversed'::TEXT;
END;
$$;

-- ---------------------------------------------------------------------------
-- Routine exposure hardening.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.create_sales_call_task(UUID, UUID, UUID, UUID, TEXT, DATE, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_sales_call(UUID, UUID, UUID, UUID, DATE, TEXT, TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.link_sales_order_call(UUID, UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reverse_sales_call(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_sales_call_task(UUID, UUID, UUID, UUID, TEXT, DATE, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_sales_call(UUID, UUID, UUID, UUID, DATE, TEXT, TEXT, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.link_sales_order_call(UUID, UUID, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_sales_call(UUID, UUID, UUID, TEXT)
  TO service_role;
