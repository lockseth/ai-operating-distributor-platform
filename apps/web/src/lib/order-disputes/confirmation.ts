// =============================================================================
// Pesan balasan Telegram untuk alur Batalkan/Sengketakan Order.
// =============================================================================

import { CONTACT_SOURCE_LABEL, REASON_CODES, type ContactSource, type DisputeRequestRecord } from "./types";
import type { OrderSummary } from "./repository";
import type { DisputeDraft } from "./conversation";

export function buildOrderNotFoundReply(): string {
  return "Order tidak ditemukan pada perusahaan Anda. Periksa kembali nomor order.";
}

export function buildOrderAlreadyCancelledReply(): string {
  return "Order ini sudah berstatus dibatalkan sebelumnya. Tidak ada perubahan yang dilakukan.";
}

export function buildAlreadyHasActiveRequestReply(): string {
  return "Order ini sudah memiliki permintaan pembatalan/sengketa yang masih berjalan. Tunggu review admin/owner sebelum mengajukan lagi.";
}

export function buildOrderSummaryAndTypePrompt(order: OrderSummary): string {
  return [
    `Order ${order.orderNumber} — ${order.customerName}`,
    `Status saat ini: ${order.status}`,
    "",
    "Pilih jenis permintaan:",
    "1. PIC membatalkan pesanan",
    "2. PIC merasa tidak pernah memesan",
    "",
    "Balas dengan angka 1 atau 2.",
  ].join("\n");
}

export function buildInvalidChoiceReply(maxOption: number): string {
  return `Pilihan tidak dikenali. Balas dengan angka 1-${maxOption}.`;
}

export function buildAskPicNamePrompt(): string {
  return "Siapa nama PIC/pelapor toko?";
}

export function buildAskContactSourcePrompt(): string {
  return ["Sumber informasi ini didapat dari mana?", "1. WhatsApp", "2. Telepon", "3. Kunjungan langsung", "4. Lainnya", "", "Balas dengan angka 1-4."].join("\n");
}

export function buildAskReasonPrompt(): string {
  const lines = REASON_CODES.map((code, i) => `${i + 1}. ${code.replace(/_/g, " ")}`);
  return ["Pilih alasan:", ...lines, "", `Balas dengan angka 1-${REASON_CODES.length}.`].join("\n");
}

export function buildAskNotesPrompt(): string {
  return "Ada catatan tambahan? Ketik catatannya, atau balas - untuk melewati.";
}

const CONTACT_SOURCE_BY_CHOICE: Record<number, ContactSource> = {
  1: "CUSTOMER_WHATSAPP",
  2: "CUSTOMER_PHONE",
  3: "FIELD_VISIT",
  4: "OTHER",
};

export function contactSourceFromChoice(choice: number): ContactSource | null {
  return CONTACT_SOURCE_BY_CHOICE[choice] ?? null;
}

export function buildFinalConfirmationPrompt(order: OrderSummary, draft: DisputeDraft): string {
  const typeLabel = draft.requestType === "CUSTOMER_CANCELLED" ? "PIC membatalkan pesanan" : "PIC merasa tidak pernah memesan";
  return [
    "Ringkasan permintaan:",
    `Order: ${order.orderNumber} — ${order.customerName}`,
    `Jenis: ${typeLabel}`,
    `PIC/pelapor: ${draft.picName ?? "-"}`,
    `Sumber: ${draft.contactSource ? CONTACT_SOURCE_LABEL[draft.contactSource] : "-"}`,
    `Alasan: ${draft.reasonCode ?? "-"}`,
    `Catatan: ${draft.notes ?? "-"}`,
    "",
    "Balas KONFIRMASI untuk memproses, atau BATAL untuk membatalkan proses ini.",
  ].join("\n");
}

export function buildProcessCancelledReply(): string {
  return "Dibatalkan. Tidak ada permintaan yang dibuat.";
}

export function buildRequestCreatedReply(result: {
  autoCancelled: boolean;
  aiClassification: string;
  requestType: string;
}): string {
  if (result.autoCancelled) {
    return "Order berhasil dibatalkan. Order belum masuk proses pengiriman sehingga pembatalan diproses otomatis.";
  }
  if (result.requestType === "CUSTOMER_DENIES_ORDER") {
    return "Permintaan tercatat. Order ditahan (hold) dan akan direview admin/owner — laporan ini TIDAK menyalahkan Anda, ini bagian standar proses verifikasi.";
  }
  return "Permintaan pembatalan tercatat dan akan direview admin/owner karena order sudah masuk proses pengiriman.";
}

export function buildUnexpectedErrorReply(): string {
  return "Gagal memproses permintaan. Coba lagi atau hubungi admin.";
}

export function buildNoActiveConversationReply(): string {
  return "Tidak ada proses Batalkan/Sengketakan Order yang sedang berjalan. Ketik \"batalkan <nomor order>\" atau \"sengketa <nomor order>\" untuk memulai.";
}

export function buildHistoryLine(record: DisputeRequestRecord): string {
  return `${record.requestType} — ${record.status}`;
}
