// =============================================================================
// Gate 3E-D2-B — Trigger phrase untuk self-service password reset via
// Telegram. EXACT-MATCH setelah normalisasi (trim, lowercase, kolaps
// whitespace berulang) -- BUKAN substring/free-text search, supaya teks
// order/chat biasa yang kebetulan mengandung kata "password" tidak salah
// terpicu (mis. "reset password saya nanti aja, order dulu ya").
// =============================================================================

const ALLOWED_TRIGGERS: ReadonlySet<string> = new Set([
  "lupa password",
  "ganti password",
  "reset password",
]);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function detectPasswordResetTrigger(text: string): boolean {
  return ALLOWED_TRIGGERS.has(normalize(text));
}
