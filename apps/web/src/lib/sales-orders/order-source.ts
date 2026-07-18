// =============================================================================
// Order Source — klasifikasi BAGAIMANA toko menyampaikan pesanan kepada
// Salesman. Ini BUKAN channel input sistem (order tetap masuk hanya lewat
// Telegram Salesman — lihat sales_orders.source_channel, tidak diubah di
// sini). Deteksi rule-based dari kata kunci umum Bahasa Indonesia pada teks
// yang diketik Salesman, konsisten dengan extraction.ts (bukan panggilan AI
// vendor). Default OTHER bila tidak ada penanda jelas — order TIDAK PERNAH
// ditolak karena sumber tidak terdeteksi atau karena Salesman tidak berada
// di lokasi toko.
// =============================================================================

export type OrderSource =
  | "FIELD_VISIT"
  | "CUSTOMER_WHATSAPP"
  | "CUSTOMER_PHONE"
  | "REPEAT_ORDER"
  | "OTHER";

export const ORDER_SOURCE_LABEL: Record<OrderSource, string> = {
  FIELD_VISIT: "Kunjungan Langsung",
  CUSTOMER_WHATSAPP: "WhatsApp Toko",
  CUSTOMER_PHONE: "Telepon Toko",
  REPEAT_ORDER: "Order Berulang",
  OTHER: "Lainnya",
};

const REPEAT_PATTERN = /\b(repeat\s*order|order\s*ulang|langganan\s*rutin|reorder)\b/i;
const WHATSAPP_PATTERN = /\b(wa|whats\s*app|whatsapp)\b/i;
const PHONE_PATTERN = /\b(telp\w*|telepon|nelpon|call|ditelpon|dihubungi\s*telepon)\b/i;
const FIELD_VISIT_PATTERN = /\b(kunjung\w*|visit|datang\s*ke\s*toko|ketemu\s*langsung)\b/i;

/**
 * Deteksi murni berbasis kata kunci pada teks order dari Salesman. Tidak
 * pernah melempar exception dan tidak pernah memicu penolakan order — hanya
 * mengembalikan OTHER bila tidak ada penanda yang cocok.
 */
export function detectOrderSource(rawText: string): OrderSource {
  if (REPEAT_PATTERN.test(rawText)) return "REPEAT_ORDER";
  if (WHATSAPP_PATTERN.test(rawText)) return "CUSTOMER_WHATSAPP";
  if (PHONE_PATTERN.test(rawText)) return "CUSTOMER_PHONE";
  if (FIELD_VISIT_PATTERN.test(rawText)) return "FIELD_VISIT";
  return "OTHER";
}
