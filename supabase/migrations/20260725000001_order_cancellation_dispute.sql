-- =============================================================================
-- Order Cancellation & Dispute
--
-- Membedakan dua kejadian bisnis (tidak pernah menghapus order):
--   CUSTOMER_CANCELLED     — PIC mengakui pernah memesan, lalu membatalkan.
--   CUSTOMER_DENIES_ORDER  — PIC menyatakan tidak pernah memesan.
--
-- Desain sengaja TIDAK menambah nilai baru ke sales_orders.status (selain
-- 'cancelled' yang SUDAH ada di CHECK constraint) untuk menghindari race
-- dengan sync_sales_order_delivery_status (delivery module) yang men-derive
-- status dari received_quantity secara independen. Status "hold"/"disputed"
-- direpresentasikan murni oleh baris order_cancellation_disputes yang masih
-- aktif (status REQUESTED/ON_HOLD) -- konsumen (invoice eligibility, dispatch
-- guard) memeriksa keberadaan baris aktif ini, bukan field baru di
-- sales_orders. Ini menghindari dua sumber kebenaran yang bisa saling
-- menimpa.
--
-- PIC master belum ada (audit gate ini) -- reported_pic_id sengaja UUID
-- nullable TANPA foreign key supaya integrasi PIC master di gate berikutnya
-- tidak perlu migration ulang; snapshot nama/nomor selalu disimpan agar
-- fakta historis tidak hilang.
--
-- Append-only untuk fakta permintaan: request_type, reason_code, notes,
-- reported_pic_*, contact_source, order_stage_at_request, requested_by,
-- requested_at TIDAK PERNAH berubah setelah insert -- trigger di bawah
-- menegakkan ini di level DB, bukan hanya konvensi aplikasi.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.order_cancellation_disputes (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id              UUID         NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,

  request_type                VARCHAR(30)  NOT NULL
    CHECK (request_type IN ('CUSTOMER_CANCELLED', 'CUSTOMER_DENIES_ORDER')),
  reason_code                 VARCHAR(50)  NOT NULL,
  notes                       TEXT,

  -- PIC master belum ada -- tidak ada FK, hanya snapshot fakta pada saat request.
  reported_pic_id             UUID,
  reported_pic_name_snapshot  VARCHAR(255),
  reported_pic_phone_snapshot VARCHAR(50),

  contact_source               VARCHAR(30) NOT NULL
    CHECK (contact_source IN ('CUSTOMER_WHATSAPP', 'CUSTOMER_PHONE', 'FIELD_VISIT', 'OTHER')),

  order_stage_at_request       VARCHAR(40) NOT NULL
    CHECK (order_stage_at_request IN (
      'NOT_DISPATCHED',
      'IN_DISPATCH_PLAN_NOT_DEPARTED',
      'DEPARTED_IN_TRANSIT',
      'RECEIVED_PARTIAL',
      'RECEIVED_FULL',
      'DEPARTED_TERMINAL_OTHER'
    )),

  ai_classification             VARCHAR(20)
    CHECK (ai_classification IN ('AUTO_CANCEL_SAFE', 'NEEDS_REVIEW', 'HOLD_AND_ALERT')),

  status                        VARCHAR(20) NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED', 'ON_HOLD', 'APPROVED', 'REJECTED', 'RESOLVED')),

  resolution                    VARCHAR(40)
    CHECK (resolution IN (
      'CANCEL_APPROVED',
      'CANCEL_REJECTED',
      'CANCELLED_NOT_ORDERED',
      'ORDERED_BY_ANOTHER_PIC',
      'KEPT_ON_HOLD'
    )),
  resolution_notes               TEXT,
  actual_pic_name_snapshot       VARCHAR(255),

  requested_by                   UUID NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  requested_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_by                    UUID REFERENCES public.users (id) ON DELETE SET NULL,
  reviewed_at                    TIMESTAMPTZ,

  -- Idempotency: request Telegram yang sama (retry jaringan dsb.) tidak
  -- membuat baris duplikat.
  idempotency_key                TEXT,

  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_ocd_review_pair CHECK (
    (reviewed_by IS NULL AND reviewed_at IS NULL) OR
    (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CONSTRAINT chk_ocd_self_review CHECK (reviewed_by IS DISTINCT FROM requested_by),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_ocd_company_status ON public.order_cancellation_disputes (company_id, status);
CREATE INDEX idx_ocd_sales_order    ON public.order_cancellation_disputes (sales_order_id);
-- Hanya SATU request aktif (REQUESTED/ON_HOLD) per order -- mencegah request
-- ganda tumpang tindih untuk order yang sama.
CREATE UNIQUE INDEX uq_ocd_one_active_per_order
  ON public.order_cancellation_disputes (sales_order_id)
  WHERE status IN ('REQUESTED', 'ON_HOLD');

COMMENT ON TABLE public.order_cancellation_disputes IS
  'Event pembatalan/sengketa order, dilaporkan Salesman lewat Telegram. Append-only untuk fakta permintaan (lihat trigger trg_ocd_append_only). Tidak pernah menghapus order (hard delete dilarang).';

ALTER TABLE public.order_cancellation_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ocd_select" ON public.order_cancellation_disputes
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

REVOKE ALL ON TABLE public.order_cancellation_disputes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.order_cancellation_disputes TO authenticated;

-- ---------------------------------------------------------------------------
-- Append-only enforcement: kolom fakta permintaan tidak boleh berubah
-- setelah insert. Hanya kolom hasil review (status, resolution,
-- resolution_notes, actual_pic_name_snapshot, reviewed_by, reviewed_at,
-- ai_classification, updated_at) yang boleh diperbarui.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_ocd_append_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.company_id                  IS DISTINCT FROM OLD.company_id
     OR NEW.sales_order_id           IS DISTINCT FROM OLD.sales_order_id
     OR NEW.request_type             IS DISTINCT FROM OLD.request_type
     OR NEW.reason_code              IS DISTINCT FROM OLD.reason_code
     OR NEW.notes                    IS DISTINCT FROM OLD.notes
     OR NEW.reported_pic_id          IS DISTINCT FROM OLD.reported_pic_id
     OR NEW.reported_pic_name_snapshot  IS DISTINCT FROM OLD.reported_pic_name_snapshot
     OR NEW.reported_pic_phone_snapshot IS DISTINCT FROM OLD.reported_pic_phone_snapshot
     OR NEW.contact_source           IS DISTINCT FROM OLD.contact_source
     OR NEW.order_stage_at_request   IS DISTINCT FROM OLD.order_stage_at_request
     OR NEW.requested_by             IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at             IS DISTINCT FROM OLD.requested_at
     OR NEW.idempotency_key          IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at               IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'order_cancellation_disputes: fakta permintaan bersifat append-only, tidak boleh diubah (id=%)', OLD.id;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ocd_append_only
  BEFORE UPDATE ON public.order_cancellation_disputes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ocd_append_only();

-- ---------------------------------------------------------------------------
-- Deteksi tahap order (untuk order_stage_at_request) -- dihitung SEKALI di
-- dalam transaksi RPC create supaya tidak race dengan dispatch/delivery yang
-- berubah bersamaan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.determine_order_stage(p_sales_order_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_delivery_status TEXT;
  v_has_active_plan BOOLEAN;
BEGIN
  SELECT status INTO v_delivery_status
  FROM public.deliveries
  WHERE sales_order_id = p_sales_order_id
  ORDER BY attempt_number DESC
  LIMIT 1;

  IF v_delivery_status IN ('dispatched', 'arrived') THEN
    RETURN 'DEPARTED_IN_TRANSIT';
  ELSIF v_delivery_status IN ('fully_received', 'verified') THEN
    RETURN 'RECEIVED_FULL';
  ELSIF v_delivery_status = 'partially_received' THEN
    RETURN 'RECEIVED_PARTIAL';
  ELSIF v_delivery_status IN ('rejected', 'store_closed', 'failed') THEN
    RETURN 'DEPARTED_TERMINAL_OTHER';
  END IF;

  -- Tidak ada delivery, atau delivery masih 'planned' (dibuat tapi belum berangkat).
  SELECT EXISTS (
    SELECT 1 FROM public.dispatch_plans
    WHERE sales_order_id = p_sales_order_id
      AND planning_status <> 'cancelled'
  ) INTO v_has_active_plan;

  IF v_has_active_plan OR v_delivery_status = 'planned' THEN
    RETURN 'IN_DISPATCH_PLAN_NOT_DEPARTED';
  END IF;

  RETURN 'NOT_DISPATCHED';
END;
$$;

-- ---------------------------------------------------------------------------
-- Create (atomic): validasi actor+tenant, deteksi stage, insert append-only,
-- auto-resolve HANYA untuk kasus aman (CUSTOMER_CANCELLED sebelum dispatch).
-- Idempotent via UNIQUE(company_id, idempotency_key).
-- ---------------------------------------------------------------------------
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

  -- Idempotency: retry dengan key yang sama mengembalikan baris yang sudah ada.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.order_cancellation_disputes
    WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN QUERY SELECT
        'already_exists'::TEXT,
        v_existing.id,
        v_existing.order_stage_at_request,
        v_existing.ai_classification,
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

  -- Satu request aktif per order (unique partial index) -- cek eksplisit
  -- dulu supaya pesan errornya jelas, bukan constraint violation mentah.
  IF EXISTS (
    SELECT 1 FROM public.order_cancellation_disputes
    WHERE sales_order_id = p_sales_order_id AND status IN ('REQUESTED', 'ON_HOLD')
  ) THEN
    RETURN QUERY SELECT 'already_has_active_request'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT, FALSE;
    RETURN;
  END IF;

  -- Lock baris order supaya deteksi stage + auto-cancel atomic terhadap
  -- dispatch/delivery yang mungkin berubah bersamaan.
  PERFORM 1 FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;

  v_stage := public.determine_order_stage(p_sales_order_id);

  -- Klasifikasi AI (rule-based, BUKAN LLM) -- murni menentukan kategori
  -- tindak lanjut, TIDAK PERNAH menghukum/menonaktifkan Salesman.
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
    -- Sudah berangkat/diterima sebagian/penuh/terminal lain -- selalu perlu
    -- keputusan manusia, tidak pernah auto.
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

REVOKE ALL ON FUNCTION public.create_order_cancellation_dispute(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_cancellation_dispute(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Resolve (Human Review): actor berwenang, BUKAN requester sendiri,
-- request masih terbuka (REQUESTED/ON_HOLD).
-- ---------------------------------------------------------------------------
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
    RETURN QUERY SELECT 'already_resolved'::TEXT, v_request.status;
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

REVOKE ALL ON FUNCTION public.resolve_order_cancellation_dispute(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_cancellation_dispute(UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;

REVOKE ALL ON FUNCTION public.determine_order_stage(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.determine_order_stage(UUID) TO service_role;

-- Permission baru (dipakai UI Human Review order detail nanti).
INSERT INTO public.permissions (name, module, action, description) VALUES
  ('orders.cancellation_review', 'orders', 'cancellation_review', 'Review/resolve order cancellation & dispute requests')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner','manager','admin','super_admin')
  AND p.name = 'orders.cancellation_review'
ON CONFLICT DO NOTHING;
