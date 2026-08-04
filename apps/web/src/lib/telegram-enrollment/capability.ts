// =============================================================================
// Telegram capability separation (Gate 3E-D1-R1).
//
// Pairing identity Telegram digeneralisasi dari sales-only ke
// {owner, admin, sales} supaya seluruh role aktif nantinya bisa self-service
// reset password lewat Telegram. Keberadaan pairing TIDAK PERNAH otomatis
// memberi akses ke workflow lain -- setiap workflow adalah capability
// terpisah yang harus diizinkan eksplisit di sini. Fail-closed: role kosong,
// role tak dikenal, atau capability tak dikenal selalu ditolak.
// =============================================================================

export const TELEGRAM_PAIRING_ELIGIBLE_ROLES = ["owner", "admin", "sales"] as const;
export type TelegramPairingRole = (typeof TELEGRAM_PAIRING_ELIGIBLE_ROLES)[number];

export type TelegramCapability = "password.reset.self" | "sales.order.telegram";

// password.reset.self: BELUM diimplementasikan di R1 (lihat Gate 3E-D1-R1) --
// hanya kontrak capability yang disiapkan supaya P2 tidak perlu mengubah
// bentuk tabel ini, hanya memakainya.
const CAPABILITY_ROLES: Record<TelegramCapability, readonly TelegramPairingRole[]> = {
  "password.reset.self": ["owner", "admin", "sales"],
  "sales.order.telegram": ["sales"],
};

export function hasTelegramCapability(
  roles: readonly string[] | null | undefined,
  capability: TelegramCapability,
): boolean {
  const allowed = CAPABILITY_ROLES[capability];
  if (!allowed || !roles || roles.length === 0) return false;
  return roles.some((role) => (allowed as readonly string[]).includes(role));
}
