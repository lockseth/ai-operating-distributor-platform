-- =============================================================================
-- Gate 3E-D2-B -- Telegram Self-Service Password Reset.
--
-- Kontrak: user (owner|admin|sales) yang SUDAH punya Telegram identity aktif
-- (migration 20260912000001) bisa meminta reset password sendiri lewat bot --
-- capability "password.reset.self" yang sudah direservasi di
-- lib/telegram-enrollment/capability.ts sejak Gate 3E-D1-R1 ("disiapkan
-- supaya P2 tidak perlu mengubah bentuk tabel ini, hanya memakainya").
--
-- REUSE, tidak diubah sama sekali oleh migration ini:
--   - tenant_user_password_reset_operations (migration 20260913000001) --
--     tabel operation record generik, tidak spesifik-super_admin dalam
--     bentuknya (actor_id hanya FK ke public.users) -- dipakai ulang apa
--     adanya, bukan tabel baru.
--   - must_change_password/provisioned_password_hash + complete_mandatory_
--     password_change() (migration 20260911000001) -- finalize() di bawah
--     mengunci flag ini identik pola super_admin_finalize_..., user tetap
--     harus ganti password sebelum dashboard terbuka, tidak ada UI/route baru.
--   - resetTenantUserPassword() (lib/tenant-user-password-reset/workflow.ts)
--     -- orkestrasi begin->generate temp password->update Auth->finalize
--     TIDAK disentuh, actor-agnostic terhadap repository yang dipakai.
--
-- BEDA dari super_admin_*_tenant_user_password_reset() (20260913000001):
-- actor DI SINI SELALU sama dengan target (self-service, bukan operator
-- platform mereset orang lain) -- p_actor_id = p_target_user_id WAJIB
-- persis sama, ditolak forbidden jika tidak. Backstop otorisasi bukan "actor
-- adalah super_admin aktif", melainkan "target punya telegram_identities
-- AKTIF" -- caller (webhook, service_role) HANYA bisa memperoleh
-- target_user_id yang valid lewat resolveIdentity(chatId) di TS (mapping
-- chat_id -> user_id via telegram_identities, migration 20260912000001),
-- tapi RPC ini TETAP re-verifikasi independen di database (tidak pernah
-- mempercayai bahwa TS sudah memeriksa) -- pola identik seluruh RPC
-- SECURITY DEFINER lain di codebase ini (lihat migration 20260911000001,
-- 20260913000001).
--
-- Tiga RPC baru, dipanggil service-role dari app/api/webhooks/telegram/
-- route.ts SETELAH user menekan tombol konfirmasi inline keyboard (bukan
-- langsung dari trigger phrase) -- confirm step ada di application layer,
-- bukan di sini.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- telegram_self_service_begin_password_reset() -- tahap DB pertama, mengunci
-- target fail-closed SEBELUM auth.admin.updateUserById() dipanggil di TS.
-- Backstop: target aktif, role in {owner,admin,sales} (kontrak capability
-- password.reset.self), dan punya SATU telegram_identities is_active=TRUE --
-- tanpa pairing aktif, permintaan ditolak (fail-closed, bukan diam-diam
-- mengizinkan reset untuk akun yang baru saja di-unpair).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.telegram_self_service_begin_password_reset(
  p_operation_id UUID,
  p_actor_id UUID,
  p_target_user_id UUID
)
RETURNS TABLE(result_outcome TEXT, target_email TEXT, target_company_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_target          RECORD;
  v_role_names      TEXT[];
  v_has_active_pair BOOLEAN;
  v_pre_hash        TEXT;
  v_existing_status TEXT;
BEGIN
  IF p_actor_id IS DISTINCT FROM p_target_user_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT id, company_id, email, is_active INTO v_target
  FROM public.users
  WHERE id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'target_not_found'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF NOT v_target.is_active THEN
    RETURN QUERY SELECT 'target_inactive'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(r.name), ARRAY[]::TEXT[]) INTO v_role_names
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_target_user_id;

  IF NOT (v_role_names && ARRAY['owner', 'admin', 'sales']::TEXT[]) THEN
    RETURN QUERY SELECT 'target_role_not_resettable'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.telegram_identities
    WHERE user_id = p_target_user_id AND is_active = TRUE
  ) INTO v_has_active_pair;

  IF NOT v_has_active_pair THEN
    RETURN QUERY SELECT 'not_paired'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT encrypted_password INTO v_pre_hash FROM auth.users WHERE id = p_target_user_id;
  IF v_pre_hash IS NULL THEN
    RETURN QUERY SELECT 'target_auth_missing'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.tenant_user_password_reset_operations (
      id, target_user_id, actor_id, company_id, status
    ) VALUES (
      p_operation_id, p_target_user_id, p_actor_id, v_target.company_id, 'started'
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT status INTO v_existing_status
    FROM public.tenant_user_password_reset_operations
    WHERE id = p_operation_id;

    IF v_existing_status IS NOT NULL THEN
      RETURN QUERY SELECT v_existing_status, v_target.email::TEXT, v_target.company_id;
      RETURN;
    END IF;

    RETURN QUERY SELECT 'already_in_progress'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END;

  UPDATE public.users
  SET must_change_password = TRUE, provisioned_password_hash = v_pre_hash
  WHERE id = p_target_user_id;

  UPDATE public.tenant_user_password_reset_operations
  SET status = 'db_committed'
  WHERE id = p_operation_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_target.company_id, p_actor_id, 'tenant_user.telegram_reset_started',
    'users', p_target_user_id, jsonb_build_object('operation_id', p_operation_id)
  );

  RETURN QUERY SELECT 'db_committed'::TEXT, v_target.email::TEXT, v_target.company_id;
