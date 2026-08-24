"use server";

// =============================================================================
// Server action -- upload Bukti Pembayaran sungguhan (menggantikan tempelan
// link manual di object_reference). Pola persis uploadStorePhotoAction
// (lib/customer-pic/actions.ts) -- bucket privat, path SELALU dari sesi
// (getAuthUser()), tidak pernah dari client.
//
// Beda dari uploadStorePhotoAction: gate izin pakai "payment.record" (sama
// dengan recordVerifiedPaymentAction) karena ini data finansial, bukan
// "customers.create" -- dan mengizinkan application/pdf sekalian (struk
// transfer bank sering berupa PDF, bukan cuma foto).
// =============================================================================

import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";

const ALLOWED_PROOF_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
const MAX_PROOF_BYTES = 8 * 1024 * 1024; // sinkron dengan file_size_limit bucket payment-proofs

export interface UploadPaymentProofResult {
  ok: boolean;
  error?: string;
  path?: string;
}

export async function uploadPaymentProofAction(formData: FormData): Promise<UploadPaymentProofResult> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "payment.record")) {
    return { ok: false, error: "Tidak berwenang mengunggah bukti pembayaran." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "File tidak valid." };
  }
  if (!ALLOWED_PROOF_TYPES.includes(file.type)) {
    return { ok: false, error: "Format file harus JPEG, PNG, WebP, HEIC, atau PDF." };
  }
  if (file.size > MAX_PROOF_BYTES) {
    return { ok: false, error: "Ukuran file maksimal 8MB." };
  }

  const extFromType: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf",
  };
  const ext = extFromType[file.type] ?? "bin";
  const path = `${user.company_id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  const supabase = getAdminClient();
  const { error } = await supabase.storage.from("payment-proofs").upload(path, file, {
    contentType: file.type,
    upsert: false,
  });

  if (error) return { ok: false, error: "Gagal mengunggah bukti." };
  return { ok: true, path };
}
