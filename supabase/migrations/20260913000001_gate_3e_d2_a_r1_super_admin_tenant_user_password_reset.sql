-- =============================================================================
-- Gate 3E-D2-A-R1 -- Secure Super Admin Tenant-User Password Reset.
--
-- Kontrak: super_admin (operator platform, TIDAK tenant-scoped) mereset
-- password user tenant EXISTING (owner|admin|sales, aktif, bukan super_admin)
-- dengan temporary password server-generated + mandatory-password-change
-- (kolom must_change_password/provisioned_password_hash, migration
-- 20260911000001 -- TIDAK diubah/diduplikasi di sini, dipakai ulang apa
-- adanya). Berbeda dari 20260911000001 (provision_owner_created_tenant_user,
-- INSERT user BARU): migration ini UPDATE user yang SUDAH ADA, dan actor-nya
-- super_admin (bukan owner), maka RPC baru, bukan reuse.
--
-- Auth Admin API (GoTrue) dan Postgres adalah DUA sistem terpisah -- tidak
-- ada satu transaksi ACID yang mencakup keduanya (lihat brief gate). Maka
-- orkestrasi dipecah TS-side (lib/tenant-user-password-reset/workflow.ts)
-- dengan urutan: (1) RPC begin() mengunci target + set must_change_password
-- TRUE fail-closed SEBELUM auth password diganti, (2)
-- auth.admin.updateUserById() mengganti password sungguhan, (3) RPC
-- finalize() memperbarui baseline hash SETELAH auth sukses. Jika (2)/(3)
-- gagal, RPC fail() mencatat outcome gagal ter-sanitasi -- target TETAP
-- fail-closed (must_change_password tetap TRUE, baseline = hash PRA-reset,
-- yang berarti password LAMA target masih berfungsi untuk login lalu
-- diarahkan ke /reset-password mandatory-change yang sudah ada -- pemulihan
-- aman tanpa pernah mengekspos password baru yang gagal ter-commit).
--
-- Baseline hash SENGAJA di-snapshot DUA KALI (sebelum di begin(), sesudah di
-- finalize()) -- bukan sekali seperti provision_owner_created_tenant_user()
-- -- karena RPC ini berjalan SEBELUM auth password diganti (kontrak gate:
-- "database-stage failure MUST prevent Auth mutation"), sehingga hash yang
-- tersedia saat begin() adalah hash LAMA, bukan hash temporary password yang
-- baru. Snapshot pertama (begin) mengunci akses (fail-closed) sedini
-- mungkin; snapshot kedua (finalize) memperbaiki baseline supaya
-- complete_mandatory_password_change() (20260911000001) sungguh membanding-
-- kan terhadap hash password SEMENTARA yang benar -- bukan hash lama, yang
-- kalau dibiarkan akan langsung berbeda dari hash baru pasca auth update dan
-- keliru dianggap "sudah diganti user" padahal baru diganti oleh reset ini.
--
-- Session revocation: SDK terpasang (@supabase/auth-js 2.108.2, diperiksa
-- langsung dari node_modules/.pnpm/@supabase+auth-js@2.108.2/.../
-- GoTrueAdminApi.d.ts) HANYA mengekspos admin.signOut(jwt, scope) -- JWT
-- sesi yang valid, BUKAN user id. Tidak ada admin.signOut(userId) ataupun
-- admin.listUserSessions()/admin.revokeSessions(userId) pada versi ini.
-- Maka TIDAK ADA mekanisme terdokumentasi untuk memaksa invalidasi sesi
-- target secara instan lewat Admin API -- tidak diimprovisasi di sini
-- (lihat lib/tenant-user-password-reset/workflow.ts untuk dokumentasi
-- eksplisit dan test yang membuktikan hal ini). Perlindungan sungguhan
-- datang dari must_change_password: get-user.ts memeriksa flag ini pada
-- SETIAP request (bukan hanya saat login), jadi sesi lama yang masih punya
-- access-token JWT valid TETAP diblokir dari seluruh dashboard/server action
-- begitu begin() commit -- terlepas dari apakah JWT itu sendiri sudah
-- kedaluwarsa atau belum.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. tenant_user_password_reset_operations -- catatan non-secret + idempotency
-- key per operasi reset (kontrak gate langkah 3). Partial unique index pada
-- target_user_id (hanya utk status 'started'/'db_committed') memastikan
-- HANYA SATU reset in-flight per target di level database -- submit ganda
-- (double-click atau retry konkuren) pada target yang sama akan gagal
-- unique_violation di dalam begin(), ditangkap dan dikembalikan sebagai
-- outcome 'already_in_progress' (bukan mengizinkan dua reset berjalan
-- paralel pada satu target, yang bisa membuat baseline hash saling
-- menimpa). Retry dengan operation_id yang SAMA (network retry, bukan
-- double-click baru) tetap idempotent -- begin() mengembalikan outcome yang
-- sudah tersimpan tanpa mengulang mutasi.
--
-- Tabel baru otomatis kena ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES
-- TO anon, authenticated (20260707000003) -- REVOKE ALL eksplisit di bawah
-- WAJIB, sama seperti alasan lockdown must_change_password di
-- 20260911000001. Tidak ada RLS policy ditulis (bukan lubang) -- REVOKE
-- level tabel dari anon/authenticated berarti privilege = nol terlepas dari
-- kebijakan RLS apa pun; ENABLE ROW LEVEL SECURITY tetap diaktifkan sebagai
-- pertahanan berlapis (default-deny bagi role manapun yang suatu saat
-- diberi privilege tabel tanpa policy eksplisit). service_role (dipakai
-- RPC SECURITY DEFINER + repository.ts) selalu bypass RLS.
-- ---------------------------------------------------------------------------

