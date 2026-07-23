// =============================================================================
// Document Engine -- source validation. Menegakkan integritas rantai
// Order -> Delivery SEBELUM builder (po-builder.ts/invoice-builder.ts)
// diizinkan menyusun snapshot. Modul ini tidak menghitung uang, tidak
// menyentuh I/O -- murni pemeriksaan referensial terhadap kontrak
// OrderSource/DeliverySource (types.ts).
// =============================================================================

import { DocumentSourceError } from "./errors";
import type { DeliverySource, OrderLineSource, OrderSource } from "./types";

/**
 * Batas baris item pada level BUILD/ISSUANCE dokumen -- batas DOMAIN (berapa
 * banyak baris yang boleh dimiliki SATU dokumen sebelum issuance ditolak),
 * SENGAJA TERPISAH dari kapasitas cetak per panel
 * (MAX_ITEM_ROWS_PER_PANEL di lib/document-engine/print-capacity.ts).
 *
 * LOCK Founder "AODP WALUYO -- CONTINUATION PANEL PRINT GATE" (23 Juli 2026,
 * corrective pass kedua): penyatuan sebelumnya (menurunkan angka ini menjadi
 * 10, sama dengan kapasitas satu panel) TIDAK DISETUJUI sebagai aturan
 * bisnis final -- dibatalkan. Dokumen dengan 11-30 baris SAH diterbitkan;
 * dokumen tersebut dicetak lewat CONTINUATION PANEL (lib/document-engine/
 * print-pagination.ts), bukan ditolak hanya karena melebihi satu panel.
 * Nilai 30 dipulihkan sebagai batas domain (authority tertinggi yang
 * ditemukan sebelum LOCK ini -- lihat laporan corrective pass kedua bagian
 * "Audit Perubahan Sebelumnya" untuk kronologi lengkap).
 *
 * assertPanelCapacity/PanelCapacityExceededError (yang sebelumnya menolak
 * transaksi HANYA karena melebihi satu panel) sudah DIHAPUS dari
 * print-capacity.ts -- kapasitas panel sekarang murni parameter pagination,
 * BUKAN alasan penolakan.
 */
export const MAX_DOCUMENT_LINE_ITEMS = 30;

/**
 * Menegakkan batas DOMAIN baris item level build/issuance: dokumen dengan
 * lebih dari MAX_DOCUMENT_LINE_ITEMS (30) baris ditolak eksplisit -- ini
 * SATU-SATUNYA alasan penolakan issuance terkait jumlah baris. Dokumen yang
 * lolos batas ini (termasuk 11-30 baris, melebihi kapasitas SATU panel
 * cetak) TETAP diterbitkan secara normal; pencetakannya memakai continuation
 * panel (print-pagination.ts), bukan ditolak. Dipanggil dari
 * po-builder.ts/invoice-builder.ts terhadap JUMLAH BARIS AKHIR dokumen
 * (setelah resolusi/filter, bukan jumlah baris sumber mentah).
 */
export function assertLineItemLimit(lineCount: number): void {
  if (lineCount > MAX_DOCUMENT_LINE_ITEMS) {
    throw new DocumentSourceError(
      "DOCUMENT_LINE_ITEM_LIMIT_EXCEEDED",
      `Dokumen memiliki ${lineCount} baris item, melebihi kapasitas cetak maksimum ${MAX_DOCUMENT_LINE_ITEMS} baris per dokumen.`,
      { actualCount: lineCount, maxCount: MAX_DOCUMENT_LINE_ITEMS },
    );
  }
}

/**
 * Memvalidasi baris kandidat PO adalah SUBSET sah dari order.lines (dicocokkan
 * per orderLineId), lalu mengembalikan baris KANONIK dari order.lines --
 * bukan objek kandidat mentah -- supaya caller tidak bisa menyuntikkan nilai
 * quantity/harga yang berbeda dari order asli lewat objek "look-alike".
 */
export function resolvePurchaseOrderLines(
  order: OrderSource,
  candidateLines: OrderLineSource[],
): OrderLineSource[] {
  if (candidateLines.length === 0) {
    throw new DocumentSourceError("ORDER_LINE_EMPTY", "Purchase Order tidak memiliki item.");
  }

  return candidateLines.map((candidate) => {
    const canonical = order.lines.find((line) => line.orderLineId === candidate.orderLineId);
    if (!canonical) {
      throw new DocumentSourceError(
        "ORDER_LINE_FOREIGN",
        `Order line ${candidate.orderLineId} bukan milik order ${order.orderId}.`,
      );
    }
    return canonical;
  });
}

/**
 * Memvalidasi rantai Order <-> Delivery untuk Invoice:
 *   - delivery.orderId === order.orderId
 *   - delivery.companyId === order.companyId
 *   - setiap delivery line merujuk order line yang benar-benar ada di order ini
 *   - delivery sudah mencapai status yang sah untuk ditagih (billingStatus)
 * Melempar DocumentSourceError pada pelanggaran pertama yang ditemukan.
 */
export function validateInvoiceSource(order: OrderSource, delivery: DeliverySource): void {
  if (delivery.orderId !== order.orderId) {
    throw new DocumentSourceError(
      "DELIVERY_ORDER_MISMATCH",
      `Delivery ${delivery.deliveryId} milik order ${delivery.orderId}, bukan order ${order.orderId}.`,
    );
  }

  if (delivery.companyId !== order.companyId) {
    throw new DocumentSourceError(
      "COMPANY_MISMATCH",
      `Delivery ${delivery.deliveryId} (company ${delivery.companyId}) tidak sama tenant dengan order ${order.orderId} (company ${order.companyId}).`,
    );
  }

  for (const deliveryLine of delivery.lines) {
    const matchesOrderLine = order.lines.some((line) => line.orderLineId === deliveryLine.orderLineId);
    if (!matchesOrderLine) {
      throw new DocumentSourceError(
        "DELIVERY_LINE_FOREIGN",
        `Delivery line ${deliveryLine.deliveryLineId} merujuk order line ${deliveryLine.orderLineId} yang bukan milik order ${order.orderId}.`,
      );
    }
  }

  if (delivery.billingStatus !== "ELIGIBLE") {
    throw new DocumentSourceError(
      "DELIVERY_NOT_BILLABLE",
      `Delivery ${delivery.deliveryId} belum mencapai status yang sah untuk ditagih (billingStatus=${delivery.billingStatus}).`,
    );
  }
}
