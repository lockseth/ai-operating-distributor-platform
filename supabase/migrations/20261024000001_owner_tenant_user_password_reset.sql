-- =============================================================================
-- Owner bisa reset password anggota timnya sendiri (admin/manager/sales/
-- driver/finance/warehouse), TANPA perlu super_admin.
--
-- Diminta Founder langsung ("menu reset password all user") setelah
-- ditemukan tidak ada jalur Owner sama sekali -- 3 mekanisme existing
-- (email magic-link legacy, super_admin DB-only reset, Telegram
-- self-service) semuanya TIDAK memungkinkan Owner mereset password
-- anggota timnya sendiri saat orang itu lupa password DAN belum/tidak
-- bisa pairing Telegram.
--
-- Pendekatan: PERLUAS 3 RPC super_admin_*_tenant_user_password_reset
-- (migration 20260913000001 + fix 20260916000001) yang sudah ada dan
-- teruji -- BUKAN membuat RPC/tabel baru. Actor sekarang boleh
-- super_admin (perilaku LAMA tidak berubah sama sekali) ATAU owner aktif
-- (perilaku BARU, dengan batasan tambahan):
--   - Owner HANYA boleh reset target di company_id miliknya sendiri --
--     lintas-tenant dikembalikan 'target_not_found' (BUKAN 'forbidden')
--     supaya tidak membocorkan keberadaan user di tenant lain, konsisten
--     pola cross-tenant existing di seluruh RPC lain project ini.
--   - Owner TIDAK boleh mereset sesama 'owner' (single-owner model,
--     Gate 3D-B1) maupun 'super_admin' (sudah ditolak lebih dulu di jalur
--     existing, tidak berubah) -- outcome 'target_role_not_resettable'.
--   - Selain itu (admin/manager/sales/driver/finance/warehouse) semua
--     boleh, TIDAK dibatasi ke daftar {owner,admin,sales} sempit yang
--     dipakai jalur super_admin lama (jalur super_admin TIDAK diperluas
--     di sini -- kalau mau, itu perubahan terpisah).
--
-- Signature ketiga fungsi TIDAK berubah (CREATE OR REPLACE) -- seluruh
-- app-layer (workflow.ts/repository.ts/actions.ts) TIDAK perlu berubah
-- perilakunya, cukup relaksasi gate actor role di actions.ts.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.super_admin_begin_tenant_user_password_reset(
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
  v_actor_is_super_admin BOOLEAN;
  v_actor_is_owner       BOOLEAN;
  v_actor_company_id     UUID;
  v_target         RECORD;
  v_role_names     TEXT[];
  v_pre_hash       TEXT;
  v_existing_status TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.is_active = TRUE
      AND r.name = 'super_admin'
  ) INTO v_actor_is_super_admin;

  SELECT u.company_id INTO v_actor_company_id
  FROM public.users u WHERE u.id = p_actor_id AND u.is_active = TRUE;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_is_owner;

  IF NOT v_actor_is_super_admin AND NOT v_actor_is_owner THEN
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

  -- Owner (bukan super_admin): target lintas-tenant diperlakukan seolah
  -- tidak ditemukan -- tidak membocorkan keberadaan user tenant lain.
  IF v_actor_is_owner AND NOT v_actor_is_super_admin AND v_target.company_id <> v_actor_company_id THEN
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

  -- Ditolak lebih dulu dan eksplisit sebelum pengecekan allowlist -- pesan
  -- outcome berbeda supaya TS layer/test bisa membedakan "bukan role yang
  -- direset" dari "memang super_admin, dilarang mutlak" (kontrak gate §2).
  IF 'super_admin' = ANY(v_role_names) THEN
    RETURN QUERY SELECT 'target_forbidden_super_admin'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF v_actor_is_owner AND NOT v_actor_is_super_admin THEN
    -- Tier Owner: siapa pun di company sendiri SELAIN owner/super_admin
    -- (super_admin sudah ditolak di atas).
    IF 'owner' = ANY(v_role_names) THEN
      RETURN QUERY SELECT 'target_role_not_resettable'::TEXT, NULL::TEXT, NULL::UUID;
      RETURN;
    END IF;
  ELSE
    -- Tier super_admin: perilaku LAMA, TIDAK diperluas di migration ini.
    IF NOT (v_role_names && ARRAY['owner', 'admin', 'sales']::TEXT[]) THEN
      RETURN QUERY SELECT 'target_role_not_resettable'::TEXT, NULL::TEXT, NULL::UUID;
      RETURN;
    END IF;
  END IF;

  -- Baseline PRA-reset -- lihat catatan header migration soal alasan dua
  -- snapshot. NULL berarti target tidak punya auth.users yang valid (profil
  -- yatim) -- gagal tertutup, tidak pernah mengunci must_change_password
  -- tanpa baseline (akan melanggar CHECK constraint 20260911000001 juga).
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
    -- Bisa dua sebab: (a) operation_id yang SAMA di-retry (network retry) --
    -- idempotent, kembalikan outcome yang sudah tercatat; (b) operation_id
    -- BEDA tapi target_user_id sama sedang in-flight (partial unique index)
    -- -- tolak sebagai konflik konkurensi, bukan diam-diam dianggap sukses.
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

  -- Fail-closed SEBELUM auth password diganti (kontrak gate: "leave the
  -- target fail-closed" berlaku bahkan jika langkah Auth API di TS gagal
  -- SETELAH titik ini -- lihat fail() di bawah, yang SENGAJA tidak
  -- membersihkan flag ini).
  UPDATE public.users
  SET must_change_password = TRUE, provisioned_password_hash = v_pre_hash
  WHERE id = p_target_user_id;

  UPDATE public.tenant_user_password_reset_operations
  SET status = 'db_committed'
  WHERE id = p_operation_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_target.company_id, p_actor_id, 'tenant_user.password_reset_started', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id, 'actor_tier', CASE WHEN v_actor_is_super_admin THEN 'super_admin' ELSE 'owner' END)
  );

  RETURN QUERY SELECT 'db_committed'::TEXT, v_target.email::TEXT, v_target.company_id;
