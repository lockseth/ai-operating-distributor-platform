-- =============================================================================
-- Gate 3E-D1-R1 — Generalize Telegram Identity Pairing Safely.
--
-- Konteks: audit keamanan Gate 3E-D1 menemukan pairing Telegram
-- (issue/claim/revoke_telegram_salesman_identity, migration 20260722000001 +
-- corrective 20260818000001) hanya mengizinkan target role 'sales'. Lock
-- arsitektur terbaru mensyaratkan Owner, Admin, dan Sales SEMUA bisa
-- melakukan self-service password reset lewat Telegram pairing -- pairing
-- untuk Owner/Admin belum mungkin dilakukan sama sekali sebelum migration
-- ini.
--
-- Perubahan pada migration ini HANYA predikat eligibility target role --
-- dari HANYA role sales, menjadi r.name IN ('owner','admin','sales') --
-- pada tiga routine yang sudah ada. TIDAK ADA perubahan pada: signature, actor gate
-- (issue/revoke tetap owner-only, mengikuti Gate 1C), token lifecycle,
-- klaim atomik, resolver, RLS, atau audit trail. CREATE OR REPLACE atas
-- routine yang sama -- bukan RPC/tabel baru.
--
-- SECURITY DECISION (Gate 3E-D1 audit): generalisasi pairing TIDAK BOLEH
-- otomatis memberi owner/admin akses ke workflow Sales Order/Delivery/
-- Dispute/Menu Telegram -- itu tetap capability 'sales.order.telegram',
-- role sales saja. Pemisahan capability itu ditangani di application layer
-- (apps/web/src/lib/telegram-enrollment/capability.ts +
-- SalesOrderTelegramRepository.hasSalesOrderCapability, dicek ulang di
-- lib/sales-orders/workflow.ts dan app/api/webhooks/telegram/route.ts
-- SEBELUM masuk workflow apa pun) -- BUKAN di migration ini. Migration ini
-- hanya membuat pairing itu sendiri mungkin untuk owner/admin; tidak
-- memberi mereka izin operasional apa pun.
--
-- Scope eksplisit R1 (tidak dikerjakan di sini): tidak ada pairing live,
-- tidak ada perubahan hosted data/config, tidak ada fitur password reset,
-- tidak ada perubahan UI (Dashboard -> Pengguna masih hanya menampilkan
-- tombol pairing untuk baris role sales -- lihat
-- apps/web/src/app/(dashboard)/dashboard/users/page.tsx, belum diubah).
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
  v_target_role_eligible BOOLEAN;
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

  -- Gate 3E-D1-R1: target eligible role digeneralisasi dari 'sales' saja
  -- menjadi {owner, admin, sales}. Ini HANYA membuat pairing-nya mungkin;
  -- akses ke workflow Sales Order tetap gate terpisah di application layer
  -- (lihat header migration).
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur
      ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_user_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND r.name IN ('owner','admin','sales')
  ) INTO v_target_role_eligible;

  IF NOT v_target_role_eligible THEN
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

  -- Serialize issuance per target user so two concurrent clicks cannot leave
  -- two usable tokens.
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
  v_target_role_eligible BOOLEAN;
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

  -- Gate 3E-D1-R1: target eligible role digeneralisasi sama seperti issue di
  -- atas (Gate 1C corrective tetap dipertahankan -- diperiksa independen
  -- SEBELUM lookup identity, tidak mensyaratkan users.is_active, dan target
  -- tidak eligible mendapat outcome sama dengan "tidak ada identity aktif"
  -- supaya tidak membocorkan keberadaan user/identity ke actor).
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_user_id
      AND ur.company_id = p_company_id
      AND r.name IN ('owner','admin','sales')
  ) INTO v_target_role_eligible;

  IF NOT v_target_role_eligible THEN
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
  v_has_eligible_role BOOLEAN;
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

  -- Claim-time eligibility re-check (Gate 1C final corrective, dipertahankan
  -- penuh). Gate 3E-D1-R1 hanya memperluas SET role yang eligible dari
  -- {'sales'} menjadi {'owner','admin','sales'} -- pola re-check terhadap
  -- state SAAT klaim, discope ke v_token.company_id, tetap sama persis.
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
      AND r.name IN ('owner','admin','sales')
  ) INTO v_has_eligible_role;

  -- Ineligible target (tenant mismatch, role no longer eligible, or
  -- deactivated) is folded into the SAME safe outcome used for a bad code
  -- ('invalid_or_expired') -- not a distinct 'not_eligible' -- so the
  -- Telegram claimant cannot tell "your account changed" apart from
  -- "wrong/expired code". The token is still revoked so it cannot be
  -- retried once eligibility is gone (existing behavior, unchanged); no
  -- identity is created/activated and no success audit event is written.
  IF NOT v_user_found OR NOT v_has_eligible_role THEN
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