END;
$$;

COMMENT ON FUNCTION public.telegram_self_service_begin_password_reset(UUID, UUID, UUID) IS
  'Gate 3E-D2-B: tahap DB pertama self-service Telegram password reset. p_actor_id WAJIB = p_target_user_id (self-service, ditolak jika beda). Backstop: target aktif, role in {owner,admin,sales}, punya telegram_identities aktif. Mengunci must_change_password=TRUE SEBELUM auth.admin.updateUserById() dipanggil di TS -- identik pola super_admin_begin_tenant_user_password_reset (20260913000001), reuse tabel operations yang sama.';

REVOKE ALL ON FUNCTION public.telegram_self_service_begin_password_reset(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_self_service_begin_password_reset(UUID, UUID, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- telegram_self_service_finalize_password_reset() -- tahap DB kedua, SETELAH
-- auth.admin.updateUserById() sukses di TS. Pola identik super_admin_
-- finalize_tenant_user_password_reset() (20260913000001), actor check diganti
-- self-service (p_actor_id = p_target_user_id).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.telegram_self_service_finalize_password_reset(
  p_operation_id UUID,
  p_actor_id UUID,
  p_target_user_id UUID
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_op       RECORD;
  v_new_hash TEXT;
BEGIN
  IF p_actor_id IS DISTINCT FROM p_target_user_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT id, status INTO v_op
  FROM public.tenant_user_password_reset_operations
  WHERE id = p_operation_id AND target_user_id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'operation_not_found'::TEXT;
    RETURN;
  END IF;

  IF v_op.status = 'succeeded' THEN
    RETURN QUERY SELECT 'succeeded'::TEXT;
    RETURN;
  END IF;

  IF v_op.status <> 'db_committed' THEN
    RETURN QUERY SELECT 'invalid_state'::TEXT;
    RETURN;
  END IF;

  SELECT encrypted_password INTO v_new_hash FROM auth.users WHERE id = p_target_user_id;
  IF v_new_hash IS NULL THEN
    RETURN QUERY SELECT 'target_auth_missing'::TEXT;
    RETURN;
  END IF;

  UPDATE public.users
  SET must_change_password = TRUE, provisioned_password_hash = v_new_hash
  WHERE id = p_target_user_id;

  UPDATE public.tenant_user_password_reset_operations
  SET status = 'succeeded'
  WHERE id = p_operation_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    (SELECT company_id FROM public.tenant_user_password_reset_operations WHERE id = p_operation_id),
    p_actor_id, 'tenant_user.telegram_reset_completed', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id)
  );

  RETURN QUERY SELECT 'succeeded'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.telegram_self_service_finalize_password_reset(UUID, UUID, UUID) IS
  'Gate 3E-D2-B: tahap DB kedua, dipanggil HANYA setelah auth.admin.updateUserById() sukses. Identik super_admin_finalize_tenant_user_password_reset (20260913000001), actor check self-service.';

REVOKE ALL ON FUNCTION public.telegram_self_service_finalize_password_reset(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_self_service_finalize_password_reset(UUID, UUID, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- telegram_self_service_fail_password_reset() -- dicatat ketika
-- auth.admin.updateUserById() gagal setelah begin() sukses. TIDAK PERNAH
-- membersihkan must_change_password/provisioned_password_hash yang sudah
-- diset begin() -- pola identik super_admin_fail_tenant_user_password_reset.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.telegram_self_service_fail_password_reset(
  p_operation_id UUID,
  p_actor_id UUID,
  p_target_user_id UUID,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_op     RECORD;
  v_reason TEXT;
BEGIN
  IF p_actor_id IS DISTINCT FROM p_target_user_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT id, status INTO v_op
  FROM public.tenant_user_password_reset_operations
  WHERE id = p_operation_id AND target_user_id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'operation_not_found'::TEXT;
    RETURN;
  END IF;

  IF v_op.status <> 'db_committed' THEN
    RETURN QUERY SELECT v_op.status;
    RETURN;
  END IF;

  v_reason := left(COALESCE(p_reason, 'unknown'), 200);

  UPDATE public.tenant_user_password_reset_operations
  SET status = 'failed', failure_reason = v_reason
  WHERE id = p_operation_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    (SELECT company_id FROM public.tenant_user_password_reset_operations WHERE id = p_operation_id),
    p_actor_id, 'tenant_user.telegram_reset_failed', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id, 'reason', v_reason)
  );

  RETURN QUERY SELECT 'failed'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.telegram_self_service_fail_password_reset(UUID, UUID, UUID, TEXT) IS
  'Gate 3E-D2-B: mencatat kegagalan tahap Auth API (sanitized) tanpa pernah membersihkan fail-closed lock yang diset begin(). Identik super_admin_fail_tenant_user_password_reset (20260913000001), actor check self-service.';

REVOKE ALL ON FUNCTION public.telegram_self_service_fail_password_reset(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telegram_self_service_fail_password_reset(UUID, UUID, UUID, TEXT)
  TO service_role;
