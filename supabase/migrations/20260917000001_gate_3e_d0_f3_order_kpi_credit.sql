-- =============================================================================
-- Gate 3E-D0-F3 — Unified Governed KPI & Telegram Order Credit
--
-- Keputusan arsitektur (lock, gate ini):
--   1. public.sales_kpi_* tetap satu-satunya source of truth KPI governed.
--   2. sales_reports TIDAK disentuh -- tetap laporan aktivitas/self-report.
--   3. KPI governed sekarang mendukung EMPAT kode: CALL, EFFECTIVE_CALL
--      (tidak berubah, lihat 20260804000001/20260805000001), DAN dua kode
--      BARU: ORDER_COUNT dan REVENUE.
--   4. Order confirmed (SEMUA channel/order_source -- bukan hanya Telegram,
--      bukan hanya FIELD_VISIT) mengkredit ORDER_COUNT (+1) dan REVENUE
--      (+final_amount) milik sales_id order tsb. TIDAK ADA filter
--      order_source/source_channel -- baris ini menegakkan instruksi "jangan
--      membuat Telegram-specific KPI truth; semua channel order confirmed
--      mengikuti aturan yang sama bila melewati sales_orders".
--   5. EFFECTIVE_CALL TIDAK berubah -- tetap butuh call_id tertaut ke Call
--      valid DAN order_source=FIELD_VISIT (credit_effective_call_for_order,
--      20260805000001, tidak disentuh migration ini). Order Telegram remote
--      (order_source != FIELD_VISIT, call_id NULL) mengkredit ORDER_COUNT/
--      REVENUE tapi TIDAK PERNAH EFFECTIVE_CALL.
--   6. Reversal: order -> status='cancelled' (SATU-SATUNYA kolom yang
--      ditonton -- mencakup jalur dispute resolution, invoice-void
--      cancellation, maupun cancel langsung, sama seperti
--      reverse_effective_call_for_order) membalik ORDER_COUNT/REVENUE yang
--      sudah dikredit lewat baris REVERSED baru (ledger append-only, TIDAK
--      PERNAH UPDATE/DELETE baris CREDITED asal).
--   7. Idempotency: idempotency_key diturunkan dari order_id (bukan dari
--      timestamp/random) + UNIQUE index partial per (order_id, kpi_code,
--      event_type='CREDITED') -- retry webhook Telegram/update_id ganda,
--      atau UPDATE status yang sama berulang kali, tidak pernah
--      menggandakan kredit maupun reversal.
--   8. Legacy import (is_historical=TRUE) TIDAK PERNAH dikredit -- pola sama
--      dengan EFFECTIVE_CALL (20260805000001, skenario 17).
--   9. Order tanpa sales_id (belum di-assign salesman) TIDAK dikredit ke
--      siapa pun -- achievement selalu per-salesperson, tidak ada "orphan
--      credit".
--
-- REVENUE bukan angka input bebas -- selalu diturunkan dari
-- sales_orders.final_amount (total order authoritative, sudah dikurangi
-- discount, plus tax), BUKAN dari laporan manual sales_reports.
-- Downstream credit note/return (20260831000001) SENGAJA TIDAK menyesuaikan
-- REVENUE governed di gate ini -- di luar 8 skenario verifikasi yang
-- diinstruksikan; dicatat sebagai limitation eksplisit di laporan gate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. sales_kpi_definitions: izinkan unit IDR (selain COUNT) dan dua
--    measurement_source baru. CONSTRAINT lama tetap kompatibel (superset).
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_kpi_definitions
  DROP CONSTRAINT sales_kpi_definitions_unit_check;

ALTER TABLE public.sales_kpi_definitions
  ADD CONSTRAINT sales_kpi_definitions_unit_check
  CHECK (unit IN ('COUNT', 'IDR'));

ALTER TABLE public.sales_kpi_definitions
  DROP CONSTRAINT sales_kpi_definitions_measurement_source_check;

