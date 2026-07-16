// =============================================================================
// Message builders — teks balasan Telegram untuk alur Delivery Verification.
// Sama gaya dengan lib/sales-orders/confirmation.ts.
// =============================================================================

import type { DeliveryRecord, DeliveryOutcome, ItemDiscrepancy, InvoiceEligibility, ReasonCode } from "./types";
import { REASON_CODES } from "./types";

function formatIDR(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString("id-ID")}`;
}

export const DELIVERY_OUTCOME_KEYWORDS: Record<string, DeliveryOutcome> = {
  "DITERIMA PENUH": "full",
  "DITERIMA SEBAGIAN": "partial",
  DITOLAK: "rejected",
  "TOKO TUTUP": "store_closed",
  GAGAL: "failed",
};

export const START_DELIVERY_KEYWORD = "MULAI KIRIM";
export const CONFIRM_DELIVERY_KEYWORD = "KONFIRMASI KIRIM";

const REASON_LABEL: Record<ReasonCode, string> = {
  STORE_CLOSED: "Toko tutup",
  CUSTOMER_PARTIAL_ACCEPTANCE: "Customer terima sebagian",
  CUSTOMER_REJECTED: "Customer menolak",
  ITEM_DAMAGED: "Barang rusak",
  ITEM_MISMATCH: "Barang tidak sesuai",
  QUANTITY_MISMATCH: "Jumlah tidak sesuai",
  PRICE_OR_DISCOUNT_DISPUTE: "Selisih harga/diskon",
  RECIPIENT_NOT_AUTHORIZED: "Penerima tidak berwenang",
  ADDRESS_NOT_FOUND: "Alamat tidak ditemukan",
  VEHICLE_OR_DRIVER_ISSUE: "Kendala kendaraan/driver",
  OTHER_REQUIRES_NOTE: "Lainnya (wajib catatan)",
};

export function buildDeliveryTaskMessage(order: { orderNumber: string; customerName: string | null }, items: { productName: string; unit: string | null; quantity: number }[]): string {
  const lines: string[] = [];
  lines.push(`Tugas Pengiriman — ${order.customerName ?? "(toko)"}"`);
  lines.push(`Order: ${order.orderNumber}`);
  lines.push("");
  lines.push("Item:");
  for (const item of items) {
    const qty = item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
    lines.push(`- ${item.productName}: ${qty}`);
  }
  lines.push("");
  lines.push(`Balas "${START_DELIVERY_KEYWORD}" saat siap berangkat.`);
  return lines.join("\n");
}

export function buildDispatchedReply(): string {
  return `Pengiriman dimulai. Balas hasil pengiriman saat tiba di toko: DITERIMA PENUH, DITERIMA SEBAGIAN, DITOLAK, TOKO TUTUP, atau GAGAL.`;
}

export function buildAskQuantityReply(productName: string, unit: string | null, dispatchedQuantity: number, index: number, total: number): string {
  const qty = unit ? `${dispatchedQuantity} ${unit}` : `${dispatchedQuantity}`;
  return `Item ${index + 1}/${total}: ${productName} (dikirim ${qty}).\nBerapa yang diterima? Balas angka saja (mis. ${dispatchedQuantity}).`;
}

export function buildInvalidQuantityReply(dispatchedQuantity: number): string {
  return `Jumlah tidak valid. Masukkan angka antara 0 dan ${dispatchedQuantity} (jumlah yang dikirim).`;
}

export function buildQuantityExceedsOutstandingReply(outstanding: number): string {
  return `Jumlah ini melebihi sisa yang belum diterima untuk item ini (outstanding: ${outstanding}). Kemungkinan ada delivery attempt lain untuk order yang sama sudah mencatat sebagian. Masukkan angka maksimal ${outstanding}, atau hubungi admin/supervisor bila menurut Anda ini keliru.`;
}

export function buildQuantityConflictReply(salesOrderItemId: string, outstanding: number, requested: number): string {
  return `Tidak bisa disimpan: item ini sudah menerima lebih banyak dari delivery attempt lain sejak percakapan ini dimulai (outstanding sekarang ${outstanding}, Anda memasukkan ${requested}). Hubungi admin/supervisor untuk verifikasi jumlah yang benar sebelum melanjutkan. (ref: ${salesOrderItemId})`;
}

export function buildAskReasonReply(): string {
  const list = REASON_CODES.map((code, i) => `${i + 1}. ${REASON_LABEL[code]}`).join("\n");
  return `Mohon pilih alasan (balas nomor):\n${list}`;
}

export function buildInvalidReasonReply(): string {
  return `Pilihan tidak dikenali. Balas dengan nomor alasan yang sesuai daftar sebelumnya.`;
}

export function buildAskReasonNoteReply(): string {
  return `Mohon jelaskan alasannya secara singkat (wajib untuk alasan "Lainnya").`;
}

export function buildAskEvidenceReply(missing: string[]): string {
  const label: Record<string, string> = {
    photo: "foto",
    signature: "tanda tangan penerima (foto/dokumen)",
    recipient: "nama penerima",
    reason_code: "alasan",
    location: "lokasi (share location Telegram)",
  };
  const items = missing.map((m) => `- ${label[m] ?? m}`).join("\n");
  return `Masih ada yang perlu dilengkapi sebelum bisa lanjut:\n${items}\n\nKirim satu per satu (foto sebagai gambar, lokasi via fitur share location Telegram, nama penerima sebagai teks).`;
}

export function buildReconciliationPreview(
  delivery: DeliveryRecord,
  discrepancies: ItemDiscrepancy[],
  invoiceEligibility: InvoiceEligibility
): string {
  const lines: string[] = [];
  lines.push("Ringkasan rekonsiliasi:");
  for (const item of delivery.items) {
    const disc = discrepancies.find((d) => d.deliveryItemId === item.id);
    const qtyLine = `${item.productName}: kirim ${item.dispatchedQuantity} → terima ${item.receivedQuantity}`;
    lines.push(disc && disc.hasDiscrepancy ? `${qtyLine} (selisih ${disc.discrepancyQuantity})` : qtyLine);
  }
  lines.push("");
  lines.push(`Nilai eligible invoice: ${formatIDR(invoiceEligibility.totalEligibleValue)} dari ${formatIDR(invoiceEligibility.totalOrderedValue)}`);
  if (invoiceEligibility.varianceValue !== 0) {
    lines.push(`Selisih: ${formatIDR(invoiceEligibility.varianceValue)}`);
  }
  lines.push("");
  lines.push(`Balas "${CONFIRM_DELIVERY_KEYWORD}" untuk mengunci hasil ini.`);
  return lines.join("\n");
}

export function buildFinalConfirmedReply(outcome: DeliveryOutcome): string {
  const label: Record<DeliveryOutcome, string> = {
    full: "diterima penuh",
    partial: "diterima sebagian",
    rejected: "ditolak",
    store_closed: "toko tutup — dijadwalkan ulang",
    failed: "gagal — dijadwalkan ulang",
  };
  return `Delivery dicatat: ${label[outcome]}. Terima kasih.`;
}

export function buildAlreadyFinalizedReply(): string {
  return `Delivery ini sudah final sebelumnya. Tidak ada perubahan.`;
}

export function buildNoPendingDeliveryReply(): string {
  return `Tidak ada tugas pengiriman yang sedang berjalan untuk Anda saat ini.`;
}

export function buildUnknownOutcomeReply(): string {
  return `Pilihan tidak dikenali. Balas salah satu: DITERIMA PENUH, DITERIMA SEBAGIAN, DITOLAK, TOKO TUTUP, atau GAGAL.`;
}