END;
$$;

COMMENT ON FUNCTION public.super_admin_begin_tenant_user_password_reset(UUID, UUID, UUID) IS
  'Tahap DB pertama reset password. Dua tier actor: super_admin (lintas-tenant, target role in {owner,admin,sales}, perilaku LAMA tidak berubah) atau owner aktif (HANYA company sendiri, target role apa pun SELAIN owner/super_admin) -- re-diverifikasi DI DALAM fungsi, tidak pernah dipercaya dari app layer. Mengunci target fail-closed (must_change_password=TRUE, baseline=hash PRA-reset) SEBELUM auth.admin.updateUserById() dipanggil di TS. Idempotent per operation_id, satu operasi in-flight per target (partial unique index). Nama fungsi historis (super_admin_*) dipertahankan apa adanya -- signature tidak berubah supaya app layer existing tidak perlu disentuh.';


CREATE OR REPLACE FUNCTION public.super_admin_finalize_tenant_user_password_reset(
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
  v_actor_is_super_admin BOOLEAN;
  v_actor_is_owner       BOOLEAN;
  v_actor_company_id     UUID;
  v_op            RECORD;
  v_new_hash      TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.is_active = TRUE
      AND r.name = 'super_admin'
  ) INTO v_actor_is_super_admin;

  SELECT u.company_id INTO v_actor_company_id
  FROM public.users u WHERE u.id = p_actor_id AND u.is_active = TRUE;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_is_owner;

  IF NOT v_actor_is_super_admin AND NOT v_actor_is_owner THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT id, status, company_id INTO v_op
  FROM public.tenant_user_password_reset_operations
  WHERE id = p_operation_id AND target_user_id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'operation_not_found'::TEXT;
    RETURN;
  END IF;

  -- Defense-in-depth: owner tidak boleh finalize operasi milik tenant lain
  -- (secara praktis operation_id acak sulit ditebak, tapi tetap dijaga).
  IF v_actor_is_owner AND NOT v_actor_is_super_admin AND v_op.company_id <> v_actor_company_id THEN
    RETURN QUERY SELECT 'operation_not_found'::TEXT;
    RETURN;
  END IF;

  -- Idempotent replay -- retry TS (mis. setelah timeout jaringan pada
  -- response call pertama yang sebenarnya sudah sukses) tidak mengulang
  -- mutasi maupun audit event kedua.
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
    v_op.company_id, p_actor_id, 'tenant_user.password_reset_completed', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id)
  );

  RETURN QUERY SELECT 'succeeded'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.super_admin_finalize_tenant_user_password_reset(UUID, UUID, UUID) IS
  'Tahap DB kedua reset password -- HANYA dipanggil setelah auth.admin.updateUserById() sukses di TS. Actor dua tier sama seperti begin() (super_admin lintas-tenant, owner company sendiri). Idempotent (replay operation_id sukses aman).';


CREATE OR REPLACE FUNCTION public.super_admin_fail_tenant_user_password_reset(
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
  v_actor_is_super_admin BOOLEAN;
  v_actor_is_owner       BOOLEAN;
  v_actor_company_id     UUID;
  v_op            RECORD;
  v_reason        TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.is_active = TRUE
      AND r.name = 'super_admin'
  ) INTO v_actor_is_super_admin;

  SELECT u.company_id INTO v_actor_company_id
  FROM public.users u WHERE u.id = p_actor_id AND u.is_active = TRUE;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_is_owner;

  IF NOT v_actor_is_super_admin AND NOT v_actor_is_owner THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT id, status, company_id INTO v_op
  FROM public.tenant_user_password_reset_operations
  WHERE id = p_operation_id AND target_user_id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'operation_not_found'::TEXT;
    RETURN;
  END IF;

  IF v_actor_is_owner AND NOT v_actor_is_super_admin AND v_op.company_id <> v_actor_company_id THEN
    RETURN QUERY SELECT 'operation_not_found'::TEXT;
    RETURN;
  END IF;

  IF v_op.status <> 'db_committed' THEN
    -- Idempotent no-op -- tidak pernah menimpa status succeeded/failed yang
    -- sudah final.
    RETURN QUERY SELECT v_op.status;
    RETURN;
  END IF;

  v_reason := left(COALESCE(p_reason, 'unknown'), 200);

  UPDATE public.tenant_user_password_reset_operations
  SET status = 'failed', failure_reason = v_reason
  WHERE id = p_operation_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_op.company_id, p_actor_id, 'tenant_user.password_reset_failed', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id, 'reason', v_reason)
  );

  RETURN QUERY SELECT 'failed'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.super_admin_fail_tenant_user_password_reset(UUID, UUID, UUID, TEXT) IS
  'Best-effort: mencatat kegagalan tahap Auth API/finalize. Actor dua tier sama seperti begin()/finalize(). Tidak pernah membersihkan lock fail-closed (must_change_password) yang sudah diset begin().';

-- Signature ketiga fungsi tidak berubah -- REVOKE/GRANT existing
-- (service_role saja) tetap berlaku, tidak perlu diulang.
