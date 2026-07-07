const ROLE_PRIORITY: Record<string, number> = {
  super_admin: 8,
  owner: 7,
  manager: 6,
  admin: 5,
  finance: 4,
  warehouse: 3,
  sales: 2,
  driver: 1,
};

export function getPrimaryRole(roles: string[]): string {
  if (roles.length === 0) return "sales";
  return roles.reduce((highest, role) => {
    return (ROLE_PRIORITY[role] ?? 0) > (ROLE_PRIORITY[highest] ?? 0)
      ? role
      : highest;
  }, roles[0]);
}

export function getDashboardHref(roles: string[]): string {
  const ROLE_DASHBOARD: Record<string, string> = {
    super_admin: "/dashboard/platform",
    owner: "/dashboard/owner",
    manager: "/dashboard/manager",
    sales: "/dashboard/sales",
    warehouse: "/dashboard/warehouse",
    finance: "/dashboard/finance",
    admin: "/dashboard/admin",
    driver: "/dashboard/driver",
  };
  return ROLE_DASHBOARD[getPrimaryRole(roles)] ?? "/dashboard/owner";
}

export function hasPermission(
  permissions: string[],
  permission: string
): boolean {
  return permissions.includes(permission);
}

export function hasAnyPermission(
  permissions: string[],
  required: string[]
): boolean {
  return required.some((p) => permissions.includes(p));
}

export function hasRole(roles: string[], role: string | string[]): boolean {
  if (Array.isArray(role)) return role.some((r) => roles.includes(r));
  return roles.includes(role);
}

export function isSuperAdmin(roles: string[]): boolean {
  return roles.includes("super_admin");
}
