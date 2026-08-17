// =============================================================================
// Telegram capability separation (Gate 3E-D1-R1).
//
// Pairing identity Telegram digeneralisasi dari sales-only ke
// {owner, admin, sales} supaya seluruh role aktif nantinya bisa self-service
// reset password lewat Telegram. Keberadaan pairing TIDAK PERNAH otomatis
// memberi akses ke workflow lain -- setiap workflow adalah capability
// terpisah yang harus diizinkan eksplisit di sini. Fail-closed: role kosong,
// role tak dikenal, atau capability tak dikenal selalu ditolak.
//
// `driver` ditambahkan kemudian (2026-08-16, temuan role-play) -- dokumentasi
// docs/architecture/TELEGRAM_SALES_ORDER_ENTRY.md sudah lama menyatakan
// driver "memakai mekanisme yang sama persis" dengan sales untuk pairing,
// tapi array ini tidak pernah diperbarui saat Delivery Verification dibangun
// belakangan -- akibatnya halaman Pengguna tidak pernah menampilkan tombol
// "Buat tautan Telegram" untuk role driver sama sekali, dan
// "Assign & Kirim Tugas" (lib/delivery/actions.ts) SELALU gagal dengan
// "Driver ini belum terdaftar di Telegram" karena tidak ada jalur UI untuk
// mendaftarkannya. Driver TIDAK ditambahkan ke CAPABILITY_ROLES manapun di
// bawah -- pairing cuma bikin baris telegram_identities ada, tidak otomatis
// memberi capability password.reset.self/sales.order.telegram ke driver.
// =============================================================================

export const TELEGRAM_PAIRING_ELIGIBLE_ROLES = ["owner", "admin", "sales", "driver"] as const;
export type TelegramPairingRole = (typeof TELEGRAM_PAIRING_ELIGIBLE_ROLES)[number];

export type TelegramCapability = "password.reset.self" | "sales.order.telegram";

// password.reset.self: diimplementasikan di Gate 3E-D2-B (lib/telegram-
// password-reset/, app/api/webhooks/telegram/route.ts) -- kontrak di sini
// disiapkan sejak Gate 3E-D1-R1 supaya gate itu tidak perlu mengubah bentuk
// tabel ini, hanya memakainya.
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
