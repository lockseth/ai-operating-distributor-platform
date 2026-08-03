-- =============================================================================
-- Gate 3E-C-B0-S1-R1 -- Explicit Target Membership Tenant Binding Correction
--
-- Defect terkonfirmasi lewat introspeksi live (Gate 3E-C-B0-S2) pada migration
-- hotfix 20260909000001: klausa WITH CHECK di "user_roles_insert" dan
-- "user_roles_update" menulis
--
--   EXISTS (SELECT 1 FROM public.users u WHERE u.id = user_id AND u.company_id = company_id)
--
-- dengan maksud "company_id" pada sisi kanan merujuk baris BARU user_roles
-- (outer row). PostgreSQL me-resolve identifier tak-qualified ke scope
-- TERDEKAT -- karena alias `u` (public.users) di subquery juga punya kolom
-- company_id, kedua sisi ter-bind ke `u.company_id`, menghasilkan tautologi
-- self-reference `u.company_id = u.company_id` (dibuktikan live via
-- pg_policies.with_check pada Gate 3E-C-B0-S2, bukan interpretasi manual).
-- Klausa itu berubah jadi no-op: EXISTS tereduksi menjadi "apakah user_id ini
-- ada di public.users" (di company MANA PUN), tidak pernah benar-benar
-- membandingkan company_id.
--
-- Proteksi lintas-tenant TETAP bekerja hari ini semata-mata karena RLS
-- "users_company_select" (20260626000004_rls_policies.sql:88-89) sudah
-- menyembunyikan baris user tenant lain dari subquery tersebut (subquery
-- berjalan sebagai caller `authenticated`, tunduk RLS public.users). Ini
-- adalah ketergantungan implisit yang TIDAK didokumentasikan di migration
-- hotfix, dan rapuh: bila users_company_select suatu saat dilonggarkan oleh
-- migration lain (mis. untuk kebutuhan lintas-tenant di area platform/
-- super_admin) tanpa menyadari coupling tersembunyi ini, perlindungan target-
-- membership akan hilang diam-diam tanpa regresi test yang terdeteksi.
--
-- FIX: hapus subquery EXISTS sepenuhnya dari WITH CHECK, ganti dengan
-- pemanggilan fungsi SECURITY DEFINER public.is_same_tenant_member(p_user_id,
-- p_company_id) -- pola identik dengan is_tenant_assignable_role() (hotfix
-- 20260909000001) yang SUDAH terbukti bebas ambiguitas: sebuah pemanggilan
-- fungsi di level TERATAS ekspresi policy (bukan di dalam subquery baru)
-- tidak pernah punya scope kompetitor -- `user_id`/`company_id` sebagai
-- ARGUMEN pemanggilan fungsi selalu merujuk baris NEW/OLD milik policy induk,
-- tanpa qualifier apa pun yang diperlukan, dan tanpa alias tabel lain di
-- scope yang sama untuk bisa "merebut" identifier tersebut. Ini dibuktikan
-- benar oleh introspeksi live Gate 3E-C-B0-S2 terhadap is_tenant_assignable_
-- role -- tidak pernah menunjukkan gejala tautologi seperti subquery EXISTS.
--
-- Independensi dari RLS public.users: karena fungsi ini SECURITY DEFINER,
-- badan fungsi berjalan sebagai PEMILIK fungsi (postgres) -- pemilik tabel
-- SECARA STRUKTURAL tidak tunduk RLS (default Postgres: RLS tidak berlaku
-- untuk pemilik tabel kecuali FORCE ROW LEVEL SECURITY diaktifkan, yang tidak
-- pernah dipasang pada public.users). Artinya fungsi ini melihat SELURUH
-- baris public.users tanpa filter users_company_select, lalu membandingkan
-- users.id dan users.company_id secara langsung terhadap parameter UUID
-- eksak yang diberikan -- jawabannya benar terlepas dari perubahan RLS
-- public.users di masa depan, tidak lagi bergantung pada ketersembunyian
-- baris sebagai mekanisme proteksi tidak langsung.
--
-- Tidak ada perubahan pada: allowlist role tenant-assignable (admin/sales,
-- via is_tenant_assignable_role yang sudah ada, TIDAK disentuh), actor
-- privilege (owner/manager/super_admin, tidak diubah), single-owner trigger
-- (Gate 3D-B1, tidak disentuh), provision_first_owner (Gate 3D-B2, RPC
-- SECURITY DEFINER bypass RLS sebagai pemilik tabel, tidak terpengaruh sama
-- sekali oleh perubahan policy user_roles), signup, Telegram, UI, dataset,
-- cleanup, atau permission diskon. user_roles_delete (FOR DELETE, hanya
-- USING, tidak pernah punya WITH CHECK) tidak disentuh -- defect ini murni
-- di WITH CHECK milik INSERT/UPDATE. Migration lama (20260626000004,
-- 20260909000001) tidak diedit -- perbaikan ini murni DROP POLICY + CREATE
-- POLICY baru di migration baru, konsisten dengan pola existing repo (mis.
-- 20260905000001 memperbaiki kdp_manage dengan cara yang sama).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: apakah p_user_id benar-benar anggota public.users dengan
-- company_id PERSIS p_company_id. SECURITY DEFINER -> membaca public.users
-- sebagai pemilik tabel (bypass RLS caller), sehingga jawabannya tidak
-- bergantung sama sekali pada visibilitas users_company_select milik
-- caller. Tidak membaca auth.users.user_metadata (hanya public.users, yang
-- diisi server-side lewat provision_first_owner()/createSalesman -- tidak
-- pernah dari payload client). Tidak memutasi data apa pun (SELECT murni).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_same_tenant_member(p_user_id UUID, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = p_user_id
      AND u.company_id = p_company_id
  )
