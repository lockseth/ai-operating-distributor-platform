-- =============================================================================
-- Gate 1D-B (K4) — Delivery and proof of receipt: audit atomik.
--
-- Discovery: public.delivery_events (migration 20260716000001, JAUH sebelum
-- Gate 1D-A) SUDAH ADA sebagai append-only trail khusus delivery -- BUKAN
-- tabel paralel yang dibuat gate ini, jadi TIDAK dihapus/digabung (di luar
-- scope, berisiko merusak modul delivery existing). Gap sesungguhnya: setiap
-- mutasi (createDelivery, recordDispatch, finalizeDelivery di
-- lib/delivery/repository.ts) menulis lewat .from().update() LANGSUNG,
-- kemudian delivery_events di-insert TERPISAH (non-atomic, 2 round-trip) oleh
-- lib/delivery/workflow.ts -- pola bypass yang identik dengan Order sebelum
-- K2. Delivery TIDAK PERNAH muncul di public.audit_logs sama sekali (absen
-- total dari ACTIVITY_AUDIT_COVERAGE_MATRIX) -- Owner tidak punya cara
-- membedakan event Delivery dari domain lain di Activity & Audit Log.
--
-- Scope RPC atomik (mutasi + audit_logs dalam satu transaksi), mengikuti
-- kasus kritis wajib gate ini (order 300 dus, kirim 300, terima 150):
--   1. create_delivery_atomic       -- delivery.create   (planned + assign driver)
--   2. dispatch_delivery_atomic     -- delivery.dispatch (planned -> dispatched)
--   3. finalize_delivery_atomic     -- delivery.receipt_confirmed (quantity
--      final + exception + recipient + status -> terminal, SATU keputusan
--      bisnis meski melibatkan beberapa tabel -- bukti quantity sent/
--      received/selisih, siapa konfirmasi, referensi evidence)
--
-- TIDAK di-atomic-kan (sengaja, di luar scope minimal):
--   - recordArrival (outcome_selection) -- transisi UX intermediate, BUKAN
--     keputusan bisnis final (belum ada quantity/evidence), bukan bagian
--     canonical event list gate ini. Tetap non-atomic seperti sebelumnya.
--   - insertEvidence -- evidence individual TIDAK diaudit sebagai event
--     terpisah (satu keputusan finalize = satu event; evidence hanya
--     direferensikan sebagai ID dalam payload finalize_delivery_atomic,
--     TIDAK PERNAH storage_ref/file_id/binary).
--   - delivery.cancelled/corrected -- TIDAK ADA kapabilitas cancel/correct
--     delivery di codebase ini (deliveries append-only, tidak ada policy
--     DELETE, tidak ada RPC cancel). TIDAK dibuat event palsu untuk ini.
--
-- finalize_delivery_atomic memanggil public.finalize_delivery_item_quantities
-- (existing, 20260718000001) SECARA INTERNAL dalam transaksi yang sama --
-- RAISE EXCEPTION QUANTITY_EXCEEDS_OUTSTANDING dari situ otomatis membatalkan
-- SELURUH pemanggilan (tidak ada audit palsu untuk kegagalan kuantitas).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_delivery_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_sales_order_id UUID,
  p_idempotency_key TEXT,
  p_driver_id UUID,
  p_items JSONB -- [{sales_order_item_id, ordered_quantity}]
)
RETURNS TABLE(result_outcome TEXT, result_delivery_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_order_status TEXT;
  v_driver_allowed BOOLEAN;
  v_existing_id UUID;
  v_attempt_number INTEGER;
  v_delivery_id UUID;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND p.name = 'delivery.manage'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM public.deliveries
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN QUERY SELECT 'already_exists'::TEXT, v_existing_id;
      RETURN;
    END IF;
  END IF;

  SELECT status INTO v_order_status
  FROM public.sales_orders
  WHERE id = p_sales_order_id AND company_id = p_company_id;

  IF v_order_status IS NULL THEN
    RETURN QUERY SELECT 'order_not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF v_order_status != 'confirmed' THEN
    RETURN QUERY SELECT 'invalid_order_status'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = p_driver_id AND u.company_id = p_company_id AND u.is_active = TRUE
  ) INTO v_driver_allowed;
  IF NOT v_driver_allowed THEN
    RETURN QUERY SELECT 'invalid_driver'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(attempt_number), 0) + 1 INTO v_attempt_number
  FROM public.deliveries WHERE sales_order_id = p_sales_order_id;

  INSERT INTO public.deliveries (
    company_id, sales_order_id, attempt_number, assigned_driver_id,
    idempotency_key, created_by, status
  ) VALUES (
    p_company_id, p_sales_order_id, v_attempt_number, p_driver_id,
    p_idempotency_key, p_actor_id, 'planned'
  )
  RETURNING id INTO v_delivery_id;

  IF jsonb_array_length(p_items) > 0 THEN
    INSERT INTO public.delivery_items (delivery_id, sales_order_item_id, ordered_quantity)
    SELECT v_delivery_id, x.sales_order_item_id, x.ordered_quantity
    FROM jsonb_to_recordset(p_items) AS x(sales_order_item_id UUID, ordered_quantity NUMERIC);
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'delivery.create', 'deliveries', v_delivery_id,
    jsonb_build_object(
      'sales_order_id', p_sales_order_id, 'attempt_number', v_attempt_number,
      'assigned_driver_id', p_driver_id, 'item_count', jsonb_array_length(p_items)
    ),
    NULL, 'audit', 'delivery', 'web', 'success'
  );

  RETURN QUERY SELECT 'created'::TEXT, v_delivery_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_delivery_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_delivery_id UUID
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_delivery public.deliveries%ROWTYPE;
  v_actor_allowed BOOLEAN;
