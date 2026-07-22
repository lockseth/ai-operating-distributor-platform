// =============================================================================
// Document Engine -- Invoice builder. Menghasilkan DocumentSnapshot
// deterministik dari SATU OrderSource + SATU DeliverySource yang tervalidasi
// (source-validation.ts) -- kuantitas ditagih SELALU verifiedQuantity per
// delivery line (bukan orderedQuantity), sehingga partial delivery otomatis
// menghasilkan invoice sebagian. Baris dengan verifiedQuantity 0 (ditolak/
// dibatalkan/tidak terkirim) TIDAK PERNAH masuk snapshot.
// =============================================================================

import { DocumentSourceError } from "./errors";
import { computeLineTotal, computeTotals } from "./monetary";
import { validateInvoiceSource } from "./source-validation";
import type { DeliverySource, DocumentLineSnapshot, DocumentSnapshot, OrderSource, TenantIdentity } from "./types";

export interface InvoiceQuantityOverride {
  orderLineId: string;
  /** WAJIB <= delivery line verifiedQuantity untuk orderLineId yang sama, atau builder menolak. */
  invoicedQuantity: number;
}

export interface BuildInvoiceInput {
  order: OrderSource;
  delivery: DeliverySource;
  tenant: TenantIdentity;
  documentNumber: string;
  documentDate: string;
  delivererName?: string;
  /** Override kuantitas tagih per baris (mis. penagihan bertahap) -- TIDAK BOLEH melebihi verifiedQuantity. Default: seluruh verifiedQuantity. */
  quantityOverrides?: InvoiceQuantityOverride[];
  now?: () => Date;
}

export function buildInvoiceSnapshot(input: BuildInvoiceInput): DocumentSnapshot {
  validateInvoiceSource(input.order, input.delivery);

  const overrideByOrderLineId = new Map(
    (input.quantityOverrides ?? []).map((o) => [o.orderLineId, o.invoicedQuantity]),
  );

  const lines: DocumentLineSnapshot[] = [];
  for (const deliveryLine of input.delivery.lines) {
    const override = overrideByOrderLineId.get(deliveryLine.orderLineId);
    const invoicedQuantity = override ?? deliveryLine.verifiedQuantity;

    if (invoicedQuantity > deliveryLine.verifiedQuantity) {
      throw new DocumentSourceError(
        "INVOICE_QUANTITY_EXCEEDS_VERIFIED",
        `Kuantitas tagih ${invoicedQuantity} untuk ${deliveryLine.productName} melebihi kuantitas terverifikasi ${deliveryLine.verifiedQuantity}.`,
      );
    }

    // rejected/cancelled/undelivered (verifiedQuantity 0, atau override 0) -- tidak ditagihkan sama sekali.
    if (invoicedQuantity <= 0) continue;

    lines.push({
      no: lines.length + 1,
      productCode: deliveryLine.productCode,
      productName: deliveryLine.productName,
      productType: deliveryLine.productType,
      unit: deliveryLine.unit,
      quantity: invoicedQuantity,
      unitPrice: deliveryLine.unitPrice,
      discountAmount: deliveryLine.discountAmount,
      lineTotal: computeLineTotal({
        quantity: invoicedQuantity,
        unitPrice: deliveryLine.unitPrice,
        discountAmount: deliveryLine.discountAmount,
      }),
    });
  }

  if (lines.length === 0) {
    throw new DocumentSourceError(
      "NO_BILLABLE_LINES",
      `Tidak ada baris yang dapat ditagih untuk delivery ${input.delivery.deliveryId} (seluruh kuantitas terverifikasi nol).`,
    );
  }

  const totals = computeTotals(lines);
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();

  return {
    documentType: "INVOICE",
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    companyId: input.order.companyId,
    tenant: input.tenant,
    store: input.order.store,
    salesman: input.order.salesman,
    orderReference: input.order.orderNumber,
    deliveryReference: input.delivery.deliveryNumber,
    paymentTermsDays: input.order.paymentTermsDays,
    lines,
    totals,
    signatures: {
      salesmanName: input.order.salesman.salesmanName,
      delivererName: input.delivererName ?? input.order.salesman.salesmanName,
    },
    generatedAt,
  };
}
