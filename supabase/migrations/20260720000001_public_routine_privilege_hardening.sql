-- =============================================================================
-- Migration: Global Public Routine Privilege Hardening
--
-- Global SQL Routine Exposure Gate audit (2026-07-16). Inventory penuh
-- seluruh routine schema public (9 fungsi) + live effective-privilege query
-- (pg_proc/has_function_privilege) menemukan:
--
-- 1. DEFAULT PRIVILEGE GAP (root cause, akar dari temuan RPC delivery
--    sebelumnya): migration 20260707000003_grant_schema_privileges.sql
--    menjalankan `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA
--    public GRANT ALL ON ROUTINES TO anon, authenticated, service_role`.
--    Seluruh fungsi di repo ini dibuat oleh role `postgres` (dikonfirmasi
--    via pg_proc.proowner) -- migration APA PUN di masa depan yang membuat
--    CREATE FUNCTION baru di schema public TANPA REVOKE eksplisit akan
--    otomatis executable oleh anon/authenticated, mengulangi kelas bug yang
--    sama seperti sync_sales_order_delivery_status &
--    finalize_delivery_item_quantities (lihat
--    20260719000001_delivery_rpc_grant_hardening.sql).
--
--    DIUJI LIVE bahwa `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON
--    ROUTINES FROM PUBLIC` SAJA TIDAK CUKUP: PostgreSQL menyisipkan grant
--    PUBLIC (`=X/[owner]`) ke initial ACL fungsi baru secara built-in
--    (acldefault() untuk object type FUNCTION) yang tidak dapat ditekan
--    lewat ALTER DEFAULT PRIVILEGES sama sekali -- dibuktikan: setelah
--    REVOKE EXECUTE ON ROUTINES FROM PUBLIC dijalankan dan defaclacl
--    dikonfirmasi bersih (tidak berisi entry PUBLIC), fungsi baru yang
--    dibuat setelahnya TETAP mendapat entry `=X/postgres` (PUBLIC execute)
--    di proacl-nya -- anon/authenticated (anggota implisit PUBLIC) tetap
--    bisa EXECUTE. Karena anon/authenticated selalu anggota pseudo-role
--    PUBLIC, satu-satunya mekanisme yang benar-benar efektif adalah EVENT
--    TRIGGER yang menjalankan REVOKE EXECUTE ... FROM PUBLIC eksplisit
--    pada SETIAP fungsi baru segera setelah dibuat (ddl_command_end).
--
--    Fix: event trigger `trg_harden_new_public_routines`, scoped HANYA ke
--    schema public (tidak menyentuh storage/auth/realtime/extensions/
--    graphql/supabase_functions -- baseline Supabase sendiri, sesuai
--    instruksi "tidak merusak extension/schema internal Supabase"). Setelah
--    trigger ini aktif, function/procedure baru apa pun di schema public
--    otomatis kehilangan EXECUTE dari PUBLIC (sehingga anon & authenticated
--    ikut kehilangan) TAPI tetap EXECUTE untuk service_role (grant eksplisit
--    dari ALTER DEFAULT PRIVILEGES migration 20260707000003, tidak
--    disentuh oleh REVOKE FROM PUBLIC karena itu entry terpisah). RPC baru
--    yang memang perlu diakses authenticated WAJIB GRANT EXECUTE eksplisit
--    di migration-nya sendiri, setelah CREATE FUNCTION -- forcing function
--    yang disengaja. Trigger ini dipasang PALING TERAKHIR di migration ini
--    (setelah get_user_roles di-CREATE OR REPLACE di bawah) supaya tidak
--    ikut men-strip PUBLIC dari fungsi yang justru wajib tetap accessible
--    authenticated (get_user_roles, RLS helper).
--
-- 2. get_user_roles(p_user_id UUID DEFAULT auth.uid()) -- SECURITY DEFINER,
--    parameter p_user_id dapat di-override caller (bukan hanya default).
--    Hasil TETAP tenant-scoped (JOIN ur.company_id = get_user_company_id()
--    milik CALLER, bukan target) sehingga TIDAK ADA kebocoran lintas
--    tenant -- tapi caller authenticated bisa query role coworker mana pun
--    DALAM tenant yang sama tanpa permission check apa pun. Function ini
--    tidak dipanggil dari kode aplikasi maupun RLS policy manapun (grep
--    bersih). MEDIUM, bukan Critical (tidak lintas tenant) -- diperbaiki
--    sekalian karena fix-nya satu baris, zero behavior change untuk
--    pemanggilan self (default parameter sudah = auth.uid()).
--
-- 3. search_path hardening -- keenam fungsi SECURITY DEFINER (dan dua
--    fungsi lain untuk konsistensi) tidak men-set search_path eksplisit.
--    Seluruh referensi objek di dalamnya SUDAH schema-qualified
--    (public.xxx / auth.uid()) sehingga TIDAK ada celah shadowing yang
--    tereksploitasi hari ini -- tapi SET search_path tetap ditambahkan
--    sebagai defense-in-depth standar Postgres/Supabase untuk SECURITY
--    DEFINER, mencegah regresi bila kode masa depan menambah referensi
--    tak-qualified.
--
-- set_updated_at() dan update_customer_last_order() TIDAK diubah grant-nya:
-- keduanya RETURNS TRIGGER, dibuktikan live bahwa Postgres menolak
-- pemanggilan langsung ("trigger functions can only be called as
-- triggers") terlepas dari EXECUTE grant apa pun -- merevoke EXECUTE pada
-- fungsi trigger berisiko memutus trigger updated_at di seluruh tabel
-- tanpa manfaat keamanan nyata (pemanggilan langsung sudah mustahil secara
-- struktural), jadi tidak disentuh (menghindari mengubah business behavior
-- di luar security closure).
--
-- get_outstanding_quantity, finalize_delivery_item_quantities,
-- sync_sales_order_delivery_status: grant sudah benar dari migration
-- sebelumnya, tidak diulang di sini.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1a. Default privilege (best-effort, lapisan pertama -- lihat catatan di
-- atas kenapa ini saja tidak cukup untuk FUNCTION). Tidak mengubah grant
-- fungsi yang sudah ada.
-- ---------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON ROUTINES FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. get_user_roles: kunci p_user_id ke identitas caller sendiri. Parameter
-- dipertahankan (bukan breaking change signature) tapi hasil hanya valid
-- bila p_user_id = auth.uid() -- caller tidak bisa lagi memilih actor lain.
-- Dijalankan SEBELUM event trigger dipasang (lihat bagian 1b di bawah) agar
-- fungsi ini tetap accessible anon/authenticated seperti sebelumnya.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_user_roles(p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT[] AS $$
  SELECT ARRAY_AGG(r.name)
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id
    AND ur.company_id = public.get_user_company_id()
    AND p_user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.get_user_roles IS
  'Role names milik SATU user dalam company milik caller. SECURITY DEFINER -- p_user_id WAJIB sama dengan auth.uid() (dipaksa di WHERE clause sejak 20260720000001), caller tidak dapat lagi query role user lain meski dalam tenant sendiri.';

-- ---------------------------------------------------------------------------
-- 3. search_path hardening -- defense-in-depth untuk seluruh SECURITY
-- DEFINER (dan dua fungsi read-only lain untuk konsistensi). ALTER FUNCTION
-- tidak memicu event trigger CREATE FUNCTION, aman di posisi mana pun.
-- ---------------------------------------------------------------------------

ALTER FUNCTION public.get_user_company_id() SET search_path = public, pg_temp;
ALTER FUNCTION public.user_has_role(TEXT[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.user_has_permission(TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.update_customer_last_order() SET search_path = public, pg_temp;
ALTER FUNCTION public.sync_sales_order_delivery_status(UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.get_outstanding_quantity(UUID, UUID) SET search_path = public, pg_temp;
ALTER FUNCTION public.finalize_delivery_item_quantities(UUID, JSONB) SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1b. Event trigger -- mekanisme yang benar-benar efektif (lihat catatan
-- besar di atas). Dipasang PALING TERAKHIR supaya CREATE OR REPLACE
-- FUNCTION get_user_roles di atas TIDAK ikut ter-strip PUBLIC-nya.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._enforce_public_routine_privilege()
RETURNS event_trigger AS $$
DECLARE
  obj RECORD;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF obj.object_type IN ('function', 'procedure') AND obj.schema_name = 'public' THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', obj.object_identity);
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

COMMENT ON FUNCTION public._enforce_public_routine_privilege IS
  'Event trigger handler -- REVOKE EXECUTE FROM PUBLIC otomatis pada setiap CREATE FUNCTION/PROCEDURE baru di schema public. ALTER DEFAULT PRIVILEGES REVOKE FROM PUBLIC terbukti tidak cukup untuk object type FUNCTION (lihat komentar di atas migration ini) -- ini satu-satunya mekanisme yang benar-benar mencegah anon/authenticated otomatis mendapat EXECUTE pada routine baru. Tidak menyentuh schema lain (storage/auth/realtime/extensions/graphql/supabase_functions). RPC authenticated baru yang memang dibutuhkan wajib GRANT EXECUTE eksplisit setelah CREATE FUNCTION di migration-nya sendiri.';

DROP EVENT TRIGGER IF EXISTS trg_harden_new_public_routines;
CREATE EVENT TRIGGER trg_harden_new_public_routines
  ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'CREATE PROCEDURE')
  EXECUTE FUNCTION public._enforce_public_routine_privilege();
