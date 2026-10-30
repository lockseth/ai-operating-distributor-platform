// =============================================================================
// Signed URL bukti pengiriman (foto/tanda tangan) dari bucket privat
// delivery-evidence untuk panel pengiriman di detail order. Bukti lama dari
// jalur Telegram (storageRef = file id / teks) TIDAK berisi path bucket dan
// dilewati. Hanya path di bawah folder company sendiri yang disign.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryEvidenceRecord } from "./types";

export const DELIVERY_EVIDENCE_BUCKET = "delivery-evidence";
const SIGNED_URL_EXPIRY_SECONDS = 600;

export function isBucketBackedEvidence(
  e: Pick<DeliveryEvidenceRecord, "evidenceType" | "storageRef">,
  companyId: string,
): boolean {
  return (
    (e.evidenceType === "photo" || e.evidenceType === "signature") &&
    e.storageRef.startsWith(`${companyId}/`) &&
    !e.storageRef.includes("..")
  );
}

/** Peta evidenceId -> signed URL. Gagal sign = tidak ada entri (UI jatuh ke ikon). */
export async function resolveDeliveryEvidenceUrls(
  client: SupabaseClient,
  companyId: string,
  evidence: DeliveryEvidenceRecord[],
): Promise<Record<string, string>> {
  const backed = evidence.filter((e) => isBucketBackedEvidence(e, companyId));
  if (backed.length === 0) return {};
  const { data, error } = await client.storage
    .from(DELIVERY_EVIDENCE_BUCKET)
    .createSignedUrls(backed.map((e) => e.storageRef), SIGNED_URL_EXPIRY_SECONDS);
  if (error || !data) return {};
  const urls: Record<string, string> = {};
  data.forEach((row, i) => {
    if (row.signedUrl) urls[backed[i].id] = row.signedUrl;
  });
  return urls;
}
