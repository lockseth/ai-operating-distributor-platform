-- =============================================================================
-- Migration: 004 — Row Level Security Policies
-- Multi-tenant isolation: every query is scoped to the user's company.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER — run as table owner, not caller)
-- ---------------------------------------------------------------------------

-- Returns the company_id of the currently authenticated user.
CREATE OR REPLACE FUNCTION public.get_user_company_id()
RETURNS UUID AS $$
  SELECT company_id FROM public.users WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns the role names of the currently authenticated user within their company.
CREATE OR REPLACE FUNCTION public.get_user_roles(p_user_id UUID DEFAULT auth.uid())
RETURNS TEXT[] AS $$
  SELECT ARRAY_AGG(r.name)
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = p_user_id
    AND ur.company_id = public.get_user_company_id()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns TRUE if the current user has any of the given roles.
CREATE OR REPLACE FUNCTION public.user_has_role(required_roles TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id    = auth.uid()
      AND ur.company_id = public.get_user_company_id()
      AND r.name = ANY(required_roles)
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Returns TRUE if the current user has the given permission.
CREATE OR REPLACE FUNCTION public.user_has_permission(permission_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id    = auth.uid()
      AND ur.company_id = public.get_user_company_id()
      AND p.name = permission_name
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---------------------------------------------------------------------------
-- Enable RLS on all tables
-- ---------------------------------------------------------------------------

ALTER TABLE public.companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_categories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_order_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings             ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- companies: users can only see their own company
-- ---------------------------------------------------------------------------

CREATE POLICY "company_self_select" ON public.companies
  FOR SELECT USING (id = public.get_user_company_id());

CREATE POLICY "company_owner_update" ON public.companies
  FOR UPDATE USING (
    id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- users: company-scoped + self-update
-- ---------------------------------------------------------------------------

CREATE POLICY "users_company_select" ON public.users
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "users_self_update" ON public.users
  FOR UPDATE USING (id = auth.uid());

CREATE POLICY "users_manager_update" ON public.users
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

CREATE POLICY "users_manager_insert" ON public.users
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- roles: users can read system roles + their company roles
-- ---------------------------------------------------------------------------

CREATE POLICY "roles_select" ON public.roles
  FOR SELECT USING (
    company_id IS NULL
    OR company_id = public.get_user_company_id()
  );

CREATE POLICY "roles_manage" ON public.roles
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- permissions: readable by all authenticated users
-- ---------------------------------------------------------------------------

CREATE POLICY "permissions_select" ON public.permissions
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- role_permissions: readable by all; managed by owner/super_admin
-- ---------------------------------------------------------------------------

CREATE POLICY "role_permissions_select" ON public.role_permissions
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ---------------------------------------------------------------------------
-- user_roles: company-scoped
-- ---------------------------------------------------------------------------

CREATE POLICY "user_roles_select" ON public.user_roles
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "user_roles_manage" ON public.user_roles
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- product_categories: company-scoped
-- ---------------------------------------------------------------------------

CREATE POLICY "product_categories_select" ON public.product_categories
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "product_categories_manage" ON public.product_categories
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('products.manage')
  );

-- ---------------------------------------------------------------------------
-- products: company-scoped
-- ---------------------------------------------------------------------------

CREATE POLICY "products_select" ON public.products
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('products.view')
  );

CREATE POLICY "products_insert" ON public.products
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('products.create')
  );

CREATE POLICY "products_update" ON public.products
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('products.update')
  );

CREATE POLICY "products_delete" ON public.products
  FOR DELETE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('products.delete')
  );

-- ---------------------------------------------------------------------------
-- customers: company-scoped; sales can only see assigned customers
-- ---------------------------------------------------------------------------

CREATE POLICY "customers_owner_select" ON public.customers
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('customers.manage')
      OR assigned_sales_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
    )
  );

CREATE POLICY "customers_insert" ON public.customers
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('customers.create')
  );

CREATE POLICY "customers_update" ON public.customers
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('customers.manage')
      OR assigned_sales_id = auth.uid()
    )
  );

CREATE POLICY "customers_delete" ON public.customers
  FOR DELETE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('customers.delete')
  );

-- ---------------------------------------------------------------------------
-- sales_orders: company-scoped; sales can only see own orders
-- ---------------------------------------------------------------------------

CREATE POLICY "sales_orders_select" ON public.sales_orders
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('orders.manage')
      OR sales_id = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','admin','finance','super_admin'])
    )
  );

CREATE POLICY "sales_orders_insert" ON public.sales_orders
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('orders.create')
  );

CREATE POLICY "sales_orders_update" ON public.sales_orders
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('orders.manage')
      OR (sales_id = auth.uid() AND status = 'draft')
    )
  );

CREATE POLICY "sales_orders_delete" ON public.sales_orders
  FOR DELETE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('orders.delete')
  );

-- ---------------------------------------------------------------------------
-- sales_order_items: inherit from sales_orders
-- ---------------------------------------------------------------------------

CREATE POLICY "order_items_select" ON public.sales_order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
    )
  );

CREATE POLICY "order_items_insert" ON public.sales_order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND public.user_has_permission('orders.create')
    )
  );

CREATE POLICY "order_items_update" ON public.sales_order_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND public.user_has_permission('orders.update')
    )
  );

CREATE POLICY "order_items_delete" ON public.sales_order_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND public.user_has_permission('orders.delete')
    )
  );

-- ---------------------------------------------------------------------------
-- audit_logs: company-scoped, SELECT only (INSERT via SECURITY DEFINER fn)
-- ---------------------------------------------------------------------------

CREATE POLICY "audit_logs_select" ON public.audit_logs
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

-- No UPDATE or DELETE allowed — audit logs are immutable.

-- ---------------------------------------------------------------------------
-- settings: company-scoped
-- ---------------------------------------------------------------------------

CREATE POLICY "settings_select" ON public.settings
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "settings_manage" ON public.settings
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('settings.manage')
  );
