"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { logAuditEvent } from "@/lib/actions/audit";

export async function signOutAction(): Promise<void> {
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
