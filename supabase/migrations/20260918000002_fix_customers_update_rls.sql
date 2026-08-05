-- ---------------------------------------------------------------------------
-- Fix customers_update RLS policy: it checked `customers.manage`, while the
-- application layer (updateCustomerAction) and the role seed both grant/check
-- `customers.update` (the permission actually seeded and assigned to admin
-- and sales). Owner/manager were unaffected (they hold both permissions via
-- blanket grants); `admin` passed the app-layer check but was silently
-- blocked by RLS. This aligns customers_update with the same pattern already
-- used by products_update (permission name matches what's seeded/checked
-- everywhere else), without broadening access for any role.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "customers_update" ON public.customers;

CREATE POLICY "customers_update" ON public.customers
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('customers.update')
      OR assigned_sales_id = auth.uid()
    )
  );
