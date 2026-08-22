"use server";

// =============================================================================
// Server actions -- pairing & status WhatsApp sender (Bablast), Gate P4.13.
// Hanya owner/admin/super_admin -- setara sensitivitas dengan kelola webhook
// (lib/automation/webhook-validation.ts). BABLAST_API_KEY tidak pernah
// dikembalikan ke client -- hanya status/pairing code hasil respons provider.
// =============================================================================

import { getAuthUser } from "@/lib/auth/get-user";
import {
  getBablastConnectorStatus,
  initiateBablastPairing,
  type BablastConnectorStatus,
  type BablastPairingResult,
} from "./bablast";

const BABLAST_MANAGE_ROLES = ["owner", "admin", "super_admin"];

function canManageBablast(roles: string[]): boolean {
  return BABLAST_MANAGE_ROLES.some((role) => roles.includes(role));
}

export type BablastActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function checkBablastStatusAction(): Promise<BablastActionResult<BablastConnectorStatus>> {
  const user = await getAuthUser();
  if (!canManageBablast(user.roles)) return { ok: false, error: "Tidak punya izin." };

  try {
    const status = await getBablastConnectorStatus();
    return { ok: true, data: status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Gagal cek status Bablast." };
  }
}

export async function startBablastPairingAction(): Promise<BablastActionResult<BablastPairingResult>> {
  const user = await getAuthUser();
  if (!canManageBablast(user.roles)) return { ok: false, error: "Tidak punya izin." };

  try {
    const pairing = await initiateBablastPairing();
    return { ok: true, data: pairing };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Gagal memulai pairing Bablast." };
  }
}