ALTER TABLE public.sales_kpi_definitions
  ADD CONSTRAINT sales_kpi_definitions_measurement_source_check
  CHECK (measurement_source IN (
    'VALID_FIELD_VISIT',
    'CONFIRMED_FIELD_VISIT_ORDER',
    'CONFIRMED_SALES_ORDER_COUNT',
    'CONFIRMED_SALES_ORDER_REVENUE'
  ));

-- ---------------------------------------------------------------------------
-- 2. sales_kpi_achievement_events: kpi_code baru + kolom value (kontribusi
--    numerik baris ini -- 1 untuk KPI COUNT, final_amount untuk REVENUE).
--    DEFAULT 1 membackfill baris CALL/EFFECTIVE_CALL lama secara otomatis
--    (semantically benar -- setiap baris lama memang bernilai 1 unit).
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_kpi_achievement_events
  DROP CONSTRAINT chk_skae_call_kpi;
ALTER TABLE public.sales_kpi_achievement_events
  DROP CONSTRAINT chk_skae_ec_kpi;

ALTER TABLE public.sales_kpi_achievement_events
  DROP CONSTRAINT sales_kpi_achievement_events_kpi_code_check;
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT sales_kpi_achievement_events_kpi_code_check
  CHECK (kpi_code IN ('CALL', 'EFFECTIVE_CALL', 'ORDER_COUNT', 'REVENUE'));

ALTER TABLE public.sales_kpi_achievement_events
  ADD COLUMN IF NOT EXISTS value NUMERIC(15,2) NOT NULL DEFAULT 1;

ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_call_kpi CHECK (kpi_code <> 'CALL' OR call_id IS NOT NULL);
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_ec_kpi CHECK (
    kpi_code <> 'EFFECTIVE_CALL' OR (call_id IS NOT NULL AND order_id IS NOT NULL)
  );
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_order_count_kpi CHECK (
    kpi_code <> 'ORDER_COUNT' OR order_id IS NOT NULL
  );
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_revenue_kpi CHECK (
    kpi_code <> 'REVENUE' OR order_id IS NOT NULL
  );
ALTER TABLE public.sales_kpi_achievement_events
  ADD CONSTRAINT chk_skae_value_by_kpi CHECK (
    (kpi_code IN ('CALL', 'EFFECTIVE_CALL', 'ORDER_COUNT') AND value = 1) OR
    (kpi_code = 'REVENUE' AND value >= 0)
  );

COMMENT ON COLUMN public.sales_kpi_achievement_events.value IS
  'Kontribusi numerik baris ini ke agregat KPI. Selalu 1 untuk KPI COUNT (CALL/EFFECTIVE_CALL/ORDER_COUNT). Untuk REVENUE, sama dengan sales_orders.final_amount pada saat dikredit (immutable -- baris REVERSED membawa nilai yang SAMA dengan baris CREDITED yang dibalik, sehingga SUM(value bertanda CREDITED/REVERSED) selalu netral).';

-- Maksimal SATU event ORDER_COUNT/REVENUE CREDITED per order -- retry
-- webhook/status update tidak pernah menggandakan kredit.
CREATE UNIQUE INDEX uq_skae_order_count_credited_once
  ON public.sales_kpi_achievement_events (order_id)
  WHERE kpi_code = 'ORDER_COUNT' AND event_type = 'CREDITED';

CREATE UNIQUE INDEX uq_skae_revenue_credited_once
  ON public.sales_kpi_achievement_events (order_id)
  WHERE kpi_code = 'REVENUE' AND event_type = 'CREDITED';

