-- =============================================================================
-- Telegram Salesman Identity Enrollment
--
-- Security contract:
--   * Admin issues a high-entropy, single-use token for an ACTIVE Salesman in
--     the same tenant.
--   * Only SHA-256(token) is stored. The raw token is shown once by the app.
--   * Claim is atomic (SELECT ... FOR UPDATE) and restricted to service_role.
--   * One Telegram private chat and one internal Salesman may each have only
--     one active identity.
--   * Tenant and user identity come from the issued token, never Telegram
--     payload fields.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.telegram_enrollment_tokens (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                 UUID        NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  user_id                    UUID        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  token_hash                 TEXT        NOT NULL UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at                 TIMESTAMPTZ NOT NULL,
  created_by                 UUID        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at                 TIMESTAMPTZ,
  claimed_telegram_chat_id   BIGINT,
  claimed_telegram_user_id   BIGINT,
  claimed_telegram_username  VARCHAR(255),
  revoked_at                 TIMESTAMPTZ,
  CONSTRAINT chk_telegram_enrollment_expiry
    CHECK (expires_at > created_at),
  CONSTRAINT chk_telegram_enrollment_claim
    CHECK (
      (claimed_at IS NULL AND claimed_telegram_chat_id IS NULL)
      OR
      (claimed_at IS NOT NULL AND claimed_telegram_chat_id IS NOT NULL)
    )
);

CREATE INDEX idx_telegram_enrollment_company
  ON public.telegram_enrollment_tokens (company_id, created_at DESC);
CREATE INDEX idx_telegram_enrollment_user
  ON public.telegram_enrollment_tokens (user_id, created_at DESC);
CREATE INDEX idx_telegram_enrollment_pending
  ON public.telegram_enrollment_tokens (expires_at)
  WHERE claimed_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE public.telegram_enrollment_tokens IS
  'Single-use Telegram Salesman enrollment credentials. token_hash is SHA-256; raw tokens are never persisted.';

ALTER TABLE public.telegram_enrollment_tokens ENABLE ROW LEVEL SECURITY;

-- Existing schema only guaranteed uniqueness by Telegram chat. Enrollment
-- also guarantees one ACTIVE identity per internal user. Fail the migration
-- explicitly if legacy duplicates need manual review; never silently delete.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.telegram_identities
    WHERE is_active = TRUE
    GROUP BY user_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce one active Telegram identity per user: legacy duplicates exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_telegram_identity_active_user
  ON public.telegram_identities (user_id)
  WHERE is_active = TRUE;

-- ---------------------------------------------------------------------------
-- Atomic issuance.
-- p_company_id and p_created_by are derived from the authenticated server
-- session by the Server Action. This routine independently verifies actor,
-- target tenant, active state, and Salesman role before issuing.
-- ---------------------------------------------------------------------------
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
      AND r.name IN ('owner','manager','admin','super_admin')
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

-- ---------------------------------------------------------------------------
-- Atomic claim from Telegram webhook.
-- Raw token is hashed in application memory before this routine is called.
-- ---------------------------------------------------------------------------
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

  IF NOT v_user_found OR NOT v_has_sales_role THEN
    UPDATE public.telegram_enrollment_tokens
    SET revoked_at = NOW()
    WHERE id = v_token.id;
    RETURN QUERY
      SELECT 'not_eligible'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT;
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

-- ---------------------------------------------------------------------------
-- Atomic disconnect from the dashboard. Conversation state is removed so a
-- future re-enrollment can never resume an abandoned order/delivery flow.
-- ---------------------------------------------------------------------------
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
      AND r.name IN ('owner','manager','admin','super_admin')
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::UUID;
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

REVOKE ALL ON TABLE public.telegram_enrollment_tokens
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_telegram_salesman_enrollment(UUID, UUID, TEXT, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_telegram_salesman_identity(TEXT, BIGINT, BIGINT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_telegram_salesman_identity(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.issue_telegram_salesman_enrollment(UUID, UUID, TEXT, TIMESTAMPTZ, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_telegram_salesman_identity(TEXT, BIGINT, BIGINT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_telegram_salesman_identity(UUID, UUID, UUID)
  TO service_role;