BEGIN
  SELECT * INTO v_delivery
  FROM public.deliveries
  WHERE id = p_delivery_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    LEFT JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    LEFT JOIN public.permissions p ON p.id = rp.permission_id AND p.name = 'delivery.manage'
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND (p.id IS NOT NULL OR v_delivery.assigned_driver_id = p_actor_id)
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  IF v_delivery.status != 'planned' THEN
    RETURN QUERY SELECT 'unchanged'::TEXT;
    RETURN;
  END IF;

  UPDATE public.delivery_items SET dispatched_quantity = ordered_quantity WHERE delivery_id = p_delivery_id;

  UPDATE public.deliveries SET status = 'dispatched', dispatched_at = NOW() WHERE id = p_delivery_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'delivery.dispatch', 'deliveries', p_delivery_id,
    jsonb_build_object('status', v_delivery.status),
    jsonb_build_object('status', 'dispatched'),
    'driver', 'audit', 'delivery', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'dispatched'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_delivery_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_delivery_id UUID,
  p_final_status TEXT,
  p_item_outcomes JSONB, -- [{delivery_item_id, received_quantity, rejected_quantity, returned_quantity, unresolved_quantity}]
  p_reason_code TEXT,
  p_reason_note TEXT,
  p_severity TEXT,
  p_recipient_name TEXT,
  p_is_expected_pic BOOLEAN
)
RETURNS TABLE(result_outcome TEXT, error_sales_order_item_id UUID, error_outstanding NUMERIC, error_requested NUMERIC)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_delivery public.deliveries%ROWTYPE;
  v_actor_allowed BOOLEAN;
  v_exception_id UUID;
  v_evidence_ids JSONB;
  v_quantities JSONB;
