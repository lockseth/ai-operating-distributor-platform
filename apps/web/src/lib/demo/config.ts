// =============================================================================
// Demo Mode — bypass login untuk kebutuhan demo lokal, development-only.
//
// TIDAK PERNAH aktif di production: gate-nya adalah runtime check
// `process.env.NODE_ENV === "development"` (strict equality — allowlist,
// bukan denylist, jadi SETIAP nilai lain termasuk typo/kosong/salah
// kapitalisasi otomatis gagal closed, lihat config.test.ts). Diverifikasi
// LANGSUNG di production build (`next build` server chunk) bahwa kode ini
// TIDAK dihilangkan oleh minifier — pemanggilan isDemoModeAllowed() tetap
// ada dan dieksekusi saat runtime, bukan dieliminasi saat build. Jangan
// mengasumsikan dead-code elimination sebagai lapisan proteksi tambahan;
// satu-satunya jaminan adalah runtime check ini + Next.js/Vercel yang
// selalu men-set NODE_ENV=production di deployment production.
//
// File ini edge-safe (dipakai juga oleh middleware) — jangan tambahkan import
// Node-only di sini.
// =============================================================================

export const DEMO_MODE_COOKIE = "aodp_demo_mode";

export function isDemoModeAllowed(): boolean {
  return process.env.NODE_ENV === "development";
}
