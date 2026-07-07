-- =============================================================================
-- Migration: Seed System Role Permissions
-- Mapping role -> permission untuk system roles. Sebelumnya mapping ini ikut
-- di seed tenant (dihapus saat fork AODP), padahal berlaku generik untuk
-- semua tenant. Tanpa mapping ini, permission check gagal untuk semua user.
-- =============================================================================

-- Owner: semua permission
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name = 'owner' AND r.is_system_role = TRUE
ON CONFLICT DO NOTHING;

-- Manager: semua kecuali manajemen settings/companies/ai/automation
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name = 'manager' AND r.is_system_role = TRUE
  AND p.name NOT IN ('settings.manage','companies.manage','ai.manage','automation.manage')
ON CONFLICT DO NOTHING;

-- Sales: akses lapangan — customer, order, produk, laporan, AI insight
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name = 'sales' AND r.is_system_role = TRUE
  AND p.name IN (
    'customers.view','customers.update',
    'orders.view','orders.create','orders.update',
    'products.view',
    'reports.view',
    'ai.view'
  )
ON CONFLICT DO NOTHING;

-- Admin: data master + laporan
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name = 'admin' AND r.is_system_role = TRUE
  AND p.name IN (
    'customers.view','customers.create','customers.update',
    'products.view','products.create','products.update',
    'orders.view','orders.create','orders.update',
    'reports.view','reports.export',
    'users.view',
    'settings.view'
  )
ON CONFLICT DO NOTHING;
