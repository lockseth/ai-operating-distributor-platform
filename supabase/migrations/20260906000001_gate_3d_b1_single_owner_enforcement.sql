-- =============================================================================
-- Gate 3D-B1 -- Database Single-Owner Enforcement
-- (repaired by Gate 3D-B1-R1, 2026-08-01 -- closes the UPDATE bypass, see below)
--
-- Kontrak: docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
-- (G1, FROZEN by amendment Gate 3D-A1, 2026-08-01; clarified by Gate 3D-B1-R1,
-- 2026-08-01). Keputusan yang diadopsi: Option 1 -- trigger pada
-- public.user_roles yang menolak mutasi apa pun yang menghasilkan owner kedua
-- untuk company_id yang sama. Ini implementation item #1 dari urutan terkunci
-- Gate 3D-B (§7a) -- migration-only, tidak ada RPC atau UI yang bergantung
-- padanya.
--
-- Invariant sebenarnya adalah "maksimal satu owner per company SETELAH SETIAP
-- mutasi user_roles", bukan "maksimal satu owner ter-insert". Versi awal
-- (Gate 3D-B1) hanya memasang BEFORE INSERT -- itu baseline minimum, bukan
-- kontrak penuh: sebuah baris admin/sales yang sudah ada masih bisa di-UPDATE
-- role_id-nya menjadi owner, atau sebuah baris owner yang sudah ada masih bisa
-- di-UPDATE company_id-nya berpindah ke tenant yang sudah punya owner --
-- keduanya menghasilkan owner kedua tanpa pernah lewat INSERT. Gate 3D-B1-R1
-- menutup celah itu dengan memperluas trigger ke BEFORE INSERT OR UPDATE OF
-- role_id, company_id, dan mengevaluasi ulang pemeriksaan yang sama setiap
-- kali kolom tersebut disentuh.
--
-- Kenapa BUKAN cukup dengan EXISTS check biasa: BEFORE ROW trigger yang hanya
-- melakukan SELECT EXISTS tanpa mengunci apa pun masih rentan race condition
-- murni -- dua transaksi konkuren yang menjadikan owner untuk company_id yang
-- sama (lewat INSERT, UPDATE role_id, atau UPDATE company_id, kombinasi
-- apa pun) bisa sama-sama lolos EXISTS check sebelum salah satu commit. Untuk
-- menutup celah itu tanpa menambah unique index terpisah (di luar keputusan
-- Option 1 yang di-lock), trigger ini mengunci baris public.companies milik
-- company_id TUJUAN (NEW.company_id) yang bersangkutan (SELECT ... FOR UPDATE)
-- sebelum melakukan EXISTS check. Baris company_id yang sama hanya bisa
-- dikunci oleh satu transaksi pada satu waktu -- transaksi kedua otomatis
-- diblokir oleh Postgres sampai transaksi pertama commit/rollback, lalu EXISTS
-- check-nya akan melihat baris owner yang baru saja di-commit dan ditolak. Ini
-- menyerialisasi tepat pada scope yang relevan (per company_id), bukan
-- global, dan tidak bergantung sama sekali pada kode aplikasi/RPC pemanggil.
-- Pola ini berlaku identik untuk INSERT maupun UPDATE karena keduanya
-- mengunci companies.id yang sama sebelum memeriksa.
--
-- Self-exclusion (ur.id <> NEW.id) di EXISTS check: perlu untuk UPDATE supaya
-- baris yang sedang di-update tidak dihitung sebagai "owner lain yang sudah
-- ada" terhadap dirinya sendiri -- misalnya UPDATE pada owner yang sudah ada
-- yang tidak benar-benar mengubah company_id (no-op atau ganti kolom lain)
-- tidak boleh gagal karena "bentrok" dengan baris dirinya sendiri. Untuk
-- INSERT klausa ini tidak berpengaruh (baris belum ada di tabel saat trigger
-- BEFORE INSERT jalan) tapi aman disertakan agar satu fungsi bisa melayani
-- kedua operasi.
--
-- Trigger TIDAK memiliki pengecualian untuk service-role atau direct SQL --
-- ini trigger level tabel, bukan RLS policy, sehingga berlaku untuk semua
-- jalur tulis termasuk service_role/service-role client (dibuktikan oleh test
-- integrasi Gate 3D-B1, semua insert/update via service-role client).
--
-- ERRCODE 'unique_violation' (23505) dipakai secara sengaja (bukan default
-- P0001 dari RAISE EXCEPTION polos) supaya PostgREST/Supabase memetakan
-- error ini ke HTTP 409 Conflict secara konsisten, dan supaya runtime
-- (Gate 3D-B2 RPC, Gate 3D-B3 signup UI) punya sinyal error yang stabil
-- untuk dibedakan dari kegagalan generik lain.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_single_owner_per_company()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role_name TEXT;
  v_owner_exists BOOLEAN;
BEGIN
  SELECT name INTO v_role_name FROM public.roles WHERE id = NEW.role_id;

  IF v_role_name = 'owner' THEN
    -- Mutex per-tenant: kunci baris companies milik company_id TUJUAN supaya
    -- insert/update owner konkuren yang menyasar company_id yang sama
    -- diserialisasi, bukan dievaluasi bersamaan secara race.
    PERFORM 1 FROM public.companies WHERE id = NEW.company_id FOR UPDATE;

    SELECT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.company_id = NEW.company_id
        AND r.name = 'owner'
        AND ur.id <> NEW.id
    ) INTO v_owner_exists;

    IF v_owner_exists THEN
      RAISE EXCEPTION 'AODP_SINGLE_OWNER_VIOLATION: company_id % already has an owner', NEW.company_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_single_owner_per_company() IS
  'Gate 3D-B1 (repaired Gate 3D-B1-R1): menolak INSERT atau UPDATE user_roles yang menghasilkan owner kedua untuk company_id yang sama. Race-safe via row lock pada companies; berlaku juga untuk service-role/direct SQL.';

DROP TRIGGER IF EXISTS trg_enforce_single_owner_per_company ON public.user_roles;
CREATE TRIGGER trg_enforce_single_owner_per_company
  BEFORE INSERT OR UPDATE OF role_id, company_id ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_owner_per_company();
