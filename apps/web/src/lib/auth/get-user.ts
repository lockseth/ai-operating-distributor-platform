import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

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
  };
  roles: string[];
  permissions: string[];
}

export async function getAuthUser(): Promise<AuthUser> {
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
    .select("id, name, slug, logo_url, subscription_plan")
    .eq("id", profile.company_id)
    .maybeSingle();

  const company = companyData as {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    subscription_plan: string;
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
  };
}
