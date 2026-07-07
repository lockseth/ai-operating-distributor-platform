"use server";

import { getAdminClient } from "@/lib/supabase/admin";

interface AuditEventInput {
  company_id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  old_data?: Record<string, unknown>;
  new_data?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
}

export async function logAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await getAdminClient().from("audit_logs").insert({
      company_id:  input.company_id,
      user_id:     input.user_id,
      action:      input.action,
      entity_type: input.entity_type,
      entity_id:   input.entity_id  ?? null,
      old_data:    input.old_data   ?? null,
      new_data:    input.new_data   ?? null,
      ip_address:  input.ip_address ?? null,
      user_agent:  input.user_agent ?? null,
    });
  } catch {
    // Audit log failure must never block the main flow
  }
}
