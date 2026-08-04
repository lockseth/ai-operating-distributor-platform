-- =============================================================================
-- Gate 3E-D2-A-R3 -- Self-Service OTP Recovery, Mandatory Password Change.
--
-- Kontrak: user (owner|admin|sales) yang login lewat OTP recovery
-- (verifyOtp({ email, token, type: "recovery" }), bukan magic-link -- lihat
-- catatan di forgot-password-form.tsx soal kenapa PKCE magic-link ditinggalkan)
-- WAJIB mengganti password sebelum bisa memakai dashboard, memakai ULANG
-- infrastruktur must_change_password/provisioned_password_hash yang sudah ada
-- (migration 20260911000001) -- get-user.ts, complete_mandatory_password_
-- change(), dan /reset-password TIDAK diubah sama sekali oleh migration ini.
--
-- Satu RPC baru: begin_self_recovery_password_change(). Berbeda dari
-- provision_owner_created_tenant_user() (INSERT profil baru, dipanggil
-- service-role) dan super_admin_begin_tenant_user_password_reset() (UPDATE
-- user LAIN, dipanggil service-role) -- RPC ini dipanggil LANGSUNG oleh sesi
-- user sendiri (auth-key client, sama pola provision_first_owner()/
-- complete_mandatory_password_change()), auth.uid() satu-satunya identitas,
-- tidak ada parameter user_id sama sekali -- caller tidak mungkin mengunci
-- user lain.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- begin_self_recovery_password_change() -- dipanggil client SEGERA setelah
-- verifyOtp({ type: "recovery" }) sukses (sesi baru sudah authenticated),
-- SEBELUM redirect ke dashboard. Menyalin pola snapshot baseline dari
-- provision_owner_created_tenant_user(): baseline = hash password YANG SAAT
-- INI berlaku (password lama milik user itu sendiri) -- bukti pembanding
-- untuk complete_mandatory_password_change() nanti (existing, tidak diubah).
--
-- Idempotent terhadap operasi lain yang sedang mengunci user yang sama (mis.
-- super_admin_begin_tenant_user_password_reset() untuk target yang sama
-- kebetulan berjalan hampir bersamaan): bila must_change_password SUDAH TRUE,
-- RPC ini TIDAK menimpa baseline yang sudah ada -- baseline lama tetap jadi
-- pembanding yang sah, mencegah race menimpa bukti pembanding operasi lain.
--
-- User is_active = FALSE tidak dikunci di sini (tidak ada gunanya -- get-
-- user.ts sudah menolak+signOut user non-aktif pada request dashboard
-- pertama, terlepas dari must_change_password) -- outcome 'inactive'
-- dikembalikan supaya caller TS tahu tanpa perlu query terpisah, TIDAK
-- menyembunyikan/melemahkan gate is_active yang sudah ada.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.begin_self_recovery_password_change()
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_caller_id       UUID;
  v_is_active       BOOLEAN;
  v_must_change_now BOOLEAN;
  v_current_hash    TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'AODP_UNAUTHENTICATED: caller must be authenticated'
      USING ERRCODE = '28000';
  END IF;

  SELECT is_active, must_change_password
  INTO v_is_active, v_must_change_now
  FROM public.users
  WHERE id = v_caller_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_profile'::TEXT;
    RETURN;
  END IF;

  IF NOT v_is_active THEN
    RETURN QUERY SELECT 'inactive'::TEXT;
    RETURN;
  END IF;

  IF v_must_change_now THEN
    RETURN QUERY SELECT 'already_required'::TEXT;
    RETURN;
  END IF;

  SELECT encrypted_password INTO v_current_hash FROM auth.users WHERE id = v_caller_id;

  IF v_current_hash IS NULL THEN
    RETURN QUERY SELECT 'no_auth'::TEXT;
    RETURN;
  END IF;

  UPDATE public.users
  SET must_change_password = TRUE, provisioned_password_hash = v_current_hash
  WHERE id = v_caller_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id)
  SELECT company_id, id, 'user.self_recovery_password_change_required', 'users', id
  FROM public.users WHERE id = v_caller_id;

  RETURN QUERY SELECT 'required'::TEXT;
END;
$$;

COMMENT ON FUNCTION public.begin_self_recovery_password_change() IS
  'Gate 3E-D2-A-R3: dipanggil sesi user sendiri (auth.uid()) segera setelah verifyOtp recovery sukses -- mengunci must_change_password=TRUE dengan baseline hash password saat ini, memakai ulang complete_mandatory_password_change() (20260911000001) dan gate dashboard get-user.ts apa adanya. Idempotent -- tidak menimpa baseline bila sudah TRUE (mis. reset super_admin sedang in-flight).';

REVOKE ALL ON FUNCTION public.begin_self_recovery_password_change()
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.begin_self_recovery_password_change()
  TO authenticated;
