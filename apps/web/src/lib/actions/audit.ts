"use server";

import { getAdminClient } from "@/lib/supabase/admin";

// module WAJIB diisi eksplisit oleh setiap caller (bukan default/inferred) --
// ini persis kontrak kanonis yang sebelumnya kosong di seluruh writer yang
// memakai helper ini (lihat docs/owner-control/ACTIVITY_AUDIT_COVERAGE_MATRIX.md,
// status "partial": "kontrak baru belum diisi"). event_category/source/outcome
// punya default yang benar utk mayoritas pemanggil (mutasi web sukses) --
// caller yang butuh nilai lain (mis. event_category='security' utk
// login/logout) mengirim eksplisit, menimpa default.
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
  module: string;
  actor_type?: string | null;
  event_category?: "audit" | "activity" | "security";
  source?: "web" | "telegram" | "whatsapp" | "ai" | "automation" | "rpc";
  outcome?: "success" | "rejected" | "unchanged" | "failed";
}

export async function logAuditEvent(input: AuditEventInput): Promise<void> {
  try {
    await getAdminClient().from("audit_logs").insert({
      company_id:     input.company_id,
      user_id:        input.user_id,
      action:         input.action,
      entity_type:    input.entity_type,
      entity_id:      input.entity_id      ?? null,
      old_data:       input.old_data       ?? null,
      new_data:       input.new_data       ?? null,
      ip_address:     input.ip_address     ?? null,
      user_agent:     input.user_agent     ?? null,
      actor_type:     input.actor_type     ?? null,
      event_category: input.event_category ?? "audit",
      module:         input.module,
      source:         input.source         ?? "web",
      outcome:        input.outcome        ?? "success",
    });
  } catch {
    // Audit log failure must never block the main flow
  }
}
