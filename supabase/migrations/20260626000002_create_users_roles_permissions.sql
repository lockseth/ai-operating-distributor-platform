-- =============================================================================
-- Migration: 002 — Users, Roles, Permissions
-- =============================================================================

-- ---------------------------------------------------------------------------
-- users (extends auth.users from Supabase Auth)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.users (
  id          UUID         PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  company_id  UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  email       VARCHAR(255) NOT NULL,
  full_name   VARCHAR(255) NOT NULL,
  avatar_url  TEXT,
  phone       VARCHAR(50),
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_company_id ON public.users (company_id);
CREATE INDEX idx_users_email      ON public.users (email);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE  public.users            IS 'App-level user profile, linked 1:1 to auth.users';
COMMENT ON COLUMN public.users.company_id IS 'Tenant this user belongs to';

-- ---------------------------------------------------------------------------
-- roles
-- System roles (company_id IS NULL) apply to all tenants.
-- Custom roles (company_id IS NOT NULL) are tenant-specific.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.roles (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID         REFERENCES public.companies (id) ON DELETE CASCADE,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  is_system_role BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_roles_company_id ON public.roles (company_id);

CREATE TRIGGER trg_roles_updated_at
  BEFORE UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.roles.company_id     IS 'NULL = system role available to all tenants';
COMMENT ON COLUMN public.roles.is_system_role IS 'System roles cannot be deleted by tenants';

-- ---------------------------------------------------------------------------
-- permissions
-- Fine-grained permission definitions (module.action).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.permissions (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL UNIQUE,
  module      VARCHAR(50)  NOT NULL,
  action      VARCHAR(50)  NOT NULL,
  description TEXT,
  UNIQUE (module, action)
);

COMMENT ON TABLE  public.permissions       IS 'Fine-grained permission definitions';
COMMENT ON COLUMN public.permissions.name  IS 'Canonical key: module.action (e.g. products.create)';

-- ---------------------------------------------------------------------------
-- role_permissions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id       UUID NOT NULL REFERENCES public.roles (id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES public.permissions (id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  role_id     UUID        NOT NULL REFERENCES public.roles (id) ON DELETE CASCADE,
  company_id  UUID        NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  assigned_by UUID        REFERENCES public.users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role_id, company_id)
);

CREATE INDEX idx_user_roles_user_id    ON public.user_roles (user_id);
CREATE INDEX idx_user_roles_company_id ON public.user_roles (company_id);

-- ---------------------------------------------------------------------------
-- Seed: System Roles
-- ---------------------------------------------------------------------------

INSERT INTO public.roles (name, description, is_system_role, company_id) VALUES
  ('super_admin', 'Platform super administrator — full access across all tenants', TRUE, NULL),
  ('owner',       'Company owner — full access within their tenant',               TRUE, NULL),
  ('manager',     'Sales or operations manager',                                   TRUE, NULL),
  ('sales',       'Field sales representative',                                    TRUE, NULL),
  ('admin',       'Back-office administrator',                                     TRUE, NULL),
  ('warehouse',   'Warehouse staff',                                               TRUE, NULL),
  ('finance',     'Finance and billing staff',                                     TRUE, NULL),
  ('driver',      'Delivery driver',                                               TRUE, NULL)
ON CONFLICT (company_id, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: Permissions
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  -- Companies
  ('companies.view',   'companies', 'view',   'View company details'),
  ('companies.manage', 'companies', 'manage', 'Full company management'),
  -- Users
  ('users.view',   'users', 'view',   'View user list'),
  ('users.create', 'users', 'create', 'Invite new users'),
  ('users.update', 'users', 'update', 'Update user profile'),
  ('users.delete', 'users', 'delete', 'Deactivate users'),
  ('users.manage', 'users', 'manage', 'Full user management'),
  -- Products
  ('products.view',   'products', 'view',   'View product catalog'),
  ('products.create', 'products', 'create', 'Add new products'),
  ('products.update', 'products', 'update', 'Edit products'),
  ('products.delete', 'products', 'delete', 'Delete products'),
  ('products.manage', 'products', 'manage', 'Full product management'),
  -- Customers
  ('customers.view',   'customers', 'view',   'View customer list'),
  ('customers.create', 'customers', 'create', 'Add new customers'),
  ('customers.update', 'customers', 'update', 'Edit customers'),
  ('customers.delete', 'customers', 'delete', 'Delete customers'),
  ('customers.manage', 'customers', 'manage', 'Full customer management'),
  -- Orders
  ('orders.view',   'orders', 'view',   'View orders'),
  ('orders.create', 'orders', 'create', 'Create sales orders'),
  ('orders.update', 'orders', 'update', 'Update orders'),
  ('orders.delete', 'orders', 'delete', 'Cancel/delete orders'),
  ('orders.manage', 'orders', 'manage', 'Full order management'),
  -- Reports
  ('reports.view',   'reports', 'view',   'View reports'),
  ('reports.export', 'reports', 'export', 'Export reports'),
  ('reports.manage', 'reports', 'manage', 'Full report management'),
  -- Settings
  ('settings.view',   'settings', 'view',   'View tenant settings'),
  ('settings.manage', 'settings', 'manage', 'Modify tenant settings'),
  -- AI
  ('ai.view',   'ai', 'view',   'View AI insights'),
  ('ai.manage', 'ai', 'manage', 'Manage AI configuration'),
  -- Automation
  ('automation.view',   'automation', 'view',   'View automation rules'),
  ('automation.manage', 'automation', 'manage', 'Manage automation')
ON CONFLICT (name) DO NOTHING;
