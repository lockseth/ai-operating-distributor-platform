-- =============================================================================
-- Migration: 001 — Companies (Tenants)
-- FlowSales AI — Multi-Tenant Foundation
-- =============================================================================

-- ---------------------------------------------------------------------------
-- companies
-- Each row represents one tenant (distributor company).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.companies (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                VARCHAR(255) NOT NULL,
  slug                VARCHAR(100) NOT NULL UNIQUE,
  domain              VARCHAR(255),
  logo_url            TEXT,
  settings            JSONB        NOT NULL DEFAULT '{}',
  subscription_plan   VARCHAR(50)  NOT NULL DEFAULT 'trial'
                        CHECK (subscription_plan IN ('trial','starter','professional','enterprise')),
  subscription_status VARCHAR(50)  NOT NULL DEFAULT 'active'
                        CHECK (subscription_status IN ('active','inactive','suspended','cancelled')),
  is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_companies_slug   ON public.companies (slug);
CREATE INDEX idx_companies_active ON public.companies (is_active) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------------
-- Trigger: auto-update updated_at
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON TABLE  public.companies                   IS 'Multi-tenant: one row per distributor company';
COMMENT ON COLUMN public.companies.slug              IS 'URL-safe unique identifier used in subdomains / routing';
COMMENT ON COLUMN public.companies.settings          IS 'Tenant-level config (whitelabel, modules, preferences)';
COMMENT ON COLUMN public.companies.subscription_plan IS 'trial|starter|professional|enterprise';
