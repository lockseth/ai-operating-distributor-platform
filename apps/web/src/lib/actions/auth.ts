"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { logAuditEvent } from "@/lib/actions/audit";
import { DEMO_MODE_COOKIE, isDemoModeAllowed } from "@/lib/demo/config";

export async function signOutAction(): Promise<void> {
  // Sesi demo tidak pernah menyentuh Supabase — keluar cukup hapus cookie-nya.
  if (isDemoModeAllowed()) {
    const cookieStore = await cookies();
    if (cookieStore.get(DEMO_MODE_COOKIE)?.value === "1") {
      cookieStore.delete(DEMO_MODE_COOKIE);
      redirect("/login");
    }
  }

  const supabase = await createClient();

  // Capture user before signing out for audit log
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profileData } = await supabase
      .from("users")
      .select("id, company_id")
      .eq("id", user.id)
      .maybeSingle();

    const profile = profileData as { id: string; company_id: string } | null;

    if (profile) {
      await logAuditEvent({
        company_id: profile.company_id,
        user_id: profile.id,
        action: "logout",
        entity_type: "session",
        new_data: { email: user.email },
      });
    }
  }

  await supabase.auth.signOut();
  redirect("/login");
}
