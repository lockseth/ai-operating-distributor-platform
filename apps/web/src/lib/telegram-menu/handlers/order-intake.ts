// =============================================================================
// Input Order WA/Telepon -- menu ini TIDAK menduplikasi logic order sama
// sekali. Satu-satunya pekerjaannya: menanyakan sumber (WhatsApp/Telepon),
// lalu menyisipkan penanda kata kunci di depan pesan order berikutnya
// supaya detectOrderSource() (lib/sales-orders/order-source.ts, TERKUNCI,
// tidak diubah) mengklasifikasikannya sebagai CUSTOMER_WHATSAPP/
// CUSTOMER_PHONE dengan sendirinya. Pesan yang sudah ditandai diteruskan
// APA ADANYA ke processTelegramUpdate (lib/sales-orders/workflow.ts,
// TERKUNCI) oleh route.ts -- handler ini sendiri tidak pernah memanggil
// alur order.
//
// Karena order dari menu ini tidak pernah ditautkan ke sales_calls
// (call_id tetap NULL), trigger credit_effective_call_for_order yang sudah
// ada otomatis TIDAK mengkredit EC untuknya (syarat order_source=FIELD_VISIT
// gagal) -- tidak ada kode baru yang perlu menegakkan aturan ini.
// =============================================================================

import type { MenuConversationState } from "../conversation";

export type OrderIntakeSource = "CUSTOMER_WHATSAPP" | "CUSTOMER_PHONE";

export const ORDER_SOURCE_TAG_PREFIX: Record<OrderIntakeSource, string> = {
  CUSTOMER_WHATSAPP: "[Order dari salesman - sumber: WhatsApp Toko]",
  CUSTOMER_PHONE: "[Order dari salesman - sumber: telepon Toko]",
};

export function startOrderIntakeFlow(): { message: string; nextState: MenuConversationState } {
  return {
    message: "Pesanan ini dari mana?\n1. WhatsApp Toko\n2. Telepon Toko",
    nextState: { awaiting: "order_intake_awaiting_text", draft: {} },
  };
}

export function handleOrderIntakeSourceChoice(
  text: string,
  state: MenuConversationState,
): { message: string; nextState: MenuConversationState } {
  const trimmed = text.trim();
  const source: OrderIntakeSource | null = trimmed === "1" ? "CUSTOMER_WHATSAPP" : trimmed === "2" ? "CUSTOMER_PHONE" : null;
  if (!source) {
    return {
      message: "Pilihan tidak valid. Balas 1 untuk WhatsApp Toko, atau 2 untuk Telepon Toko.",
      nextState: state,
    };
  }
  return {
    message: "Baik. Silakan ketik pesanan seperti biasa (nama toko, item, jumlah).",
    nextState: { awaiting: "order_intake_awaiting_text", draft: { orderSource: source } },
  };
}

/** true kalau state ini menunggu PESAN ORDER berikutnya (bukan pilihan sumber). */
export function isPendingOrderIntakeText(state: MenuConversationState): boolean {
  return (
    state.awaiting === "order_intake_awaiting_text" &&
    (state.draft.orderSource === "CUSTOMER_WHATSAPP" || state.draft.orderSource === "CUSTOMER_PHONE")
  );
}

export function buildTaggedOrderText(state: MenuConversationState, rawText: string): string {
  const source = state.draft.orderSource as OrderIntakeSource;
  return `${ORDER_SOURCE_TAG_PREFIX[source]}\n${rawText}`;
}