BEGIN
  SELECT * INTO v_delivery
  FROM public.deliveries
  WHERE id = p_delivery_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    LEFT JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    LEFT JOIN public.permissions p ON p.id = rp.permission_id AND p.name = 'delivery.manage'
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND (p.id IS NOT NULL OR v_delivery.assigned_driver_id = p_actor_id)
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- Idempotent: delivery yang sudah terminal tidak diubah lagi (mirror
  -- alreadyFinalized existing di finalizeDelivery()).
  IF v_delivery.status NOT IN ('planned', 'dispatched', 'arrived') THEN
    RETURN QUERY SELECT 'already_finalized'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
    RETURN;
  END IF;

  -- Satu-satunya jalur commit quantity -- atomic, row-locked lintas SELURUH
  -- delivery attempt milik sales_order yang sama (fungsi existing,
  -- 20260718000001). RAISE EXCEPTION QUANTITY_EXCEEDS_OUTSTANDING di sini
  -- membatalkan SELURUH transaksi (tidak ada exception/recipient/status/audit
  -- yang ter-commit).
  IF jsonb_array_length(p_item_outcomes) > 0 THEN
    PERFORM public.finalize_delivery_item_quantities(p_delivery_id, p_item_outcomes);
  END IF;

  IF p_reason_code IS NOT NULL THEN
    INSERT INTO public.delivery_exceptions (
      company_id, delivery_id, reason_code, note, severity, actor_id
    ) VALUES (
      p_company_id, p_delivery_id, p_reason_code, p_reason_note, COALESCE(p_severity, 'medium'), p_actor_id
    )
    RETURNING id INTO v_exception_id;
  END IF;

  IF p_recipient_name IS NOT NULL THEN
    INSERT INTO public.delivery_recipients (
      company_id, delivery_id, recipient_name, is_expected_pic
    ) VALUES (
      p_company_id, p_delivery_id, p_recipient_name, COALESCE(p_is_expected_pic, TRUE)
    );
  END IF;

  UPDATE public.deliveries
  SET status = p_final_status, finalized_at = NOW()
  WHERE id = p_delivery_id AND status = v_delivery.status;

  -- Referensi evidence yang SUDAH terlampir untuk delivery ini (ID saja --
  -- TIDAK PERNAH storage_ref/file_id/binary dalam audit_logs).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', de.id, 'evidence_type', de.evidence_type)), '[]'::jsonb)
  INTO v_evidence_ids
  FROM public.delivery_evidence de
  WHERE de.delivery_id = p_delivery_id;

  -- Bukti quantity sent/received/selisih per item -- kasus kritis gate ini
  -- (300 dus dikirim, 150 diterima, selisih 150).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'delivery_item_id', di.id,
    'sales_order_item_id', di.sales_order_item_id,
    'dispatched_quantity', di.dispatched_quantity,
    'received_quantity', di.received_quantity,
    'rejected_quantity', di.rejected_quantity,
    'returned_quantity', di.returned_quantity,
    'unresolved_quantity', di.unresolved_quantity,
    'shortage', di.dispatched_quantity - di.received_quantity
  )), '[]'::jsonb)
  INTO v_quantities
  FROM public.delivery_items di
  WHERE di.delivery_id = p_delivery_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    reason, actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'delivery.receipt_confirmed', 'deliveries', p_delivery_id,
    jsonb_build_object('status', v_delivery.status),
    jsonb_build_object(
      'status', p_final_status,
      'sales_order_id', v_delivery.sales_order_id,
      'quantities', v_quantities,
      'receiver_name', p_recipient_name,
      'receiver_expected_pic', p_is_expected_pic,
      'exception_id', v_exception_id,
      'reason_code', p_reason_code,
      'evidence', v_evidence_ids
    ),
    p_reason_note,
    CASE WHEN v_delivery.assigned_driver_id = p_actor_id THEN 'driver' ELSE NULL END,
    'audit', 'delivery', 'telegram', 'success'
  );

  RETURN QUERY SELECT 'finalized'::TEXT, NULL::UUID, NULL::NUMERIC, NULL::NUMERIC;
END;
$$;

REVOKE ALL ON FUNCTION public.create_delivery_atomic(UUID, UUID, UUID, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_delivery_atomic(UUID, UUID, UUID, TEXT, UUID, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.dispatch_delivery_atomic(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_delivery_atomic(UUID, UUID, UUID)
  TO service_role;

REVOKE ALL ON FUNCTION public.finalize_delivery_atomic(UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_delivery_atomic(UUID, UUID, UUID, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, BOOLEAN)
  TO service_role;
