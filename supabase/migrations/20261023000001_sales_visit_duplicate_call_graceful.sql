-- =============================================================================
-- Fix: complete_sales_visit() gagal total (uncaught unique_violation) saat
-- sales menyelesaikan KUNJUNGAN KEDUA ke toko yang sama pada hari yang sama.
--
-- Ditemukan Founder di hosted (real sales user, 2026-08-24 17:49 WIB, tenant
-- "PT Sumber Warna Alam Sudiada"): "Gagal menyelesaikan kunjungan." generik,
-- log Vercel menunjukkan root cause sesungguhnya:
--   duplicate key value violates unique constraint "uq_sales_calls_one_per_day"
--
-- uq_sales_calls_one_per_day (migration 20260805000001) MEMANG SENGAJA
-- mengunci "1 Call valid per toko+salesman+hari operasional" -- aturan bisnis
-- anti-gaming KPI ini TIDAK diubah/dilonggarkan sama sekali di sini. Masalahnya
-- murni robustness: INSERT INTO sales_calls di complete_sales_visit()
-- (migration 20261001000001, baris ~488) tidak pernah menangkap constraint
-- violation ini -- begitu tabrakan terjadi, exception mentah membatalkan
-- SELURUH transaksi (termasuk UPDATE sales_visits itu sendiri), jadi
-- kunjungan yang sudah benar-benar terjadi di lapangan tidak pernah bisa
-- ditutup sama sekali untuk toko itu pada hari itu.
--
-- Fix: bungkus blok kredit Call/EC dengan EXCEPTION WHEN unique_violation --
-- kunjungan TETAP diselesaikan & tersimpan (hasil, catatan, lokasi, dst),
-- hanya TIDAK mendapat kredit Call/EC kedua (v_call_credited/v_ec_credited
-- tetap FALSE, v_call_id tetap NULL) -- perilaku KPI persis sama seperti
-- yang sudah dijamin constraint-nya, cuma sekarang graceful bukan crash.
-- Signature RPC tidak berubah (CREATE OR REPLACE, backward-compatible).
-- =============================================================================

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
  v_duplicate_call BOOLEAN := FALSE;
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
      BEGIN
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
      EXCEPTION WHEN unique_violation THEN
        -- uq_sales_calls_one_per_day (migration 20260805000001): toko ini
        -- sudah dapat Call valid hari ini dari kunjungan lain -- BUKAN error,
        -- kunjungan tetap diselesaikan di bawah, hanya tanpa kredit kedua.
        v_call_id := NULL;
        v_call_credited := FALSE;
        v_ec_credited := FALSE;
        v_duplicate_call := TRUE;
      END;
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
  ELSIF v_duplicate_call THEN
    RETURN QUERY SELECT 'completed_duplicate_call'::TEXT, v_visit.id, FALSE, FALSE;
  ELSIF NOT v_call_credited THEN
    RETURN QUERY SELECT 'completed_no_active_period'::TEXT, v_visit.id, FALSE, FALSE;
  ELSE
    RETURN QUERY SELECT 'completed'::TEXT, v_visit.id, v_call_credited, v_ec_credited;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.complete_sales_visit IS
  'Menyelesaikan kunjungan sales + kredit CALL/EFFECTIVE_CALL bila berlaku. Kredit Call kedua ke toko yang sama pada hari yang sama SENGAJA ditolak (uq_sales_calls_one_per_day, anti-gaming KPI) -- sejak fix ini, tabrakan itu ditangkap secara graceful (kunjungan tetap tersimpan tanpa kredit ganda), bukan membatalkan seluruh penyelesaian kunjungan. Idempotent via complete_idempotency_key. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.complete_sales_visit(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, DATE, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_sales_visit(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT[], TEXT, BOOLEAN, TEXT, DATE, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT)
  TO service_role;
