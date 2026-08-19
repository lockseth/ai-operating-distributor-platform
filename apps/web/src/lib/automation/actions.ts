"use server";

import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { getAdminClient } from "@/lib/supabase/admin";
import { validateWebhookInput, canManageWebhooks } from "./webhook-validation";

export interface CreateN8nWebhookActionResult {
  ok: boolean;
  error?: string;
}

export async function createN8nWebhookAction(input: {
  name: string;
  eventType: string;
  webhookUrl: string;
  secretKey: string;
}): Promise<CreateN8nWebhookActionResult> {
  const user = await getAuthUser();

  if (user.isDemo) {
    return { ok: false, error: "Tambah webhook tidak tersedia pada sesi demo." };
  }
  if (!canManageWebhooks(user)) {
    return { ok: false, error: "Hanya owner/admin yang dapat menambahkan webhook." };
  }

  const validationError = validateWebhookInput(input);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const admin = getAdminClient();
  const { error } = await admin.from("n8n_webhooks").insert({
    company_id: user.company_id,
    name: input.name.trim(),
    event_type: input.eventType.trim(),
    webhook_url: input.webhookUrl.trim(),
    secret_key: input.secretKey.trim() || null,
    is_active: true,
  });

  if (error) {
    return { ok: false, error: "Gagal menyimpan webhook. Coba lagi." };
  }

  revalidatePath("/dashboard/automation");
  return { ok: true };
}
