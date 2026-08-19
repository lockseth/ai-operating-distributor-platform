// =============================================================================
// Validasi input form Tambah Webhook -- pure function (tanpa I/O), supaya
// bisa diuji unit tanpa DB. Dipanggil dari createN8nWebhookAction sebelum
// insert ke n8n_webhooks.
// =============================================================================

export interface WebhookInput {
  name: string;
  eventType: string;
  webhookUrl: string;
}

// RLS n8n_webhooks (migration 20260626000008, policy "nw_manage") sudah
// membatasi INSERT/UPDATE/DELETE ke role ini persis -- BUKAN termasuk
// manager (beda dari automation_rules). Dipakai server component (page.tsx,
// untuk tampil/sembunyikan tombol) dan server action (actions.ts, defense-
// in-depth) -- ditaruh di file non-"use server" ini supaya bisa diimport
// keduanya (file "use server" cuma boleh export async function).
export const WEBHOOK_MANAGE_ROLES = ["owner", "admin", "super_admin"];

export function canManageWebhooks(user: { roles: string[] }): boolean {
  return WEBHOOK_MANAGE_ROLES.some((role) => user.roles.includes(role));
}

export function validateWebhookInput(input: WebhookInput): string | null {
  const name = input.name.trim();
  const eventType = input.eventType.trim();
  const webhookUrl = input.webhookUrl.trim();

  if (!name) return "Nama webhook wajib diisi.";
  if (!eventType) return "Event type wajib dipilih.";
  if (!webhookUrl) return "URL webhook wajib diisi.";

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    return "URL webhook tidak valid.";
  }
  // Wajib https -- webhook ini akan membawa secret_key & payload data bisnis,
  // http:// mengirim itu semua polos tanpa enkripsi.
  if (parsedUrl.protocol !== "https:") {
    return "URL webhook wajib pakai https:// (bukan http://).";
  }

  return null;
}
