-- =============================================================================
-- Gate 3D-B1 -- Database Single-Owner Enforcement
--
-- Kontrak: docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
-- (G1, FROZEN by amendment Gate 3D-A1, 2026-08-01). Keputusan yang diadopsi:
-- Option 1 -- BEFORE INSERT trigger pada public.user_roles yang menolak insert
-- role 'owner' kedua untuk company_id yang sama. Ini implementation item #1
-- dari urutan terkunci Gate 3D-B (§7a) -- migration-only, tidak ada RPC atau
-- UI yang bergantung padanya.
--
-- Kenapa BUKAN cukup dengan EXISTS check biasa: BEFORE ROW trigger yang hanya
-- melakukan SELECT EXISTS tanpa mengunci apa pun masih rentan race condition
-- murni -- dua transaksi konkuren yang insert owner untuk company_id yang
-- sama bisa sama-sama lolos EXISTS check sebelum salah satu commit. Untuk
-- menutup celah itu tanpa menambah unique index terpisah (di luar keputusan
-- Option 1 yang di-lock), trigger ini mengunci baris public.companies milik
-- company_id yang bersangkutan (SELECT ... FOR UPDATE) sebelum melakukan
-- EXISTS check. Baris company_id yang sama hanya bisa dikunci oleh satu
-- transaksi pada satu waktu -- transaksi kedua otomatis diblokir oleh
-- Postgres sampai transaksi pertama commit/rollback, lalu EXISTS check-nya
-- akan melihat baris owner yang baru saja di-commit dan ditolak. Ini
-- menyerialisasi tepat pada scope yang relevan (per company_id), bukan
-- global, dan tidak bergantung sama sekali pada kode aplikasi/RPC pemanggil.
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
    -- Mutex per-tenant: kunci baris companies milik tenant ini supaya insert
    -- owner konkuren untuk company_id yang sama diserialisasi, bukan
    -- dievaluasi bersamaan secara race.
    PERFORM 1 FROM public.companies WHERE id = NEW.company_id FOR UPDATE;

    SELECT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      WHERE ur.company_id = NEW.company_id
        AND r.name = 'owner'
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
  'Gate 3D-B1: menolak insert user_roles kedua dengan role=owner untuk company_id yang sama. Race-safe via row lock pada companies.';

DROP TRIGGER IF EXISTS trg_enforce_single_owner_per_company ON public.user_roles;
CREATE TRIGGER trg_enforce_single_owner_per_company
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_owner_per_company();
