// =============================================================================
// Resolusi target pengiriman final untuk dispatch route -- diekstrak jadi
// modul terpisah supaya bisa diuji unit tanpa mock Request/NextResponse.
//
// TEST OVERRIDE (insiden 2026-08-22): trigger manual/tes sempat mengirim WA
// nyata ke nomor client asli (Owner tenant) tanpa pemberitahuan dulu --
// recipient_reference SELALU data produksi, tidak ada jalur yang membedakan
// "ini tes" dari "ini beneran". Kalau BABLAST_TEST_OVERRIDE_PHONE /
// TELEGRAM_TEST_OVERRIDE_CHAT_ID diset, SEMUA pengiriman channel itu --
// termasuk saat *_DRY_RUN=false -- dialihkan ke sana, bukan recipient_reference
// asli. Pagar keras, bukan sekadar "ingat-ingat manual".
// =============================================================================

export function resolveTelegramTarget(recipientReference: string): number {
  const override = process.env.TELEGRAM_TEST_OVERRIDE_CHAT_ID;
  const raw = override || recipientReference;
  return Number(raw);
}

export function resolveWhatsAppTarget(recipientReference: string): string {
  const override = process.env.BABLAST_TEST_OVERRIDE_PHONE;
  return override || recipientReference;
}
