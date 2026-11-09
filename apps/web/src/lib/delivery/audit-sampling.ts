// =============================================================================
// Audit acak pengiriman: pemilihan sampel. Murni (rng bisa disuntik untuk test).
// Prioritas: diinput admin > tanpa lokasi > ada selisih > acak; sisa slot diisi acak.
// =============================================================================

export type AuditReason = "admin_input" | "no_location" | "variance" | "random";

export interface AuditCandidate {
  deliveryId: string;
  inputByAdmin: boolean;
  hasLocation: boolean;
  hasVariance: boolean;
}

export function classifyCandidate(c: AuditCandidate): AuditReason {
  if (c.inputByAdmin) return "admin_input";
  if (!c.hasLocation) return "no_location";
  if (c.hasVariance) return "variance";
  return "random";
}

const PRIORITY: AuditReason[] = ["admin_input", "no_location", "variance"];

function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Memilih sampai `count` pengiriman. Slot terisi lebih dulu oleh kelompok prioritas
 * (diacak di dalam kelompok), lalu sisanya dari kelompok acak. Tidak ada duplikat.
 */
export function selectAuditSample(
  candidates: AuditCandidate[],
  count: number,
  rng: () => number = Math.random,
): { deliveryId: string; reason: AuditReason }[] {
  const n = Math.max(0, Math.floor(count));
  const groups = new Map<AuditReason, AuditCandidate[]>();
  for (const c of candidates) {
    const r = classifyCandidate(c);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  }
  const picked: { deliveryId: string; reason: AuditReason }[] = [];
  for (const reason of [...PRIORITY, "random" as AuditReason]) {
    for (const c of shuffle(groups.get(reason) ?? [], rng)) {
      if (picked.length >= n) return picked;
      picked.push({ deliveryId: c.deliveryId, reason });
    }
  }
  return picked;
}

export const AUDIT_REASON_LABEL: Record<AuditReason, string> = {
  admin_input: "Diinput admin",
  no_location: "Tanpa lokasi",
  variance: "Ada selisih",
  random: "Acak",
};
