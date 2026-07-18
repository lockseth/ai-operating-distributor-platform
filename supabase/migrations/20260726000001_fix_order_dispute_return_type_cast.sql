-- =============================================================================
-- Fix: order_cancellation_disputes RPC — VARCHAR vs TEXT return-type mismatch
--
-- Ditemukan via live UAT (Coverage & Order Dispute Reconciliation Gate):
-- resolve_order_cancellation_dispute() gagal pada branch 'already_resolved'
-- dengan error Postgres "structure of query does not match function result
-- type". Root cause: kolom asal (v_request.status, v_existing.*) bertipe
-- VARCHAR(n) dari %ROWTYPE, sedangkan RETURNS TABLE mendeklarasikan TEXT.
-- Cabang lain di kedua fungsi selalu memakai variabel TEXT lokal atau
-- literal ::TEXT eksplisit sehingga tidak kena masalah ini -- hanya dua
-- cabang di bawah yang mengembalikan kolom %ROWTYPE varchar tanpa cast.
--
-- Dampak nyata sebelum fix ini: retry create_order_cancellation_dispute()
-- dengan idempotency_key yang sama ('already_exists' branch) DAN retry
-- resolve_order_cancellation_dispute() pada request yang sudah selesai
-- ('already_resolved' branch) SAMA-SAMA gagal dengan unexpected_error --
-- persis skenario retry jaringan Telegram yang paling butuh idempotency.
--
-- Fix: cast eksplisit ::TEXT pada seluruh kolom VARCHAR yang dikembalikan
-- lewat RETURN QUERY di kedua fungsi. Tidak ada perubahan skema/kontrak
-- (signature, nama kolom, urutan outcome) -- murni perbaikan bug tipe data.
-- Migration baru (bukan edit migration lama yang sudah diterapkan).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_order_cancellation_dispute(
  p_company_id UUID,
  p_sales_order_id UUID,
  p_request_type TEXT,
  p_reason_code TEXT,
  p_notes TEXT,
  p_reported_pic_name TEXT,
  p_reported_pic_phone TEXT,
  p_contact_source TEXT,
  p_requested_by UUID,
  p_idempotency_key TEXT
)
RETURNS TABLE(
  result_outcome TEXT,
  request_id UUID,
  order_stage TEXT,
  ai_classification TEXT,
  auto_cancelled BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_order public.sales_orders%ROWTYPE;
  v_existing public.order_cancellation_disputes%ROWTYPE;
  v_stage TEXT;
  v_classification TEXT;
  v_new_id UUID;
  v_auto_cancel BOOLEAN := FALSE;
  v_status TEXT;
BEGIN
  IF p_request_type NOT IN ('CUSTOMER_CANCELLED', 'CUSTOMER_DENIES_ORDER') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.order_cancellation_disputes
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN QUERY SELECT
        'already_exists'::TEXT,
        v_existing.id,
        v_existing.order_stage_at_request::TEXT,
        v_existing.ai_classification::TEXT,
        (v_existing.status = 'APPROVED');
      RETURN;
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p_requested_by
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_sales_order_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'order_not_found'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF v_order.status = 'cancelled' THEN
    RETURN QUERY SELECT 'order_already_cancelled'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_cancellation_disputes
    WHERE sales_order_id = p_sales_order_id AND status IN ('REQUESTED', 'ON_HOLD')
  ) THEN
    RETURN QUERY SELECT 'already_has_active_request'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  PERFORM 1 FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;

  v_stage := public.determine_order_stage(p_sales_order_id);

  IF p_request_type = 'CUSTOMER_DENIES_ORDER' THEN
    v_classification := 'HOLD_AND_ALERT';
    v_status := 'ON_HOLD';
  ELSIF v_stage = 'NOT_DISPATCHED' THEN
    v_classification := 'AUTO_CANCEL_SAFE';
    v_status := 'APPROVED';
    v_auto_cancel := TRUE;
  ELSIF v_stage = 'IN_DISPATCH_PLAN_NOT_DEPARTED' THEN
    v_classification := 'NEEDS_REVIEW';
    v_status := 'REQUESTED';
  ELSE
    v_classification := 'HOLD_AND_ALERT';
    v_status := 'ON_HOLD';
  END IF;

  INSERT INTO public.order_cancellation_disputes (
    company_id, sales_order_id, request_type, reason_code, notes,
    reported_pic_name_snapshot, reported_pic_phone_snapshot, contact_source,
    order_stage_at_request, ai_classification, status,
    requested_by, idempotency_key
  ) VALUES (
    p_company_id, p_sales_order_id, p_request_type, p_reason_code, p_notes,
    NULLIF(p_reported_pic_name, ''), NULLIF(p_reported_pic_phone, ''), p_contact_source,
    v_stage, v_classification, v_status,
    p_requested_by, p_idempotency_key
  )
  RETURNING id INTO v_new_id;

  IF v_auto_cancel THEN
    UPDATE public.sales_orders SET status = 'cancelled' WHERE id = p_sales_order_id;
    UPDATE public.order_cancellation_disputes
    SET status = 'APPROVED', resolution = 'CANCEL_APPROVED'
    WHERE id = v_new_id;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data
  ) VALUES (
    p_company_id, p_requested_by, 'order.cancellation_dispute_requested', 'order_cancellation_disputes', v_new_id,
    jsonb_build_object(
      'sales_order_id', p_sales_order_id,
      'request_type', p_request_type,
      'reason_code', p_reason_code,
      'contact_source', p_contact_source,
      'order_stage_at_request', v_stage,
      'ai_classification', v_classification,
      'auto_cancelled', v_auto_cancel
    )
  );

  RETURN QUERY SELECT 'created'::TEXT, v_new_id, v_stage, v_classification, v_auto_cancel;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_order_cancellation_dispute(
  p_company_id UUID,
  p_request_id UUID,
  p_reviewer_id UUID,
  p_resolution TEXT,
  p_resolution_notes TEXT,
  p_actual_pic_name TEXT
)
RETURNS TABLE(result_outcome TEXT, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reviewer_allowed BOOLEAN;
  v_request public.order_cancellation_disputes%ROWTYPE;
  v_final_status TEXT;
BEGIN
  IF p_resolution NOT IN ('CANCEL_APPROVED','CANCEL_REJECTED','CANCELLED_NOT_ORDERED','ORDERED_BY_ANOTHER_PIC','KEPT_ON_HOLD') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_reviewer_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name IN ('owner','manager','admin','super_admin')
  ) INTO v_reviewer_allowed;

  IF NOT v_reviewer_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_request
  FROM public.order_cancellation_disputes
  WHERE id = p_request_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_request.requested_by = p_reviewer_id THEN
    RETURN QUERY SELECT 'self_review_forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_request.status NOT IN ('REQUESTED', 'ON_HOLD') THEN
    RETURN QUERY SELECT 'already_resolved'::TEXT, v_request.status::TEXT;
    RETURN;
  END IF;

  v_final_status := CASE
    WHEN p_resolution = 'CANCEL_APPROVED' THEN 'APPROVED'
    WHEN p_resolution = 'CANCEL_REJECTED' THEN 'REJECTED'
    WHEN p_resolution = 'CANCELLED_NOT_ORDERED' THEN 'RESOLVED'
    WHEN p_resolution = 'ORDERED_BY_ANOTHER_PIC' THEN 'RESOLVED'
    WHEN p_resolution = 'KEPT_ON_HOLD' THEN 'ON_HOLD'
  END;

  UPDATE public.order_cancellation_disputes
  SET status = v_final_status,
      resolution = p_resolution,
      resolution_notes = p_resolution_notes,
      actual_pic_name_snapshot = NULLIF(p_actual_pic_name, ''),
      reviewed_by = p_reviewer_id,
      reviewed_at = NOW()
  WHERE id = p_request_id;

  IF p_resolution IN ('CANCEL_APPROVED', 'CANCELLED_NOT_ORDERED') THEN
    UPDATE public.sales_orders SET status = 'cancelled' WHERE id = v_request.sales_order_id;
  END IF;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data
  ) VALUES (
    p_company_id, p_reviewer_id, 'order.cancellation_dispute_resolved', 'order_cancellation_disputes', p_request_id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', v_final_status, 'resolution', p_resolution)
  );

  RETURN QUERY SELECT 'resolved'::TEXT, v_final_status;
END;
$$;

REVOKE ALL ON FUNCTION public.create_order_cancellation_dispute(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_cancellation_dispute(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.resolve_order_cancellation_dispute(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_cancellation_dispute(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;
