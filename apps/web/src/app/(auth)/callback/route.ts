import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { getDashboardHref } from "@/lib/auth/permissions";
import { logAuditEvent } from "@/lib/actions/audit";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  // Resolve user profile to get role for redirect
  const { data: profileData } = await supabase
    .from("users")
    .select("id, company_id")
    .eq("id", data.user.id)
    .maybeSingle();

  const profile = profileData as { id: string; company_id: string } | null;

  let redirectPath = next ?? "/dashboard/owner";

  if (profile) {
    // Get role names
    const { data: userRolesData } = await supabase
      .from("user_roles")
      .select("role_id")
      .eq("user_id", profile.id)
      .eq("company_id", profile.company_id);

    const roleIds = ((userRolesData ?? []) as { role_id: string }[]).map(
      (r) => r.role_id
    );

    if (roleIds.length > 0) {
      const { data: rolesData } = await supabase
        .from("roles")
        .select("name")
        .in("id", roleIds);

      const roleNames = ((rolesData ?? []) as { name: string }[]).map(
        (r) => r.name
      );

      if (!next) {
        redirectPath = getDashboardHref(roleNames);
      }
    }

    // Audit log
    await logAuditEvent({
      company_id: profile.company_id,
      user_id: profile.id,
      action: "login",
      entity_type: "session",
      new_data: {
        provider: data.user.app_metadata?.provider ?? "email",
        email: data.user.email,
      },
    });
  }

  return NextResponse.redirect(`${origin}${redirectPath}`);
}
