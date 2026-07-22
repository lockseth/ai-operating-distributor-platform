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