CREATE TABLE public.tenant_user_password_reset_operations (
  id             UUID        PRIMARY KEY,
  target_user_id UUID        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  actor_id       UUID        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  company_id     UUID        NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  status         TEXT        NOT NULL CHECK (status IN ('started', 'db_committed', 'succeeded', 'failed')),
  failure_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenant_user_password_reset_operations_target_inflight
  ON public.tenant_user_password_reset_operations (target_user_id)
  WHERE status IN ('started', 'db_committed');

CREATE INDEX idx_tenant_user_password_reset_operations_target
  ON public.tenant_user_password_reset_operations (target_user_id);

ALTER TABLE public.tenant_user_password_reset_operations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tenant_user_password_reset_operations FROM anon, authenticated;

CREATE TRIGGER trg_tenant_user_password_reset_operations_updated_at
  BEFORE UPDATE ON public.tenant_user_password_reset_operations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.tenant_user_password_reset_operations IS
  'Gate 3E-D2-A-R1: operation record + idempotency key untuk super_admin_*_tenant_user_password_reset() RPCs. Non-secret -- tidak pernah menyimpan password/hash. Hanya diakses lewat RPC SECURITY DEFINER (service_role), tidak pernah lewat PostgREST authenticated/anon (REVOKE ALL eksplisit).';

-- ---------------------------------------------------------------------------
-- 2. super_admin_begin_tenant_user_password_reset() -- dipanggil service-role
-- SEBELUM auth.admin.updateUserById(). Re-verifikasi actor (super_admin
-- aktif) dan target (ada, aktif, role in {owner,admin,sales}, BUKAN
-- super_admin) DI DALAM RPC -- database sebagai authorization backstop,
-- pola identik provision_owner_created_tenant_user() (20260911000001).
--
-- FOR UPDATE pada baris target mengunci row selama transaksi RPC ini --
-- bersama partial unique index di atas, ini adalah pertahanan konkurensi
-- ganda: row lock mencegah race READ-then-WRITE pada is_active/role dalam
-- transaksi ini sendiri, unique index mencegah operasi PARALEL (transaksi
-- lain) pada target yang sama.
-- ---------------------------------------------------------------------------

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
      RETURN QUERY SELECT v_existing_status, v_target.email, v_target.company_id;
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

  RETURN QUERY SELECT 'db_committed'::TEXT, v_target.email, v_target.company_id;
END;
$$;

COMMENT ON FUNCTION public.super_admin_begin_tenant_user_password_reset(UUID, UUID, UUID) IS
  'Gate 3E-D2-A-R1: tahap DB pertama reset password super_admin -- re-verifikasi actor (super_admin aktif) dan target (aktif, role in {owner,admin,sales}, bukan super_admin) DI DALAM fungsi. Mengunci target fail-closed (must_change_password=TRUE, baseline=hash PRA-reset) SEBELUM auth.admin.updateUserById() dipanggil di TS -- kegagalan Auth API sesudah titik ini tidak pernah meninggalkan target dalam keadaan tanpa proteksi. Idempotent per operation_id, satu operasi in-flight per target (partial unique index).';

REVOKE ALL ON FUNCTION public.super_admin_begin_tenant_user_password_reset(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_begin_tenant_user_password_reset(UUID, UUID, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. super_admin_finalize_tenant_user_password_reset() -- dipanggil
-- service-role SETELAH auth.admin.updateUserById() sukses. Memperbarui
-- baseline hash ke hash password SEMENTARA yang baru (lihat catatan header)
-- dan menegaskan ulang must_change_password=TRUE (idempotent, aman meski
-- flag sudah TRUE). Re-set eksplisit (bukan hanya UPDATE baseline) menutup
-- celah race langka: jika target sempat mengganti password sendiri lewat
-- complete_mandatory_password_change() di antara begin() dan titik ini
-- (baseline lama != hash saat itu -> flag sempat ke-clear), finalize()
-- mengunci ulang dengan baseline BARU -- tidak pernah membiarkan reset
-- admin ini diam-diam terlewati tanpa mandatory-change berikutnya.
-- ---------------------------------------------------------------------------

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
  v_actor_allowed BOOLEAN;
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
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
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
    (SELECT company_id FROM public.tenant_user_password_reset_operations WHERE id = p_operation_id),
    p_actor_id, 'tenant_user.password_reset_completed', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id)
  );

  RETURN QUERY SELECT 'succeeded'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.super_admin_finalize_tenant_user_password_reset(UUID, UUID, UUID) IS
  'Gate 3E-D2-A-R1: tahap DB kedua, dipanggil HANYA setelah auth.admin.updateUserById() sukses. Menyegarkan provisioned_password_hash ke hash password sementara yang baru (bukti pembanding untuk complete_mandatory_password_change() berikutnya) dan menegaskan ulang must_change_password=TRUE. Idempotent per operation_id (status succeeded/db_committed/lainnya dibedakan eksplisit).';

REVOKE ALL ON FUNCTION public.super_admin_finalize_tenant_user_password_reset(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_finalize_tenant_user_password_reset(UUID, UUID, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 4. super_admin_fail_tenant_user_password_reset() -- dipanggil service-role
-- ketika auth.admin.updateUserById() GAGAL (atau exception tak terduga
-- lain) setelah begin() sukses. TIDAK PERNAH membersihkan must_change_
-- password/provisioned_password_hash yang sudah diset begin() -- target
-- tetap fail-closed dengan baseline = hash PRA-reset, yang berarti password
-- LAMA target (tidak berubah, karena auth mutation gagal) masih valid untuk
-- login, lalu diarahkan ke /reset-password (mandatory-change existing) --
-- pemulihan aman lewat self-service, bukan lockout permanen. p_reason WAJIB
-- string statis dari TS (mis. "auth_update_failed"), TIDAK PERNAH pesan
-- error mentah/message provider -- lihat lib/tenant-user-password-reset/
-- workflow.ts.
-- ---------------------------------------------------------------------------

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
  v_actor_allowed BOOLEAN;
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
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
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
    (SELECT company_id FROM public.tenant_user_password_reset_operations WHERE id = p_operation_id),
    p_actor_id, 'tenant_user.password_reset_failed', 'users', p_target_user_id,
    jsonb_build_object('operation_id', p_operation_id, 'reason', v_reason)
  );

  RETURN QUERY SELECT 'failed'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.super_admin_fail_tenant_user_password_reset(UUID, UUID, UUID, TEXT) IS
  'Gate 3E-D2-A-R1: mencatat kegagalan tahap Auth API (sanitized, tanpa secret) tanpa pernah membersihkan fail-closed lock yang diset begin() -- target tetap wajib ganti password (dengan password LAMA-nya sendiri) sebelum bisa mengakses dashboard lagi.';

REVOKE ALL ON FUNCTION public.super_admin_fail_tenant_user_password_reset(UUID, UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_fail_tenant_user_password_reset(UUID, UUID, UUID, TEXT)
  TO service_role;
