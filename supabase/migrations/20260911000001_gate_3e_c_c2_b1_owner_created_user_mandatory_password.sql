-- =============================================================================
-- Gate 3E-C-C2-B1 -- Owner-Created Tenant User Backend & Mandatory Password
-- Change Contract.
--
-- Kontrak existing yang diperluas: docs/product/auth/
-- AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md §5.B ("Owner adds user
-- (admin | sales) -- partially built, role-restricted"). Sales-only path
-- (createSalesmanAction / salesman/workflow.ts, TIDAK disentuh migration ini)
-- tetap seperti sebelumnya -- migration ini menambah jalur BARU, generik
-- untuk {admin, sales}, tanpa wilayah kerja (out of scope gate ini), dengan
-- kontrak baru: mandatory password change untuk user yang baru dibuat owner.
--
-- Dua bagian:
--   (1) public.users.must_change_password + provisioned_password_hash --
--       state mandatory-password-change, dengan proteksi column-level supaya
--       user tidak bisa membersihkan flag-nya sendiri lewat direct REST
--       (users_self_update RLS policy, 20260626000004_rls_policies.sql:91-92,
--       TIDAK punya WITH CHECK terpisah -- authenticated bisa PATCH kolom
--       APA PUN pada baris miliknya sendiri hari ini kecuali diblokir di
--       level privilege kolom, bukan RLS).
--   (2) Dua RPC SECURITY DEFINER:
--       - provision_owner_created_tenant_user(): dipanggil service-role
--         (setelah admin.createUser() sukses di TS), insert profile + role +
--         snapshot hash password sementara dalam SATU transaksi.
--       - complete_mandatory_password_change(): dipanggil sesi user sendiri
--         (auth.uid()), membersihkan flag HANYA bila auth.users.encrypted_
--         password sungguh berbeda dari snapshot yang direkam saat provisioning
--         -- bukti password sudah benar-benar diganti, bukan klaim client.
--
-- Tidak ada UI baru, tidak ada route baru -- /reset-password (existing,
-- reset-password-form.tsx, TIDAK diubah) dipakai ulang sebagai halaman
-- mandatory-password-change (lihat perbaikan middleware.ts terpisah pada
-- commit yang sama, dan self-heal di get-user.ts). Password sementara tidak
-- pernah disimpan plaintext -- provisioned_password_hash adalah salinan hash
-- bcrypt yang SUDAH ada di auth.users.encrypted_password (Supabase Auth
-- sendiri yang meng-hash), murni untuk perbandingan "apakah sudah diganti",
-- tidak pernah dibaca/ditulis ulang menjadi password.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Kolom state mandatory-password-change.
--
-- Default FALSE/NULL -- aditif murni, tidak mengubah baris existing (demo
-- accounts, first-owner via provision_first_owner(), sales via
-- createSalesmanAction lama semuanya tetap must_change_password = FALSE,
-- tidak ada regresi perilaku).
--
-- CHECK constraint: must_change_password = TRUE WAJIB disertai
-- provisioned_password_hash IS NOT NULL -- mencegah state "flag aktif tapi
-- tidak ada baseline untuk dibandingkan", yang akan mengunci user itu secara
-- permanen (complete_mandatory_password_change() tidak akan pernah punya
-- cara membuktikan perubahan password). Baseline dibersihkan (NULL) tepat
-- saat flag di-clear -- tidak pernah disimpan lebih lama dari yang perlu.
-- ---------------------------------------------------------------------------

ALTER TABLE public.users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.users
  ADD COLUMN provisioned_password_hash TEXT;

ALTER TABLE public.users
  ADD CONSTRAINT users_must_change_password_requires_baseline
  CHECK (
    (must_change_password = FALSE)
    OR (must_change_password = TRUE AND provisioned_password_hash IS NOT NULL)
  );

COMMENT ON COLUMN public.users.must_change_password IS
  'Gate 3E-C-C2-B1: TRUE untuk user yang baru dibuat owner dengan temporary password -- seluruh akses dashboard/server action ditolak (get-user.ts) sampai password sungguh diganti (dibuktikan via complete_mandatory_password_change()). Tidak pernah TRUE untuk first-owner (provision_first_owner) atau sales lama (createSalesmanAction) -- keduanya tidak menyentuh kolom ini, tetap default FALSE.';
COMMENT ON COLUMN public.users.provisioned_password_hash IS
  'Snapshot auth.users.encrypted_password pada saat must_change_password diset TRUE -- satu-satunya bukti yang dipercaya bahwa password BELUM/SUDAH diganti (dibandingkan ulang oleh complete_mandatory_password_change()). Bukan password, tidak pernah di-decode -- hanya dibandingkan byte-for-byte. NULL setelah flag dibersihkan.';

-- ---------------------------------------------------------------------------
-- Column-level privilege lockdown -- lebih kuat dari RLS untuk kasus ini.
-- users_self_update (migration 004) mengizinkan authenticated meng-UPDATE
-- SEMBARANG kolom pada baris miliknya sendiri (USING id = auth.uid(), tanpa
-- WITH CHECK terpisah). Tanpa mengunci kolom ini, seorang user bisa langsung
-- PATCH /rest/v1/users?id=eq.<self> { must_change_password: false } memakai
-- anon-key JWT miliknya sendiri -- bypass total terhadap gate ini tanpa
-- pernah benar-benar mengganti password.
--
-- PENTING (dibuktikan lewat introspeksi live terhadap docker lokal, bukan
-- asumsi dokumentasi Postgres semata): `REVOKE UPDATE (kolom) ON tabel FROM
-- role` TIDAK berpengaruh apa pun bila role tsb sudah punya UPDATE level
-- TABEL (skema privilege kolom vs tabel di Postgres bersifat aditif, bukan
-- lebih-spesifik-menang) -- dan `authenticated`/`anon` MEMANG sudah punya
-- UPDATE+SELECT level tabel penuh atas public.users lewat
-- `GRANT ALL ON ALL TABLES IN SCHEMA public` (migration
-- 20260707000003_grant_schema_privileges.sql). Maka satu-satunya cara yang
-- benar-benar bekerja adalah: REVOKE level TABEL dulu (mencabut akses ke
-- SEMUA kolom), lalu GRANT ulang level KOLOM hanya untuk kolom yang memang
-- boleh diakses -- bukan sebaliknya. Ini TIDAK mempersempit kolom lain
-- (company_id, email, full_name, avatar_url, phone, is_active, created_at,
-- updated_at, id) dari privilege efektifnya sebelum migration ini -- hanya
-- must_change_password dan provisioned_password_hash yang dikecualikan dari
-- UPDATE; provisioned_password_hash JUGA dikecualikan dari SELECT (tidak ada
-- alasan sah bagi client membaca hash bcrypt ini -- mengurangi permukaan
-- brute-force offline meskipun bcrypt lambat). RLS (users_company_select,
-- users_self_update, users_manager_update/insert) tidak diubah sama sekali --
-- perbaikan ini murni di layer privilege kolom, lapisan tambahan DI ATAS RLS
-- yang sudah ada. service_role tidak disentuh (tetap ALL, tidak pernah lewat
-- PostgREST authenticated/anon role).
-- ---------------------------------------------------------------------------

REVOKE SELECT, UPDATE ON public.users FROM authenticated, anon;

GRANT SELECT (
  id, company_id, email, full_name, avatar_url, phone, is_active,
  created_at, updated_at, must_change_password
) ON public.users TO authenticated, anon;

GRANT UPDATE (
  id, company_id, email, full_name, avatar_url, phone, is_active,
  created_at, updated_at
) ON public.users TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. provision_owner_created_tenant_user() -- dipanggil service-role SETELAH
-- admin.createUser() sukses di TS (auth.users row sudah ada di LUAR transaksi
-- ini, pola identik provision_first_owner()/createSalesman() -- RPC ini TIDAK
-- PERNAH membuat/menghapus auth.users, itu tanggung jawab TS repository yang
-- juga melakukan compensating delete bila RPC ini gagal/exception).
--
-- Actor re-verification DI DALAM RPC (bukan hanya di actions.ts) mengikuti
-- pola assign_salesman_coverage_areas/set_salesman_active_status (migration
-- 20260814000001/20260815000001) -- caller service-role bypass RLS, jadi
-- database wajib jadi backstop otorisasi sendiri (kontrak §4 Gate 3D-A:
-- "Database (RLS + SECURITY DEFINER RPCs) -- the actual authorization
-- backstop"), bukan sekadar mempercayai bahwa actions.ts sudah memeriksa.
--
-- Role allowlist memakai ULANG public.is_tenant_assignable_role() yang sudah
-- ada (Gate 3E-C-B0-S1, migration 20260909000001) -- TIDAK didefinisikan
-- ulang, satu sumber kebenaran untuk "role apa yang boleh di-assign owner"
-- baik lewat direct REST (RLS user_roles_insert) maupun lewat RPC ini.
-- owner/super_admin/role lain SELALU ditolak oleh helper yang sama.
--
-- Snapshot password hash dibaca dari auth.users (readable karena SECURITY
-- DEFINER berjalan sebagai postgres, sama seperti provision_first_owner()
-- membaca auth.users.email) -- TIDAK ADA cara lain untuk RPC ini menerima
-- hash dari parameter (PostgREST tidak mengekspos schema auth ke client
-- manapun, termasuk service-role -- lihat supabase/config.toml
-- `schemas = ["public", "graphql_public"]`), sehingga snapshot ini SELALU
-- berasal dari nilai yang benar-benar tersimpan di Supabase Auth, tidak
-- pernah bisa dipalsukan oleh parameter caller.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.provision_owner_created_tenant_user(
  p_actor_id UUID,
  p_company_id UUID,
  p_user_id UUID,
  p_role_id UUID,
  p_full_name TEXT,
  p_email TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_role_allowed BOOLEAN;
  v_full_name TEXT;
  v_phone TEXT;
  v_password_hash TEXT;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  v_role_allowed := public.is_tenant_assignable_role(p_role_id, p_company_id);
  IF NOT v_role_allowed THEN
    RETURN QUERY SELECT 'invalid_role'::TEXT;
    RETURN;
  END IF;

  v_full_name := btrim(COALESCE(p_full_name, ''));
  v_phone     := NULLIF(btrim(COALESCE(p_phone, '')), '');

  IF length(v_full_name) < 2 OR length(v_full_name) > 255 THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;

  IF v_phone IS NOT NULL AND length(v_phone) > 50 THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;

  IF p_email IS NULL OR length(btrim(p_email)) = 0 THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT;
    RETURN;
  END IF;

  -- Bukti "password sementara" yang sungguh tercatat di Supabase Auth --
  -- bukan parameter, tidak bisa dipalsukan (lihat catatan di atas).
  SELECT encrypted_password INTO v_password_hash
  FROM auth.users WHERE id = p_user_id;

  IF v_password_hash IS NULL THEN
    RAISE EXCEPTION 'AODP_INVALID_AUTH_USER: auth user % not found or has no password set', p_user_id
      USING ERRCODE = 'P0001';
  END IF;

  -- unique_violation alami pada PRIMARY KEY (jika p_user_id sudah punya
  -- profil -- seharusnya tidak pernah terjadi lewat jalur ini karena
  -- p_user_id selalu auth user yang BARU dibuat) membatalkan seluruh
  -- transaksi ini, TS layer menangkap exception dan menjalankan compensating
  -- deleteAuthUser -- identik dengan pola createSalesman().
  INSERT INTO public.users (
    id, company_id, email, full_name, phone, is_active,
    must_change_password, provisioned_password_hash
  ) VALUES (
    p_user_id, p_company_id, btrim(p_email), v_full_name, v_phone, TRUE,
    TRUE, v_password_hash
  );

  INSERT INTO public.user_roles (user_id, role_id, company_id, assigned_by)
  VALUES (p_user_id, p_role_id, p_company_id, p_actor_id);

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    p_company_id,
    p_actor_id,
    'tenant_user.created',
    'users',
    p_user_id,
    jsonb_build_object('email', btrim(p_email), 'full_name', v_full_name)
  );

  RETURN QUERY SELECT 'provisioned'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.provision_owner_created_tenant_user(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) IS
  'Gate 3E-C-C2-B1: provisioning atomic profile+role+audit untuk user tenant (admin|sales) yang dibuat owner, dipanggil service-role SETELAH auth.users dibuat di TS. Re-verifikasi actor (owner aktif, tenant sama) dan role allowlist (is_tenant_assignable_role) di dalam fungsi -- tidak pernah mempercayai parameter caller untuk otorisasi. must_change_password selalu TRUE, snapshot password hash dibaca langsung dari auth.users (tidak bisa dipalsukan parameter).';

REVOKE ALL ON FUNCTION public.provision_owner_created_tenant_user(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_owner_created_tenant_user(UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. complete_mandatory_password_change() -- dipanggil LANGSUNG oleh sesi
-- user sendiri (auth-key client dengan JWT, pola identik provision_first_
-- owner() -- lihat migration 20260907000001 untuk precedent "RPC dipanggil
-- langsung oleh browser/anon-key client, bukan lewat server action admin-
-- client"). Identitas SELALU auth.uid() -- tidak ada parameter user_id sama
-- sekali, sehingga caller tidak mungkin membersihkan flag milik user lain.
--
-- Bukti "password sudah diganti": encrypted_password SAAT INI dibandingkan
-- terhadap provisioned_password_hash yang direkam saat provisioning. Kedua
-- nilai sama -> password belum diganti (temporary password masih dipakai) ->
-- flag TETAP TRUE, ditolak. Berbeda -> Supabase Auth (GoTrue) sudah menulis
-- hash BARU ke auth.users.encrypted_password -- satu-satunya cara nilai itu
-- berubah adalah panggilan updateUser()/admin.updateUserById() yang SUKSES
-- -- klaim client semata tidak pernah cukup, perbandingan ini yang membuat
-- pembersihan flag "aman" sesuai kontrak.
--
-- Dipanggil dari getAuthUser() (server, memakai session client milik user
-- itu sendiri -- lihat lib/supabase/server.ts) pada setiap request dashboard
-- selama must_change_password masih TRUE -- self-healing tanpa perlu UI baru
-- atau perubahan pada reset-password-form.tsx sama sekali.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_mandatory_password_change()
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id UUID;
  v_must_change BOOLEAN;
  v_baseline_hash TEXT;
  v_current_hash TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'AODP_UNAUTHENTICATED: caller must be authenticated'
      USING ERRCODE = '28000';
  END IF;

  SELECT must_change_password, provisioned_password_hash
  INTO v_must_change, v_baseline_hash
  FROM public.users
  WHERE id = v_caller_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_profile'::TEXT;
    RETURN;
  END IF;

  IF NOT v_must_change THEN
    RETURN QUERY SELECT 'already_cleared'::TEXT;
    RETURN;
  END IF;

  SELECT encrypted_password INTO v_current_hash FROM auth.users WHERE id = v_caller_id;

  IF v_current_hash IS NULL OR v_baseline_hash IS NULL OR v_current_hash = v_baseline_hash THEN
    RETURN QUERY SELECT 'password_not_yet_changed'::TEXT;
    RETURN;
  END IF;

  UPDATE public.users
  SET must_change_password = FALSE, provisioned_password_hash = NULL
  WHERE id = v_caller_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id)
  SELECT company_id, id, 'tenant_user.mandatory_password_change_completed', 'users', id
  FROM public.users WHERE id = v_caller_id;

  RETURN QUERY SELECT 'cleared'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.complete_mandatory_password_change() IS
  'Gate 3E-C-C2-B1: membersihkan must_change_password untuk auth.uid() HANYA bila auth.users.encrypted_password terbukti berbeda dari provisioned_password_hash (bukti password sungguh diganti via Supabase Auth). Tidak menerima parameter user_id -- caller tidak pernah bisa membersihkan flag user lain. Idempotent (already_cleared bila dipanggil ulang setelah sukses).';

REVOKE ALL ON FUNCTION public.complete_mandatory_password_change()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.complete_mandatory_password_change()
  TO authenticated;
