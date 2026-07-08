// =============================================================================
// Demo Mode — bypass login untuk kebutuhan demo lokal, development-only.
//
// TIDAK PERNAH aktif di production: process.env.NODE_ENV di-inline oleh Next.js
// saat build (baik untuk bundle client maupun server), sehingga cabang kode yang
// bergantung pada isDemoModeAllowed() dieliminasi dari build production oleh
// minifier — bukan hanya disembunyikan di UI.
//
// File ini edge-safe (dipakai juga oleh middleware) — jangan tambahkan import
// Node-only di sini.
// =============================================================================

export const DEMO_MODE_COOKIE = "aodp_demo_mode";

export function isDemoModeAllowed(): boolean {
  return process.env.NODE_ENV === "development";
}
