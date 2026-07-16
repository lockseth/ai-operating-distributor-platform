import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { DEMO_MODE_COOKIE, isDemoModeAllowed } from "@/lib/demo/config";

export interface AuthUser {
  id: string;
  email: string;
  company_id: string;
  company: {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    subscription_plan: string;
    settings: Record<string, unknown> | null;
  };
  roles: string[];
  permissions: string[];
  /** true hanya untuk sesi demo bypass (development-only, lihat lib/demo/config.ts) */
  isDemo: boolean;
}

// Permission super-set (mengikuti seed role "owner" + varian "*.edit" yang
// dipakai sebagian halaman) supaya sesi demo bisa melihat seluruh UI owner
// tanpa bergantung pada data role_permissions di database.
const DEMO_AUTH_USER: AuthUser = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "demo-owner@aodp.local",
  company_id: "00000000-0000-0000-0000-000000000000",
  company: {
    id: "00000000-0000-0000-0000-000000000000",
    name: "AODP Demo Distributor",
    slug: "aodp-demo",
    logo_url: null,
    subscription_plan: "owner_protection",
    settings: null,
  },
  roles: ["owner"],
  permissions: [
    "companies.view", "companies.manage",
    "users.view", "users.create", "users.update", "users.delete", "users.manage",
    "products.view", "products.create", "products.update", "products.edit", "products.delete", "products.manage",
    "customers.view", "customers.create", "customers.update", "customers.edit", "customers.delete", "customers.manage",
    "orders.view", "orders.create", "orders.update", "orders.edit", "orders.delete", "orders.manage",
    "reports.view", "reports.create", "reports.update", "reports.export", "reports.manage",
    "settings.view", "settings.manage",
    "ai.view", "ai.manage",
    "automation.view", "automation.manage",
  ],
  isDemo: true,
};

export async function getAuthUser(): Promise<AuthUser> {
  if (isDemoModeAllowed()) {
    const cookieStore = await cookies();
    if (cookieStore.get(DEMO_MODE_COOKIE)?.value === "1") {
      return DEMO_AUTH_USER;
    }
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) redirect("/login");

  // User profile
  const { data: profileData } = await supabase
    .from("users")
    .select("id, company_id, email, full_name")
    .eq("id", user.id)
    .maybeSingle();

  const profile = profileData as {
    id: string;
    company_id: string;
    email: string;
    full_name: string;
  } | null;

  if (!profile) redirect("/login");

  // Company
  const { data: companyData } = await supabase
    .from("companies")
    .select("id, name, slug, logo_url, subscription_plan, settings")
    .eq("id", profile.company_id)
    .maybeSingle();

  const company = companyData as {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    subscription_plan: string;
    settings: Record<string, unknown> | null;
  } | null;

  if (!company) redirect("/login");

  // Role IDs
  const { data: userRolesData } = await supabase
    .from("user_roles")
    .select("role_id")
    .eq("user_id", profile.id)
    .eq("company_id", profile.company_id);

  const roleIds = ((userRolesData ?? []) as { role_id: string }[]).map(
    (r) => r.role_id
  );

  // Role names
  const roleNames: string[] = [];
  if (roleIds.length > 0) {
    const { data: rolesData } = await supabase
      .from("roles")
      .select("name")
      .in("id", roleIds);
    roleNames.push(...((rolesData ?? []) as { name: string }[]).map((r) => r.name));
  }

  // Permission IDs via role_permissions
  const permissionNames: string[] = [];
  if (roleIds.length > 0) {
    const { data: rolePermsData } = await supabase
      .from("role_permissions")
      .select("permission_id")
      .in("role_id", roleIds);

    const permIds = [
      ...new Set(
        ((rolePermsData ?? []) as { permission_id: string }[]).map(
          (rp) => rp.permission_id
        )
      ),
    ];

    if (permIds.length > 0) {
      const { data: permsData } = await supabase
        .from("permissions")
        .select("name")
        .in("id", permIds);
      permissionNames.push(
        ...((permsData ?? []) as { name: string }[]).map((p) => p.name)
      );
    }
  }

  return {
    id: profile.id,
    email: profile.email,
    company_id: profile.company_id,
    company,
    roles: roleNames,
    permissions: permissionNames,
    isDemo: false,
  };
}