$$;

COMMENT ON FUNCTION public.is_same_tenant_member(UUID, UUID) IS
  'Gate 3E-C-B0-S1-R1: TRUE hanya bila public.users berisi baris dengan id=p_user_id DAN company_id=p_company_id persis. SECURITY DEFINER (bypass RLS users_company_select sebagai pemilik tabel) -- jawabannya independen dari visibilitas caller terhadap tabel public.users, bukan bergantung pada RLS caller untuk menyembunyikan user tenant lain. Dipakai menggantikan subquery EXISTS ambigu (tautologi u.company_id=u.company_id) pada user_roles_insert/user_roles_update sejak Gate 3E-C-B0-S1-R1.';

-- Event trigger trg_harden_new_public_routines (20260720000001) otomatis
-- REVOKE EXECUTE FROM PUBLIC pada setiap CREATE FUNCTION baru -- wajib GRANT
-- eksplisit ke authenticated (dipanggil di dalam WITH CHECK yang dievaluasi
-- sebagai role authenticated) dan service_role (konsistensi dengan
-- is_tenant_assignable_role, tidak diperlukan untuk RLS -- service_role
-- bypass RLS sama sekali -- tapi disertakan untuk pola grant yang seragam).
-- TIDAK di-GRANT ke anon.
GRANT EXECUTE ON FUNCTION public.is_same_tenant_member(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- user_roles_insert / user_roles_update: ganti subquery EXISTS ambigu dengan
-- pemanggilan fungsi di level teratas (tanpa subquery baru, tanpa alias
-- kompetitor -- tidak ada ambiguitas scoping sama sekali). Actor-privilege
-- check dan role-allowlist check (is_tenant_assignable_role) TIDAK diubah.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "user_roles_insert" ON public.user_roles;
CREATE POLICY "user_roles_insert" ON public.user_roles
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
    AND public.is_tenant_assignable_role(role_id, company_id)
    AND public.is_same_tenant_member(user_id, company_id)
  );

DROP POLICY IF EXISTS "user_roles_update" ON public.user_roles;
CREATE POLICY "user_roles_update" ON public.user_roles
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  ) WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
    AND public.is_tenant_assignable_role(role_id, company_id)
    AND public.is_same_tenant_member(user_id, company_id)
  );

-- user_roles_delete (hanya USING, tidak ada WITH CHECK) dan user_roles_select
-- tidak disentuh -- defect Gate 3E-C-B0-S2 tidak menyangkut keduanya.