-- ---------------------------------------------------------------------------
-- 3. initialize_sales_kpi_foundation: CREATE OR REPLACE berbasis body LIVE
--    20260821000001 (kolom audit kanonis) + dua definisi baru. Idempotent
--    lewat ON CONFLICT DO NOTHING yang sudah ada -- tenant existing yang
--    memanggil ulang RPC ini hanya akan mendapat ORDER_COUNT/REVENUE baru
--    ditambahkan, CALL/EFFECTIVE_CALL yang sudah ada TIDAK disentuh.
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
        'codes', jsonb_build_array('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE'),
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
        AND d.code IN ('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE')
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. set_sales_kpi_target: CREATE OR REPLACE berbasis body LIVE
--    20260821000001, satu-satunya perubahan adalah daftar kpi_code yang
--    didukung (menambah ORDER_COUNT, REVENUE). Signature TIDAK berubah.
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

  IF p_kpi_code IS NULL OR p_kpi_code NOT IN ('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE') THEN
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
-- 5. Kredit ORDER_COUNT + REVENUE otomatis. Fires pada SETIAP order confirmed
--    (insert langsung confirmed, ATAU transisi status -> confirmed) --
--    SEMUA order_source/source_channel, TIDAK seperti EFFECTIVE_CALL yang
--    butuh call_id+FIELD_VISIT. Idempotent murni lewat ON CONFLICT pada
--    idempotency_key yang diturunkan dari order_id -- retry status-update
--    apa pun tidak pernah menggandakan kredit.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.credit_order_kpi_for_sales_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_business_date DATE;
BEGIN
  IF NEW.status <> 'confirmed' OR NEW.is_historical OR NEW.sales_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_business_date := (COALESCE(NEW.confirmed_at, NOW()) AT TIME ZONE 'Asia/Jakarta')::DATE;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, order_id, idempotency_key, value, actor_type
  ) VALUES (
    NEW.company_id, NEW.sales_id, 'ORDER_COUNT', 'CREDITED', v_business_date,
    'SALES_ORDER', NEW.id, NEW.id, 'order-count:' || NEW.id::TEXT, 1, 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, order_id, idempotency_key, value, actor_type
  ) VALUES (
    NEW.company_id, NEW.sales_id, 'REVENUE', 'CREDITED', v_business_date,
    'SALES_ORDER', NEW.id, NEW.id, 'revenue:' || NEW.id::TEXT, NEW.final_amount, 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_credit_order_kpi
  AFTER INSERT OR UPDATE OF status ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.status = 'confirmed')
  EXECUTE FUNCTION public.credit_order_kpi_for_sales_order();

-- ---------------------------------------------------------------------------
-- 6. Reversal ORDER_COUNT + REVENUE otomatis saat order -> cancelled (SEMUA
--    jalur: dispute resolution, invoice-void cancellation, cancel langsung --
--    satu-satunya kolom yang diperiksa adalah sales_orders.status, pola
--    identik reverse_effective_call_for_order). Ledger append-only: baris
--    REVERSED baru membawa value yang SAMA dengan CREDITED asal supaya
--    SUM bertanda tetap netral, event asal tidak pernah diubah/dihapus.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_order_kpi_for_sales_order()
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

  FOR v_event IN
    SELECT id, company_id, salesperson_id, kpi_code, business_date, order_id, value
    FROM public.sales_kpi_achievement_events
    WHERE order_id = NEW.id
      AND kpi_code IN ('ORDER_COUNT', 'REVENUE')
      AND event_type = 'CREDITED'
  LOOP
    INSERT INTO public.sales_kpi_achievement_events (
      company_id, salesperson_id, kpi_code, event_type, business_date,
      source_type, source_id, order_id, idempotency_key, value,
      reversal_of_event_id, reversal_reason, actor_type
    ) VALUES (
      v_event.company_id, v_event.salesperson_id, v_event.kpi_code, 'REVERSED', v_event.business_date,
      'SALES_ORDER', NEW.id, v_event.order_id,
      'order-kpi-reversal:' || v_event.id::TEXT, v_event.value,
      v_event.id, 'Order dinyatakan tidak sah/dibatalkan melalui resolusi dispute/cancellation', 'SYSTEM'
    )
    ON CONFLICT (company_id, idempotency_key) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_reverse_order_kpi
  AFTER UPDATE OF status ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.reverse_order_kpi_for_sales_order();
