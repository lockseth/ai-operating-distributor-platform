-- =============================================================================
-- Gate 3E-D2-A-R4 -- Corrective Migration: super_admin_begin_tenant_user_
-- password_reset() email cast fix (PostgreSQL 42804).
--
-- Defect terbukti (runtime): fungsi (migration 20260913000001) mendeklarasikan
-- RETURNS TABLE(result_outcome TEXT, target_email TEXT, target_company_id UUID),
-- tapi public.users.email bertipe VARCHAR(255) -- dua jalur RETURN QUERY
-- mengembalikan v_target.email TANPA cast eksplisit ke TEXT:
--   1. baris sukses utama (status 'db_committed' baru, akhir fungsi);
--   2. baris idempotent-replay (unique_violation pada operation_id yang SAMA,
--      RETURN QUERY v_existing_status, v_target.email, ...).
-- PostgreSQL TIDAK melakukan implicit cast VARCHAR->TEXT pada RETURN QUERY
-- dari RECORD field ke kolom OUT TEXT dalam kasus ini -- gagal fail-closed
-- dengan error 42804 (structure of query does not match function result
-- type) pada KEDUA jalur di atas. Jalur lain yang mengembalikan target_email
-- sudah eksplisit NULL::TEXT (literal typed), tidak terdampak.
--
-- Perbaikan MINIMAL: CREATE OR REPLACE FUNCTION dengan signature, re-
-- verifikasi actor/target, state machine (started/db_committed/succeeded/
-- failed), row lock FOR UPDATE, partial-unique-index idempotency guard,
-- audit_logs action, SECURITY DEFINER, dan SET search_path IDENTIK dengan
-- 20260913000001 -- satu-satunya perubahan semantik adalah menambahkan
-- `::TEXT` pada v_target.email di kedua RETURN QUERY di atas. Migration
-- 20260913000001 TIDAK diedit (historical, hosted sudah menjalankannya) --
-- CREATE OR REPLACE di sini menimpa definisi fungsi in-place, privilege GRANT/
-- REVOKE existing pada fungsi ini TETAP berlaku (tidak direset oleh CREATE OR
-- REPLACE selama signature parameter tidak berubah), maka tidak diulang di
-- sini.
--
-- Fungsi finalize()/fail() (migration sama) TIDAK mengembalikan email sama
-- sekali (RETURNS TABLE(result_outcome TEXT) saja) -- tidak terdampak defect
-- ini, tidak disentuh oleh migration ini.
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
  v_actor_allowed  BOOLEAN;
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
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
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

  -- Ditolak lebih dulu dan eksplisit sebelum pengecekan allowlist -- pesan
  -- outcome berbeda supaya TS layer/test bisa membedakan "bukan role yang
  -- direset" dari "memang super_admin, dilarang mutlak" (kontrak gate §2).
  IF 'super_admin' = ANY(v_role_names) THEN
    RETURN QUERY SELECT 'target_forbidden_super_admin'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF NOT (v_role_names && ARRAY['owner', 'admin', 'sales']::TEXT[]) THEN
    RETURN QUERY SELECT 'target_role_not_resettable'::TEXT, NULL::TEXT, NULL::UUID;
    RETURN;
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
      -- Gate 3E-D2-A-R4: cast eksplisit -- v_target.email adalah VARCHAR(255),
      -- kolom OUT target_email adalah TEXT (lihat header defect di atas).
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
    jsonb_build_object('operation_id', p_operation_id)
  );

  -- Gate 3E-D2-A-R4: cast eksplisit -- lihat catatan header defect di atas.
  RETURN QUERY SELECT 'db_committed'::TEXT, v_target.email::TEXT, v_target.company_id;
END;
$$;

COMMENT ON FUNCTION public.super_admin_begin_tenant_user_password_reset(UUID, UUID, UUID) IS
  'Gate 3E-D2-A-R1 (corrected by 3E-D2-A-R4): tahap DB pertama reset password super_admin -- re-verifikasi actor (super_admin aktif) dan target (aktif, role in {owner,admin,sales}, bukan super_admin) DI DALAM fungsi. Mengunci target fail-closed (must_change_password=TRUE, baseline=hash PRA-reset) SEBELUM auth.admin.updateUserById() dipanggil di TS -- kegagalan Auth API sesudah titik ini tidak pernah meninggalkan target dalam keadaan tanpa proteksi. Idempotent per operation_id, satu operasi in-flight per target (partial unique index). R4: target_email di-cast eksplisit VARCHAR->TEXT pada jalur sukses dan idempotent-replay untuk menghindari PostgreSQL 42804.';
