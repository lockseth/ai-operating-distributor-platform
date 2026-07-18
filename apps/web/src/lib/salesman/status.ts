// =============================================================================
// Resolusi status Telegram Salesman — murni, tanpa I/O. Menggunakan domain
// model yang sudah ada (telegram_identities.is_active,
// telegram_enrollment_tokens.claimed_at/revoked_at/expires_at). Tidak ada
// enum/kolom baru.
// =============================================================================

export type SalesmanTelegramStatus =
  | "not_connected" // Belum Terhubung
  | "pairing_active" // Pairing Code Aktif
  | "connected" // Terhubung
  | "pairing_expired" // Pairing Kedaluwarsa
  | "disconnected"; // Diputuskan/Dicabut

export interface PendingEnrollmentToken {
  expiresAt: string;
  claimedAt: string | null;
  revokedAt: string | null;
}

export interface ResolveSalesmanTelegramStatusInput {
  hasActiveIdentity: boolean;
  hadPreviousIdentity: boolean;
  pendingToken: PendingEnrollmentToken | null;
  now?: Date;
}

export function resolveSalesmanTelegramStatus(
  input: ResolveSalesmanTelegramStatusInput
): SalesmanTelegramStatus {
  if (input.hasActiveIdentity) return "connected";

  const now = input.now ?? new Date();
  const token = input.pendingToken;
  if (token && !token.claimedAt && !token.revokedAt) {
    return new Date(token.expiresAt).getTime() > now.getTime()
      ? "pairing_active"
      : "pairing_expired";
  }

  if (input.hadPreviousIdentity) return "disconnected";

  return "not_connected";
}

export const SALESMAN_TELEGRAM_STATUS_LABEL: Record<SalesmanTelegramStatus, string> = {
  not_connected: "Belum Terhubung",
  pairing_active: "Pairing Code Aktif",
  connected: "Terhubung",
  pairing_expired: "Pairing Kedaluwarsa",
  disconnected: "Diputuskan/Dicabut",
};
