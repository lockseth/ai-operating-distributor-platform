-- =============================================================================
-- FlowSales Daily Operating Loop -- 4-Blocker Targeted Closure (forward-fix,
-- additive only). Menutup Blocker 1 (active-visit close blocker) dan
-- Blocker 2 (sales_orders.confirmed_at authoritative). Tidak mengedit
-- 20260810000001-000003 yang sudah diterapkan lokal -- close_daily_session
-- di-CREATE OR REPLACE ulang (Postgres tidak punya "patch" fungsi parsial).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- BLOCKER 1: active-visit close blocker.
--
-- Sumber "visit sedang berlangsung" = telegram_menu_conversation_state milik
-- identity aktif salesman pemilik session, awaiting salah satu dari 4 state
-- sub-flow Mulai Kunjungan (lihat lib/telegram-menu/conversation.ts:
-- MenuAwaiting). TIDAK membuat ledger visit baru -- murni membaca state
-- percakapan yang sudah ada. result_outcome 'blocked_open_visits' (sudah
-- ada di kontrak RPC sejak Phase 1) sekarang benar-benar bisa dikembalikan.
--
-- Urutan blocker: visit aktif diperiksa SEBELUM delivery non-terminal --
-- keduanya independen dan sama-sama memblokir (union), bukan urutan
-- prioritas; visit diperiksa lebih dulu karena representasi "kamu sedang di
-- tengah kunjungan" lebih langsung actionable bagi salesman.
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
  v_active_visit BOOLEAN;
  v_open_deliveries INTEGER;
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

  -- Blocker: visit sedang berlangsung (state percakapan Telegram identity
  -- AKTIF milik salesman pemilik session ini SAJA -- tenant/salesman lain
  -- tidak pernah ikut diperiksa karena di-scope company_id + user_id).
  SELECT EXISTS (
    SELECT 1
    FROM public.telegram_identities ti
    JOIN public.telegram_menu_conversation_state tmcs ON tmcs.telegram_identity_id = ti.id
    WHERE ti.company_id = p_company_id
      AND ti.user_id = v_session.salesman_id
      AND ti.is_active = TRUE
      AND tmcs.awaiting IN (
        'visit_store_select', 'visit_pic_select', 'visit_outcome_notes', 'visit_order_link_confirm'
      )
  ) INTO v_active_visit;

  IF v_active_visit THEN
    RETURN QUERY SELECT 'blocked_open_visits'::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_open_deliveries
  FROM public.deliveries d
  WHERE d.company_id = p_company_id
    AND d.assigned_driver_id = v_session.salesman_id
    AND d.status NOT IN ('fully_received', 'partially_received', 'rejected', 'store_closed', 'failed', 'verified');

  IF v_open_deliveries > 0 THEN
    RETURN QUERY SELECT 'blocked_open_deliveries'::TEXT;
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

REVOKE ALL ON FUNCTION public.close_daily_session(UUID, UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_daily_session(UUID, UUID, UUID, JSONB)
  TO service_role;

-- ---------------------------------------------------------------------------
-- BLOCKER 2: sales_orders.confirmed_at -- additive, authoritative.
--
-- Trigger (bukan default value/app-side write) supaya berlaku untuk SEMUA
-- jalur yang pernah/akan mengubah status ke 'confirmed' (draft->confirmed
-- di repository.ts, insert langsung status='confirmed' untuk kasus lain)
-- tanpa perlu menyisipkan write eksplisit di banyak tempat -- pola sama
-- dengan credit_effective_call_for_order (20260805000001).
--
-- Aturan:
--   1. Diisi HANYA saat transisi PERTAMA KALI ke 'confirmed' (INSERT dengan
--      status='confirmed', ATAU UPDATE dari status lain menjadi 'confirmed').
--   2. is_historical=TRUE TIDAK PERNAH diisi otomatis -- order historis yang
--      diimpor sudah berstatus 'confirmed' tanpa kita tahu kapan sungguhan
--      dikonfirmasi; mengisi NOW() akan mengarang timestamp palsu.
--   3. Setelah terisi, immutable selamanya -- UPDATE apa pun (termasuk
--      cancel/reversal atau re-confirm) tidak pernah mengubah/menghapusnya.
--   4. Tidak menyentuh trg_sales_orders_credit_ec/reverse_ec sama sekali --
--      trigger ini murni menulis kolom baru, tidak membaca/mengubah status
--      logic Call/EC yang sudah PASS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sales_orders.confirmed_at IS
  'Diisi otomatis oleh trg_sales_orders_set_confirmed_at HANYA saat transisi pertama kali ke status=confirmed (bukan historical import). Immutable setelah terisi -- authoritative untuk "order confirmed hari ini" (End-of-Day Summary), menggantikan created_at::date.';

CREATE OR REPLACE FUNCTION public.set_sales_order_confirmed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.confirmed_at IS NOT NULL THEN
    -- Sudah pernah terisi -- immutable, tidak pernah ditimpa oleh update apa pun.
    NEW.confirmed_at := OLD.confirmed_at;
    RETURN NEW;
  END IF;

  IF NEW.status = 'confirmed'
     AND NOT NEW.is_historical
     AND NEW.confirmed_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed')
  THEN
    NEW.confirmed_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_set_confirmed_at
  BEFORE INSERT OR UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_sales_order_confirmed_at();
