-- =============================================================================
-- Gate 1C — Owner-Only Telegram Pairing & Reset.
--
-- issue_telegram_salesman_enrollment dan revoke_telegram_salesman_identity
-- (migration 20260722000001) sebelumnya mengizinkan actor role
-- 'owner','manager','admin','super_admin'. Mengikuti persis pola
-- set_salesman_active_status (migration 20260815000001): actor wajib role
-- 'owner' aktif pada tenant yang sama dengan target. Tidak ada perubahan pada
-- signature, lifecycle klaim, token, resolver, atau audit trail -- hanya
-- mempersempit gate role actor pada kedua RPC ini (CREATE OR REPLACE, bukan
-- tabel/RPC baru).
--
-- Corrective (verifikasi Gate 1C): revoke_telegram_salesman_identity semula
-- HANYA memfilter berdasar telegram_identities.company_id/user_id/is_active
-- -- tidak ada constraint/trigger skema yang membatasi baris
-- telegram_identities hanya untuk role 'sales' (lihat
-- 20260709000001_telegram_sales_order_intake.sql: CREATE TABLE
-- telegram_identities tidak punya CHECK/trigger role apa pun). Jika role
-- target berubah setelah pairing dibuat (mis. Salesman dipromosikan jadi
-- admin/manager tanpa identity di-revoke lebih dulu), direct RPC call
-- sebelumnya tetap bisa mencabut identity milik non-sales. Ditambahkan
-- v_target_is_sales check independen (user_roles/roles, sama seperti pada
-- issue) SEBELUM lookup identity; target non-sales mengembalikan
-- 'not_found' yang sama seperti tidak ada identity aktif sama sekali --
-- tidak membocorkan keberadaan user/identity ke actor. Target boleh
-- user.is_active TRUE atau FALSE (tidak diperiksa di sini, sengaja --
-- reset harus tetap berhasil untuk Salesman nonaktif).
--
-- Final corrective (claim-time eligibility): claim_telegram_salesman_identity
-- SUDAH memiliki re-check tenant/role/active pada saat klaim (query v_user
-- mensyaratkan company_id = v_token.company_id DAN is_active = TRUE; query
-- v_has_sales_role mensyaratkan role 'sales' pada company_id yang sama --
-- keduanya dievaluasi ulang terhadap state SAAT klaim, bukan saat issue,
-- dan keduanya berjalan SEBELUM identity dibuat/diaktifkan atau claimed_at
-- ditulis). Gap sesungguhnya: cabang gagalnya mengembalikan outcome
-- 'not_eligible' yang berbeda dari 'invalid_or_expired' -- buildEnrollmentReply
-- (workflow.ts) memetakan 'not_eligible' ke pesan berbeda ("akun Salesman
-- sudah tidak aktif/tidak memenuhi syarat"), yang membocorkan ke pengirim
-- Telegram bahwa KODE-nya sah tapi akunnya bermasalah -- sinyal yang bisa
-- dibedakan dari "kode salah/kedaluwarsa". Dinormalisasi ke
-- 'invalid_or_expired' (outcome aman yang sudah ada, bukan kode baru) supaya
-- ineligible-at-claim tidak bisa dibedakan dari kode invalid/kedaluwarsa.
-- Token tetap di-revoke pada state ini (perilaku existing, mencegah retry)
-- -- hanya outcome yang dikembalikan ke caller yang berubah. Tidak ada
-- perubahan pada lifecycle klaim, identity, atau audit trail lainnya.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.issue_telegram_salesman_enrollment(
  p_company_id UUID,
  p_user_id UUID,
  p_token_hash TEXT,
  p_expires_at TIMESTAMPTZ,
  p_created_by UUID
)
RETURNS TABLE(result_outcome TEXT, enrollment_token_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_token_id UUID;
  v_actor_allowed BOOLEAN;
  v_target_allowed BOOLEAN;
BEGIN
  IF p_token_hash IS NULL
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_expires_at <= NOW()
     OR p_expires_at > NOW() + INTERVAL '1 hour' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_created_by
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_user_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'sales'
  ) INTO v_target_allowed;

  IF NOT v_target_allowed THEN
    RETURN QUERY SELECT 'not_eligible'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.telegram_identities ti
    WHERE ti.company_id = p_company_id
      AND ti.user_id = p_user_id
      AND ti.is_active = TRUE
  ) THEN
    RETURN QUERY SELECT 'already_linked'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Serialize issuance per Salesman so two concurrent clicks cannot leave two
  -- usable tokens.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::TEXT, 0));

  UPDATE public.telegram_enrollment_tokens
  SET revoked_at = NOW()
  WHERE company_id = p_company_id
    AND user_id = p_user_id
    AND claimed_at IS NULL
    AND revoked_at IS NULL;

  INSERT INTO public.telegram_enrollment_tokens (
    company_id,
    user_id,
    token_hash,
    expires_at,
    created_by
  ) VALUES (
    p_company_id,
    p_user_id,
    LOWER(p_token_hash),
    p_expires_at,
    p_created_by
  )
  RETURNING id INTO v_token_id;

  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  ) VALUES (
    p_company_id,
    p_created_by,
    'telegram.enrollment_issued',
    'telegram_enrollment_tokens',
    v_token_id,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'expires_at', p_expires_at
    )
  );

  RETURN QUERY SELECT 'issued'::TEXT, v_token_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_telegram_salesman_identity(
  p_company_id UUID,
  p_user_id UUID,
  p_revoked_by UUID
)
RETURNS TABLE(result_outcome TEXT, telegram_identity_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_identity public.telegram_identities%ROWTYPE;
  v_actor_allowed BOOLEAN;
  v_target_is_sales BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_revoked_by
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name = 'owner'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  -- Target harus role 'sales' pada tenant yang sama, terlepas dari
  -- users.is_active (Salesman nonaktif tetap boleh direset). Tidak ada
  -- constraint skema yang menjamin ini untuk telegram_identities, jadi
  -- diperiksa independen di sini -- bukan mengandalkan gate role saat
  -- issue. Target non-sales mendapat outcome yang sama dengan "tidak ada
  -- identity aktif" supaya tidak membocorkan keberadaan user/identity.
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND ur.company_id = p_company_id
      AND r.name = 'sales'
  ) INTO v_target_is_sales;

  IF NOT v_target_is_sales THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  SELECT *
  INTO v_identity
  FROM public.telegram_identities
  WHERE company_id = p_company_id
    AND user_id = p_user_id
    AND is_active = TRUE
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  DELETE FROM public.telegram_conversation_state AS tcs
  WHERE tcs.telegram_identity_id = v_identity.id;

  DELETE FROM public.delivery_conversation_state AS dcs
  WHERE dcs.telegram_identity_id = v_identity.id;

  UPDATE public.telegram_identities
  SET is_active = FALSE,
      updated_at = NOW()
  WHERE id = v_identity.id;

  UPDATE public.telegram_enrollment_tokens
  SET revoked_at = NOW()
  WHERE company_id = p_company_id
    AND user_id = p_user_id
    AND claimed_at IS NULL
    AND revoked_at IS NULL;

  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    entity_type,
    entity_id,
    old_data,
    new_data
  ) VALUES (
    p_company_id,
    p_revoked_by,
    'telegram.identity_disconnected',
    'telegram_identities',
    v_identity.id,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'telegram_chat_id', v_identity.telegram_chat_id,
      'is_active', TRUE
    ),
    jsonb_build_object(
      'target_user_id', p_user_id,
      'is_active', FALSE
    )
  );

  RETURN QUERY SELECT 'revoked'::TEXT, v_identity.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_telegram_salesman_identity(
  p_token_hash TEXT,
  p_telegram_chat_id BIGINT,
  p_telegram_user_id BIGINT,
  p_telegram_username TEXT DEFAULT NULL
)
RETURNS TABLE(
  result_outcome TEXT,
  telegram_identity_id UUID,
  result_company_id UUID,
  result_user_id UUID,
  result_user_full_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_token public.telegram_enrollment_tokens%ROWTYPE;
  v_user public.users%ROWTYPE;
  v_existing public.telegram_identities%ROWTYPE;
  v_identity_id UUID;
  v_has_sales_role BOOLEAN;
  v_user_found BOOLEAN := FALSE;
BEGIN
  IF p_token_hash IS NULL
     OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_telegram_chat_id IS NULL
     OR p_telegram_user_id IS NULL
     OR p_telegram_chat_id <> p_telegram_user_id THEN
    RETURN QUERY
      SELECT 'invalid_or_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  SELECT *
  INTO v_token
  FROM public.telegram_enrollment_tokens
  WHERE token_hash = LOWER(p_token_hash)
  FOR UPDATE;

  IF NOT FOUND
     OR v_token.revoked_at IS NOT NULL
     OR v_token.expires_at <= NOW() THEN
    RETURN QUERY
      SELECT 'invalid_or_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Idempotent recovery: if the database claim committed but the webhook
  -- failed before writing its event ledger / sending the reply, the exact
  -- same Telegram account may retry safely. A different account still gets
  -- the generic invalid result.
  IF v_token.claimed_at IS NOT NULL THEN
    IF v_token.claimed_telegram_chat_id = p_telegram_chat_id
       AND v_token.claimed_telegram_user_id = p_telegram_user_id THEN
      SELECT ti.id
      INTO v_identity_id
      FROM public.telegram_identities ti
      WHERE ti.company_id = v_token.company_id
        AND ti.user_id = v_token.user_id
        AND ti.telegram_chat_id = p_telegram_chat_id
        AND ti.is_active = TRUE;

      IF FOUND THEN
        SELECT *
        INTO v_user
        FROM public.users
        WHERE id = v_token.user_id
          AND company_id = v_token.company_id
          AND is_active = TRUE;

        IF FOUND THEN
          RETURN QUERY
            SELECT
              'claimed'::TEXT,
              v_identity_id,
              v_token.company_id,
              v_token.user_id,
              v_user.full_name::TEXT;
          RETURN;
        END IF;
      END IF;
    END IF;

    RETURN QUERY
      SELECT 'invalid_or_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  -- Claim-time eligibility re-check (Gate 1C final corrective). Role or
  -- active status can change in the window between issue and claim; both
  -- are re-verified here against CURRENT state, scoped to the tenant
  -- recorded on the token itself (v_token.company_id) -- never trusting
  -- issue-time eligibility. This runs strictly before any
  -- telegram_identities write, before claimed_at is set, and before any
  -- success audit event.
  SELECT *
  INTO v_user
  FROM public.users
  WHERE id = v_token.user_id
    AND company_id = v_token.company_id
    AND is_active = TRUE;
  v_user_found := FOUND;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = v_token.user_id
      AND ur.company_id = v_token.company_id
      AND r.name = 'sales'
  ) INTO v_has_sales_role;

  -- Ineligible target (tenant mismatch, role no longer 'sales', or
  -- deactivated) is folded into the SAME safe outcome used for a bad code
  -- ('invalid_or_expired') -- not a distinct 'not_eligible' -- so the
  -- Telegram claimant cannot tell "your account changed" apart from
  -- "wrong/expired code". The token is still revoked so it cannot be
  -- retried once eligibility is gone (existing behavior, unchanged); no
  -- identity is created/activated and no success audit event is written.
  IF NOT v_user_found OR NOT v_has_sales_role THEN
    UPDATE public.telegram_enrollment_tokens
    SET revoked_at = NOW()
    WHERE id = v_token.id;
    RETURN QUERY
      SELECT 'invalid_or_expired'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  SELECT *
  INTO v_existing
  FROM public.telegram_identities
  WHERE telegram_chat_id = p_telegram_chat_id;

  IF FOUND AND (
    v_existing.company_id <> v_token.company_id
    OR v_existing.user_id <> v_token.user_id
  ) THEN
    RETURN QUERY
      SELECT 'chat_in_use'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.telegram_identities ti
    WHERE ti.user_id = v_token.user_id
      AND ti.is_active = TRUE
      AND ti.telegram_chat_id <> p_telegram_chat_id
  ) THEN
    RETURN QUERY
      SELECT 'user_already_linked'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
    RETURN;
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.telegram_identities
    SET telegram_user_id = p_telegram_user_id,
        telegram_username = LEFT(NULLIF(p_telegram_username, ''), 255),
        is_active = TRUE,
        updated_at = NOW()
    WHERE id = v_existing.id
    RETURNING id INTO v_identity_id;
  ELSE
    INSERT INTO public.telegram_identities (
      company_id,
      user_id,
      telegram_chat_id,
      telegram_user_id,
      telegram_username,
      is_active,
      created_by
    ) VALUES (
      v_token.company_id,
      v_token.user_id,
      p_telegram_chat_id,
      p_telegram_user_id,
      LEFT(NULLIF(p_telegram_username, ''), 255),
      TRUE,
      v_token.created_by
    )
    RETURNING id INTO v_identity_id;
  END IF;

  UPDATE public.telegram_enrollment_tokens
  SET claimed_at = NOW(),
      claimed_telegram_chat_id = p_telegram_chat_id,
      claimed_telegram_user_id = p_telegram_user_id,
      claimed_telegram_username = LEFT(NULLIF(p_telegram_username, ''), 255)
  WHERE id = v_token.id;

  INSERT INTO public.audit_logs (
    company_id,
    user_id,
    action,
    entity_type,
    entity_id,
    new_data
  ) VALUES (
    v_token.company_id,
    v_token.user_id,
    'telegram.identity_enrolled',
    'telegram_identities',
    v_identity_id,
    jsonb_build_object(
      'enrollment_token_id', v_token.id,
      'issued_by', v_token.created_by,
      'telegram_chat_id', p_telegram_chat_id
    )
  );

  RETURN QUERY
    SELECT
      'claimed'::TEXT,
      v_identity_id,
      v_token.company_id,
      v_token.user_id,
      v_user.full_name::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_telegram_salesman_enrollment(UUID, UUID, TEXT, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_telegram_salesman_identity(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_telegram_salesman_identity(TEXT, BIGINT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.issue_telegram_salesman_enrollment(UUID, UUID, TEXT, TIMESTAMPTZ, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_telegram_salesman_identity(UUID, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_telegram_salesman_identity(TEXT, BIGINT, BIGINT, TEXT)
  TO service_role;
