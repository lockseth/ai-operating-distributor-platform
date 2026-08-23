-- =============================================================================
-- Gate P4.16-B -- submit_store_unlock_request_atomic() / decide_store_
-- unlock_request_atomic(): satu-satunya jalur Sales mengajukan dan Owner
-- memutuskan buka-kunci toko tertunggak (skema Gate P4.16-A).
--
-- Pola identik submit_special_price_proposal_atomic/decide_special_price_
-- proposal_atomic (20260924000001/20260925000001, LOCKED): identitas HANYA
-- dari auth.uid() (TIDAK ADA parameter user_id/company_id trusted), GRANT
-- HANYA authenticated (REVOKE termasuk service_role -- fail-closed bila
-- dipanggil tanpa sesi), idempotency key+payload-hash (retry sama -> hasil
-- existing; payload beda -> idempotency_conflict), lock row induk (customer)
-- FOR UPDATE SEBELUM baris request (deadlock-free, urutan sama di kedua RPC).
--
-- Beda dari special price: tidak ada "order induk" -- row induk yang dikunci
-- FOR UPDATE adalah customers (bukan sales_orders), dan requester TIDAK
-- dibatasi assigned_sales_id (lihat catatan invariant Gate P4.16-A).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. submit_store_unlock_request_atomic
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_store_unlock_request_atomic(
  p_customer_id UUID,
  p_reason TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE(
  result_outcome TEXT,
  request_id UUID,
  customer_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id            UUID;
  v_company_id          UUID;
  v_customer            public.customers%ROWTYPE;
  v_reason              TEXT;
  v_idem_key            TEXT;
  v_payload_fingerprint TEXT;
  v_existing            public.store_unlock_requests%ROWTYPE;
  v_new_request_id      UUID;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  v_company_id := public.get_user_company_id();
  IF v_company_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- Kontrak Founder: sales manapun di tenant boleh mengajukan (TIDAK
  -- dibatasi assigned_sales_id toko ini) -- strictly role 'sales', bukan
  -- permission-based (Owner/Admin/manager tidak bisa "seolah Sales").
  IF NOT ('sales' = ANY(COALESCE(public.get_user_roles(v_actor_id), ARRAY[]::TEXT[]))) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  v_reason   := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');

  -- Idempotency short-circuit SEBELUM lock (pola identik submit_special_
  -- price_proposal_atomic) -- retry key+payload sama mengembalikan hasil
  -- existing tanpa insert baru; payload beda ditolak fail-closed.
  IF v_idem_key IS NOT NULL THEN
    v_payload_fingerprint := md5(p_customer_id::TEXT || '|' || COALESCE(v_reason, ''));

    SELECT * INTO v_existing
    FROM public.store_unlock_requests
    WHERE company_id = v_company_id AND idempotency_key = v_idem_key;

    IF FOUND THEN
      IF v_existing.request_payload_hash = v_payload_fingerprint THEN
        RETURN QUERY SELECT 'already_exists'::TEXT, v_existing.id, v_existing.customer_id;
        RETURN;
      ELSE
        RETURN QUERY SELECT 'idempotency_conflict'::TEXT, NULL::UUID, NULL::UUID;
        RETURN;
      END IF;
    END IF;
  END IF;

  -- Lock row customer (induk) SEBELUM baris request -- urutan sama dengan
  -- decide di bawah, deadlock-free by construction.
  SELECT * INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id AND company_id = v_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF NOT public.is_customer_order_locked(v_company_id, p_customer_id) THEN
    RETURN QUERY SELECT 'not_locked'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF v_reason IS NULL THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO public.store_unlock_requests (
    company_id, customer_id, requested_by, reason, idempotency_key, request_payload_hash
  ) VALUES (
    v_company_id, p_customer_id, v_actor_id, v_reason, v_idem_key, v_payload_fingerprint
  )
  RETURNING id INTO v_new_request_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    v_company_id, v_actor_id, 'customer.store_unlock_requested', 'customers', p_customer_id,
    jsonb_build_object('request_id', v_new_request_id, 'reason', v_reason),
    'sales', 'audit', 'customers', 'web', 'success'
  );

  RETURN QUERY SELECT 'submitted'::TEXT, v_new_request_id, p_customer_id;
END;
$$;

COMMENT ON FUNCTION public.submit_store_unlock_request_atomic(UUID, TEXT, TEXT) IS
  'Gate P4.16-B: Sales (role strict, tenant manapun untuk toko manapun di tenant sama -- tidak dibatasi assigned_sales_id) mengajukan buka-kunci toko yang SEDANG terkunci (is_customer_order_locked() TRUE, kalau tidak -> not_locked). Reason wajib bermakna. Idempotent pada retry key+payload identik. Identitas caller selalu auth.uid(); GRANT hanya authenticated.';

REVOKE ALL ON FUNCTION public.submit_store_unlock_request_atomic(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_store_unlock_request_atomic(UUID, TEXT, TEXT)
  TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. decide_store_unlock_request_atomic
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.decide_store_unlock_request_atomic(
  p_request_id UUID,
  p_decision TEXT,
  p_idempotency_key TEXT,
  p_decision_reason TEXT DEFAULT NULL
)
RETURNS TABLE(
  result_outcome TEXT,
  request_id UUID,
  decision TEXT,
  customer_id UUID,
  decided_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id            UUID;
  v_company_id          UUID;
  v_decision            TEXT;
  v_reason              TEXT;
  v_idem_key            TEXT;
  v_payload_fingerprint TEXT;
  v_existing            public.store_unlock_requests%ROWTYPE;
  v_request             public.store_unlock_requests%ROWTYPE;
  v_decided_at          TIMESTAMPTZ;
BEGIN
  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN QUERY SELECT 'unauthenticated'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_company_id := public.get_user_company_id();
  IF v_company_id IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Strictly role 'owner' aktif tenant sama -- raw EXISTS join, IDENTIK
  -- decider check trigger Gate P4.16-A / decide_special_price_proposal_atomic.
  IF NOT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = v_actor_id
      AND u.company_id = v_company_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_decision IS NULL OR upper(btrim(p_decision)) NOT IN ('APPROVE', 'REJECT') THEN
    RETURN QUERY SELECT 'invalid_decision'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  v_decision := CASE upper(btrim(p_decision)) WHEN 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END;

  v_idem_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_idem_key IS NULL OR length(v_idem_key) > 200 THEN
    RETURN QUERY SELECT 'invalid_idempotency_key'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_decision_reason, '')), '');
  IF v_decision = 'REJECTED' AND v_reason IS NULL THEN
    RETURN QUERY SELECT 'reason_required'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_payload_fingerprint := md5(p_request_id::TEXT || '|' || v_decision || '|' || COALESCE(v_reason, ''));

  SELECT * INTO v_existing
  FROM public.store_unlock_requests
  WHERE company_id = v_company_id AND decision_idempotency_key = v_idem_key;

  IF FOUND THEN
    IF v_existing.decision_payload_hash = v_payload_fingerprint THEN
      RETURN QUERY SELECT 'already_decided'::TEXT, v_existing.id, v_existing.status::TEXT, v_existing.customer_id, v_existing.decided_at;
      RETURN;
    ELSE
      RETURN QUERY SELECT 'idempotency_conflict'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
  END IF;

  -- Resolve request tenant-scoped dulu (fail-closed, tidak membocorkan
  -- keberadaan request cross-tenant).
  SELECT * INTO v_request
  FROM public.store_unlock_requests
  WHERE id = p_request_id AND company_id = v_company_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::TEXT, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Lock customer (induk) SEBELUM request -- urutan identik submit,
  -- deadlock-free by construction.
  PERFORM 1 FROM public.customers WHERE id = v_request.customer_id AND company_id = v_company_id FOR UPDATE;

  SELECT * INTO v_request
  FROM public.store_unlock_requests
  WHERE id = p_request_id AND company_id = v_company_id
  FOR UPDATE;

  -- Concurrent APPROVE vs REJECT: loser melihat status sudah bukan PENDING
  -- setelah lock -- fail-closed, tidak menimpa keputusan (pola identik
  -- decide_special_price_proposal_atomic).
  IF v_request.status <> 'PENDING' THEN
    RETURN QUERY SELECT 'already_decided'::TEXT, v_request.id, v_request.status::TEXT, v_request.customer_id, v_request.decided_at;
    RETURN;
  END IF;

  v_decided_at := NOW();

  UPDATE public.store_unlock_requests
  SET status                   = v_decision,
      decided_by               = v_actor_id,
      decided_at               = v_decided_at,
      decision_reason          = v_reason,
      decision_idempotency_key = v_idem_key,
      decision_payload_hash    = v_payload_fingerprint
  WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    v_company_id, v_actor_id,
    CASE WHEN v_decision = 'APPROVED' THEN 'customer.store_unlock_approved' ELSE 'customer.store_unlock_rejected' END,
    'store_unlock_requests', v_request.id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', v_decision, 'decision_reason', v_reason),
    'owner', 'audit', 'customers', 'web', 'success'
  );

  RETURN QUERY SELECT
    (CASE WHEN v_decision = 'APPROVED' THEN 'approved' ELSE 'rejected' END)::TEXT,
    v_request.id, v_decision, v_request.customer_id, v_decided_at;
END;
$$;

COMMENT ON FUNCTION public.decide_store_unlock_request_atomic(UUID, TEXT, TEXT, TEXT) IS
  'Gate P4.16-B: Owner (strictly role owner aktif tenant sama) memutuskan pengajuan PENDING. APPROVE: exception SEKALI PAKAI tersedia sampai dikonsumsi RPC order (Gate P4.16-C). REJECT: toko tetap terkunci, sales harus ajukan ulang. Idempotent pada retry key+payload identik. Identitas caller selalu auth.uid(); GRANT hanya authenticated.';

REVOKE ALL ON FUNCTION public.decide_store_unlock_request_atomic(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_store_unlock_request_atomic(UUID, TEXT, TEXT, TEXT)
  TO authenticated;
