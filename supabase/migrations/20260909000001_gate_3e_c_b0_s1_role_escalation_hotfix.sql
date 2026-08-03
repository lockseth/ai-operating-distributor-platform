-- =============================================================================
-- Gate 3E-C-B0-S1 -- Emergency Role Escalation Hotfix
--
-- Audit finding (Gate 3E-C-B0, read-only audit): kebijakan RLS
-- "user_roles_manage" (migration 20260626000004_rls_policies.sql:143-147)
-- adalah FOR ALL dengan satu USING yang hanya memeriksa:
--   (a) company_id baris BARU/LAMA = tenant milik caller, dan
--   (b) caller sendiri sudah punya role owner/manager/super_admin,
-- TANPA PERNAH memeriksa role_id APA yang sedang di-assign. Karena FOR ALL
-- tanpa WITH CHECK terpisah memakai USING yang sama untuk validasi baris BARU
-- pada INSERT/UPDATE, caller mana pun yang sudah owner (atau manager) di
-- tenant-nya sendiri bisa langsung:
--   POST /rest/v1/user_roles
--   { user_id: <dirinya sendiri>, role_id: <uuid role 'super_admin'>,
--     company_id: <tenant miliknya sendiri> }
-- memakai JWT sesi miliknya sendiri (bukan service-role) dan lolos --
-- 'super_admin' adalah system role (company_id IS NULL,
-- 20260626000002_create_users_roles_permissions.sql:106) yang UUID-nya bisa
-- dibaca siapa pun via "roles_select" (company_id IS NULL OR own company).
-- Trigger single-owner (20260906000001_gate_3d_b1_single_owner_enforcement.sql)
-- tidak menutup ini -- trigger tersebut HANYA memeriksa v_role_name = 'owner'
-- (line 74), tidak berbuat apa pun untuk role_name = 'super_admin'. Hasil
-- akhir: user.roles memuat 'super_admin' (get-user.ts resolve dari
-- user_roles.company_id = tenant caller, JOIN roles -- bukan dari
-- roles.company_id), lolos setiap `user.roles.includes("super_admin")`
-- check di apps/web/src/lib/platform/tenant-actions.ts dan
-- apps/web/src/app/(dashboard)/dashboard/platform/**, yang membaca/menulis
-- SEMUA tenant via getAdminClient() (service-role).
--
-- Keputusan Founder/CTO (Gate 3E-C-B0-S1): fix ini MENEGAKKAN permission
-- matrix existing (super_admin = operator platform, tidak pernah diberikan
-- lewat jalur tenant), bukan mengubahnya. Diperbaiki di layer RLS (bukan
-- trigger tabel baru) karena:
--   1. RLS TIDAK berlaku untuk pemilik tabel (postgres) -- sehingga RPC
--      SECURITY DEFINER public.provision_first_owner() (Gate 3D-B2, migration
--      20260907000001) TETAP bisa insert role 'owner' tanpa terhalang policy
--      ini, persis seperti sebelumnya.
--   2. Alur produk yang sudah ada (createSalesman, salesman/actions.ts)
--      SELALU memakai getAdminClient() (service-role, RLS-bypassing) --
--      fix RLS ini TIDAK menyentuh jalur itu sama sekali. Fix ini murni
--      menutup jalur "direct authenticated REST call" yang sebelumnya
--      terbuka.
--   3. "Hindari policy FOR ALL yang ambigu" (instruksi gate) -- policy lama
--      dipecah jadi INSERT/UPDATE/DELETE eksplisit dengan WITH CHECK
--      terpisah dari USING, supaya validasi baris BARU (termasuk role_id
--      tujuan) tidak lagi ambigu/implisit.
--
-- Allowlist role tenant yang bisa di-assign lewat jalur RLS langsung dibatasi
-- persis {admin, sales} sesuai kontrak existing (LOCK Gate 3E-C: "owner dapat
-- menambahkan role admin dan sales"). 'owner' SENGAJA tidak dimasukkan ke
-- allowlist ini -- assignment owner hanya lewat provision_first_owner() (RPC
-- SECURITY DEFINER, bypass RLS sebagai pemilik tabel) dan tetap dijaga
-- trigger single-owner Gate 3D-B1 sebagai defense-in-depth kedua. 'manager'
-- tidak dimasukkan ke allowlist assignment (bukan role produk AODP aktif),
-- TAPI tetap dipertahankan di daftar ACTOR yang boleh mengelola user_roles
-- (ARRAY['owner','manager','super_admin'], tidak diubah) sesuai instruksi
-- eksplisit gate ini: jangan mengubah perilaku role manager selain mencegah
-- assignment role system/global yang tidak sah.
--
-- Konsistensi membership: WITH CHECK juga memastikan users.company_id milik
-- user_id target SAMA dengan company_id baris user_roles yang di-assign --
-- mencegah caller menaruh baris membership tenant-nya sendiri untuk user
-- yang sebenarnya adalah anggota tenant lain.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: role_id yang di-assign termasuk allowlist tenant {admin, sales},
-- dan (bila role tenant-custom) benar-benar milik company_id target -- bukan
-- role custom tenant lain yang kebetulan bernama sama.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_tenant_assignable_role(p_role_id UUID, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.roles r
    WHERE r.id = p_role_id
      AND r.name IN ('admin', 'sales')
      AND (r.company_id IS NULL OR r.company_id = p_company_id)
  )
$$;

COMMENT ON FUNCTION public.is_tenant_assignable_role(UUID, UUID) IS
  'Gate 3E-C-B0-S1: TRUE hanya bila role_id merujuk role bernama admin/sales (system role global atau custom role milik company_id target). Owner/manager/super_admin/role sistem lain SELALU FALSE -- assignment owner hanya lewat provision_first_owner() RPC (bypass RLS), super_admin tidak pernah bisa di-assign lewat jalur tenant.';

-- Event trigger trg_harden_new_public_routines (20260720000001) otomatis
-- REVOKE EXECUTE FROM PUBLIC pada setiap CREATE FUNCTION baru di schema
-- public -- termasuk fungsi ini. Fungsi ini dipanggil DI DALAM WITH CHECK
-- policy RLS di bawah, yang dievaluasi sebagai role `authenticated` (bukan
-- service_role), jadi wajib GRANT EXECUTE eksplisit ke authenticated supaya
-- policy-nya bisa jalan sama sekali (bukan celah -- tanpa grant ini INSERT/
-- UPDATE authenticated akan gagal dengan "permission denied", bukan diam-diam
-- lolos; STABLE + tidak menerima input caller-controlled selain UUID yang
-- sudah divalidasi FK oleh Postgres, aman diberikan ke authenticated).
GRANT EXECUTE ON FUNCTION public.is_tenant_assignable_role(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- user_roles: pecah "user_roles_manage" (FOR ALL, ambigu) menjadi
-- INSERT/UPDATE/DELETE eksplisit. SELECT (user_roles_select) tidak disentuh.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "user_roles_manage" ON public.user_roles;

CREATE POLICY "user_roles_insert" ON public.user_roles
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
    AND public.is_tenant_assignable_role(role_id, company_id)
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = user_id AND u.company_id = company_id
    )
  );

CREATE POLICY "user_roles_update" ON public.user_roles
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  ) WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
    AND public.is_tenant_assignable_role(role_id, company_id)
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = user_id AND u.company_id = company_id
    )
  );

CREATE POLICY "user_roles_delete" ON public.user_roles
  FOR DELETE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );
