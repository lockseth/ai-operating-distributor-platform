-- =============================================================================
-- Gate 3D-B2 -- Atomic Fail-Closed Owner Provisioning RPC.
--
-- Kontrak: docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
-- (§5.A, §7a step 2). Implementation item #2 dari urutan terkunci Gate 3D-B --
-- bergantung pada item #1 (trigger single-owner, migration
-- 20260906000001_gate_3d_b1_single_owner_enforcement.sql) yang sudah live.
--
-- Scope RPC ini HANYA provisioning tenant/profil/role untuk pengguna yang
-- SUDAH authenticated (auth.users row sudah ada -- dibuat lewat
-- supabase.auth.signUp()/admin.createUser() SEBELUM RPC ini dipanggil, di
-- LUAR transaksi ini). RPC TIDAK PERNAH membuat atau menghapus auth.users --
-- itu bukan tanggung jawabnya (lihat kontrak: "Jangan mencoba menghapus auth
-- user dari RPC"). Signup UI (memanggil auth.signUp() lalu RPC ini) adalah
-- Gate 3D-B3, di luar scope migration ini.
--
-- Identitas caller SELALU dari auth.uid() (JWT session PostgREST sungguhan),
-- TIDAK PERNAH dari parameter/user_metadata -- RPC ini sengaja TIDAK
-- menerima parameter user_id, role, company_id, atau flag privilege apa pun.
-- Ini juga berarti caller TIDAK BISA memprovisi user lain (tidak ada
-- parameter untuk menyasar user lain sama sekali).
--
-- Atomicity: karena seluruh langkah (companies -> public.users profile ->
-- user_roles owner -> audit_logs) adalah INSERT biasa di DALAM SATU fungsi
-- plpgsql, Postgres membungkusnya dalam satu transaksi implisit -- exception
-- apa pun (validasi, constraint, atau trigger Gate 3D-B1) otomatis me-rollback
-- SEMUA langkah sebelumnya tanpa compensating cleanup di application code.
-- Ini lebih sederhana dari pola compensating-transaction createSalesman()
-- (yang perlu delete-auth-user manual) justru karena auth.users tidak dibuat
-- di sini sama sekali.
--
-- Fail-closed "sudah diprovisi": diperiksa lewat EXISTS user_roles untuk
-- auth.uid() (definisi kanonis "active membership" per kontrak §2) SEBELUM
-- insert apa pun. Sengaja TIDAK ada pre-check terpisah untuk public.users --
-- PRIMARY KEY users.id sudah menjadi safety-net alami: jika baris profil utk
-- id ini sudah ada tanpa user_roles (state anomali yang seharusnya tidak
-- pernah terjadi lewat jalur manapun hari ini), INSERT INTO public.users akan
-- gagal dengan unique_violation NATIVE Postgres, dan seluruh transaksi
-- (termasuk companies row yang baru dibuat) rollback -- inilah mekanisme yang
-- membuktikan atomicity penuh (test obligation "forced mid-transaction
-- failure").
--
-- Race safety (dua panggilan konkuren untuk auth.uid() yang SAMA): advisory
-- lock transaksi per-caller (pg_advisory_xact_lock(hashtextextended(...)))
-- diambil SEBELUM pemeriksaan "sudah diprovisi" -- pola identik dengan
-- pg_advisory_xact_lock lain di codebase ini (coverage areas, KPI, salesman
-- activation). Panggilan kedua menunggu sampai panggilan pertama commit/
-- rollback, lalu EXISTS check-nya melihat state ter-commit terbaru dan
-- ditolak deterministik -- tidak pernah dua-duanya lolos.
--
-- Race safety (dua tenant baru untuk company_id yang sama): tidak relevan --
-- setiap panggilan sukses SELALU membuat companies row baru dengan
-- gen_random_uuid(), tidak pernah menyasar company_id existing.
--
-- super_admin (G7): role yang di-assign SELALU 'owner' lewat name lookup
-- (roles.name = 'owner' AND company_id IS NULL) -- tidak ada parameter role
-- sama sekali, sehingga super_admin/admin/sales tidak mungkin ter-assign
-- lewat RPC ini dalam kondisi apa pun.
--
-- Privilege: GRANT EXECUTE HANYA ke `authenticated` (BUKAN service_role
-- seperti RPC atomic lain di codebase ini) -- RPC ini secara sengaja
-- dipanggil LANGSUNG oleh sesi pengguna sendiri (browser/anon-key client
-- dengan JWT), bukan lewat server action admin-client. Bahkan bila
-- service_role tetap bisa memanggilnya (mis. lewat direct SQL), auth.uid()
-- akan NULL untuk konteks tanpa JWT user sungguhan dan caller ditolak sebagai
-- unauthenticated -- otorisasi tidak pernah bergantung pada privilege
-- Postgres si pemanggil, persis prinsip trust-boundary "Database" di §4
-- kontrak.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.provision_first_owner(
  p_company_name TEXT,
  p_full_name TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS TABLE(result_outcome TEXT, result_company_id UUID, result_user_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id UUID;
  v_caller_email TEXT;
  v_company_name TEXT;
  v_full_name TEXT;
  v_phone TEXT;
  v_slug TEXT;
  v_owner_role_id UUID;
  v_company_id UUID;
  v_already_provisioned BOOLEAN;
BEGIN
  -- Identitas HANYA dari sesi JWT terverifikasi -- tidak pernah dari
  -- parameter atau user_metadata. Caller anonim (tidak ada JWT/sub claim)
  -- ditolak sebelum menyentuh apa pun.
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'AODP_UNAUTHENTICATED: caller must be authenticated'
      USING ERRCODE = '28000';
  END IF;

  -- Serialize per-caller: dua panggilan konkuren dari auth.uid() yang sama
  -- diserialisasi di sini SEBELUM pemeriksaan "sudah diprovisi" dievaluasi.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_caller_id::TEXT, 9001));

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = v_caller_id
  ) INTO v_already_provisioned;

  IF v_already_provisioned THEN
    RAISE EXCEPTION 'AODP_ALREADY_PROVISIONED: caller already has a tenant membership'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Email diambil dari auth.users (record terverifikasi Supabase Auth),
  -- TIDAK PERNAH dari parameter client atau user_metadata.
  SELECT email INTO v_caller_email FROM auth.users WHERE id = v_caller_id;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'AODP_INVALID_CALLER: authenticated user record not found'
      USING ERRCODE = 'P0001';
  END IF;

  v_company_name := btrim(COALESCE(p_company_name, ''));
  v_full_name    := btrim(COALESCE(p_full_name, ''));
  v_phone        := NULLIF(btrim(COALESCE(p_phone, '')), '');

  IF length(v_company_name) < 2 OR length(v_company_name) > 255 THEN
    RAISE EXCEPTION 'AODP_INVALID_INPUT: company name must be between 2 and 255 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  IF length(v_full_name) < 2 OR length(v_full_name) > 255 THEN
    RAISE EXCEPTION 'AODP_INVALID_INPUT: full name must be between 2 and 255 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_phone IS NOT NULL AND length(v_phone) > 50 THEN
    RAISE EXCEPTION 'AODP_INVALID_INPUT: phone must not exceed 50 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Role owner SELALU resolve lewat name lookup ke system role -- tidak
  -- pernah parameter, tidak pernah user_metadata (G7).
  SELECT id INTO v_owner_role_id FROM public.roles WHERE name = 'owner' AND company_id IS NULL;
  IF v_owner_role_id IS NULL THEN
    RAISE EXCEPTION 'AODP_ROLE_NOT_FOUND: system owner role is not seeded'
      USING ERRCODE = 'P0001';
  END IF;

  -- Slug generation (G5 belum diputuskan untuk signup UI publik -- di sini
  -- kita hanya butuh nilai UNIQUE/NOT NULL yang valid untuk companies.slug;
  -- suffix random 8-hex membuat collision astronomically unlikely tanpa
  -- retry loop. Bila tetap collide, unique_violation alami membatalkan
  -- seluruh transaksi -- caller boleh retry, tidak pernah partial state).
  v_slug := lower(regexp_replace(v_company_name, '[^a-zA-Z0-9]+', '-', 'g'))
    || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  INSERT INTO public.companies (name, slug, subscription_plan, subscription_status, is_active)
  VALUES (v_company_name, v_slug, 'trial', 'active', TRUE)
  RETURNING id INTO v_company_id;

  -- Jika baris profil untuk id ini sudah ada (state anomali), INSERT ini
  -- gagal dengan unique_violation NATIVE Postgres pada PRIMARY KEY --
  -- membatalkan seluruh transaksi termasuk companies row di atas. Ini adalah
  -- bukti atomicity ("forced mid-transaction failure"), bukan kegagalan yang
  -- perlu ditangani manual.
  INSERT INTO public.users (id, company_id, email, full_name, phone, is_active)
  VALUES (v_caller_id, v_company_id, v_caller_email, v_full_name, v_phone, TRUE);

  -- assigned_by NULL: tidak ada actor lain yang "menugaskan" -- ini
  -- self-provisioning oleh owner pertama tenant. Trigger Gate 3D-B1
  -- (enforce_single_owner_per_company) berjalan di sini juga, tapi tidak
  -- pernah menolak karena company_id di atas selalu baru.
  INSERT INTO public.user_roles (user_id, role_id, company_id, assigned_by)
  VALUES (v_caller_id, v_owner_role_id, v_company_id, NULL);

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (
    v_company_id,
    v_caller_id,
    'tenant.first_owner_provisioned',
    'companies',
    v_company_id,
    jsonb_build_object('company_name', v_company_name, 'owner_user_id', v_caller_id)
  );

  RETURN QUERY SELECT 'provisioned'::TEXT, v_company_id, v_caller_id;
END;
$$;

COMMENT ON FUNCTION public.provision_first_owner(TEXT, TEXT, TEXT) IS
  'Gate 3D-B2: provisioning atomic fail-closed untuk owner pertama tenant baru. Identitas selalu auth.uid(); role selalu owner via name lookup; satu company/profile/membership per panggilan sukses; rollback penuh pada kegagalan apa pun; race-safe per-caller via advisory lock.';

REVOKE ALL ON FUNCTION public.provision_first_owner(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.provision_first_owner(TEXT, TEXT, TEXT)
  TO authenticated;
