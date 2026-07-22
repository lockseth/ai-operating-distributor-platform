// =============================================================================
// Document Engine -- Purchase Order builder. Menghasilkan DocumentSnapshot
// deterministik dari SATU OrderSource yang tervalidasi (source-validation.ts)
// -- tidak pernah menerima customer/item bebas di luar order tersebut.
// =============================================================================

import { computeLineTotal, computeTotals } from "./monetary";
import { resolvePurchaseOrderLines } from "./source-validation";
import type { DocumentLineSnapshot, DocumentSnapshot, OrderLineSource, OrderSource, TenantIdentity } from "./types";

export interface BuildPurchaseOrderInput {
  order: OrderSource;
  tenant: TenantIdentity;
  documentNumber: string;
  documentDate: string;
  /** Subset baris order untuk PO ini (harus milik order.lines) -- default: seluruh order.lines. */
  lines?: OrderLineSource[];
  /** Nama pengirim jika sudah diketahui -- default nama salesman (salesman boleh merangkap pengirim). */
  delivererName?: string;
  now?: () => Date;
}

export function buildPurchaseOrderSnapshot(input: BuildPurchaseOrderInput): DocumentSnapshot {
  const resolvedLines = resolvePurchaseOrderLines(input.order, input.lines ?? input.order.lines);

  const lines: DocumentLineSnapshot[] = resolvedLines.map((line, index) => ({
    no: index + 1,
    productCode: line.productCode,
    productName: line.productName,
    productType: line.productType,
    unit: line.unit,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountAmount: line.discountAmount,
    lineTotal: computeLineTotal(line),
  }));

  const totals = computeTotals(lines);
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();

  return {
    documentType: "PURCHASE_ORDER",
    documentNumber: input.documentNumber,
    documentDate: input.documentDate,
    companyId: input.order.companyId,
    tenant: input.tenant,
    store: input.order.store,
    salesman: input.order.salesman,
    orderReference: input.order.orderNumber,
    deliveryReference: null,
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
