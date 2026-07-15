// =============================================================================
// Confirmation summary — teks ringkasan draft order yang dikirim balik ke
// sales via Telegram, mengikuti format di spesifikasi task.
// =============================================================================

import type { PricedOrder, PricedOrderItem } from "./types";
import { formatIDR } from "./normalize";

function formatItemLine(item: PricedOrderItem, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${item.productName}`);

  const qtyUnit = item.unit ? `${item.quantity} ${item.unit}` : `${item.quantity}`;
  lines.push(`   ${qtyUnit} × ${formatIDR(item.unitPrice)}`);

  if (item.discountType === "percentage" && item.discountValue !== null) {
    lines.push(`   Diskon ${item.discountValue}%`);
  } else if (item.discountType === "nominal" && item.discountValue !== null) {
    lines.push(`   Potongan: ${formatIDR(item.discountValue)}`);
  }

  if (item.discountException) {
    lines.push(`   ⚠️ Diskon melebihi batas kebijakan — butuh review`);
  } else if (item.requiresReview && item.discountType) {
    lines.push(`   ⚠️ Belum ada kebijakan diskon — butuh review`);
  }

  lines.push(`   Total: ${formatIDR(item.amountAfterDiscount)}`);
  return lines.join("\n");
}

export function buildConfirmationSummary(order: PricedOrder): string {
  const customerLabel = order.customerName ?? "(nama toko belum diketahui — mohon lengkapi)";
  const parts: string[] = [];

  parts.push(`Draft Order — ${customerLabel}`);
  parts.push("");
  parts.push(order.items.map((item, i) => formatItemLine(item, i)).join("\n\n"));
  parts.push("");
  parts.push(`Estimasi total: ${formatIDR(order.estimatedTotal)}`);

  if (order.deliveryNote) {
    parts.push(`Pengiriman: ${order.deliveryNote}`);
  }

  if (order.requiresDiscountReview) {
    parts.push("");
    parts.push("⚠️ Order ini butuh review diskon dari admin sebelum diproses lebih lanjut.");
  }

  parts.push("");
  parts.push("Balas KONFIRMASI jika sudah benar atau UBAH untuk melakukan koreksi.");

  return parts.join("\n");
}

export function buildUnrecognizedMessageReply(): string {
  return "Maaf, pesan ini belum bisa dikenali sebagai order. Contoh format:\n\nOrder Toko Sinar Jaya:\nCat Mawar Putih 20 dus harga 450 ribu\n\nSilakan kirim ulang dengan format serupa.";
}

export function buildUnregisteredUserReply(): string {
  return "Nomor Anda belum terdaftar untuk menggunakan layanan ini. Silakan hubungi admin/owner distributor Anda.";
}

export function buildVoiceNotePendingReply(): string {
  return "Pesan suara Anda sudah kami terima. Fitur transkripsi otomatis belum aktif — mohon ketik ulang order Anda dalam bentuk teks untuk sementara.";
}

export function buildAskForCorrectionReply(): string {
  return "Baik, silakan kirim ulang detail order yang benar dalam satu pesan teks.";
}

export function buildAlreadyConfirmedReply(): string {
  return "Order ini sudah dikonfirmasi sebelumnya. Tidak ada perubahan yang dilakukan.";
}

export function buildNoPendingOrderReply(): string {
  return "Tidak ada draft order yang sedang menunggu konfirmasi dari Anda saat ini.";
}

export function buildOrderConfirmedReply(order: PricedOrder): string {
  const customerLabel = order.customerName ?? "order Anda";
  return `Order ${customerLabel} telah dikonfirmasi. Estimasi total: ${formatIDR(order.estimatedTotal)}. Tim kami akan memprosesnya.`;
}
