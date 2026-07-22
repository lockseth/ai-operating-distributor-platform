// =============================================================================
// Document Engine -- print view model. Mengubah SATU DocumentSnapshot menjadi
// struktur dua panel siap-render. Kedua panel SELALU berasal dari objek
// snapshot yang SAMA (satu kali transform, bukan dua query/dua panggilan
// builder terpisah) -- lihat buildPrintViewModel di bawah: panels[0] dan
// panels[1] sengaja hasil pemanggilan toPanelViewModel yang SAMA sehingga
// nomor dokumen dan nilai keduanya identik by construction.
//
// formatRupiah() dipanggil DI SINI (view model), bukan di renderer -- supaya
// renderer (components/document-engine) tidak pernah menyentuh angka mentah
// atau melakukan kalkulasi apa pun (lihat komentar monetary.ts).
// =============================================================================

import { formatRupiah, terbilang } from "./monetary";
import type { DocumentSignatures, DocumentSnapshot, TenantIdentity } from "./types";

export interface PrintLineViewModel {
  no: number;
  productCode: string;
  productName: string;
  productType: string;
  unit: string;
  quantity: number;
  unitPriceLabel: string;
  discountLabel: string;
  lineTotalLabel: string;
}

export interface PrintPanelViewModel {
  documentTypeLabel: string;
  documentNumber: string;
  documentDateLabel: string;
  tenant: TenantIdentity;
  storeName: string;
  storeAddress: string;
  picLabel: string;
  salesmanName: string;
  orderReference: string;
  deliveryReference: string | null;
  paymentTermsLabel: string;
  lines: PrintLineViewModel[];
  subtotalLabel: string;
  totalDiscountLabel: string;
  grandTotalLabel: string;
  /**
   * LOCKED (Repository & Persistence Closure Gate): Subtotal/Potongan/Total/
   * Terbilang adalah template Totals kontrak aktif Pak Waluyo -- TIDAK ADA
   * DPP/PPN/Other Charges. Jangan menambahkan field pajak di sini tanpa
   * kontrak bisnis baru yang eksplisit.
   */
  terbilangLabel: string;
  signatures: DocumentSignatures;
}

export interface PrintDocumentViewModel {
  documentNumber: string;
  panels: [PrintPanelViewModel, PrintPanelViewModel];
}

function documentTypeLabel(snapshot: DocumentSnapshot): string {
  return snapshot.documentType === "PURCHASE_ORDER" ? "PURCHASE ORDER" : "INVOICE / FAKTUR";
}

function toPanelViewModel(snapshot: DocumentSnapshot): PrintPanelViewModel {
  return {
    documentTypeLabel: documentTypeLabel(snapshot),
    documentNumber: snapshot.documentNumber,
    documentDateLabel: snapshot.documentDate,
    tenant: snapshot.tenant,
    storeName: snapshot.store.storeName,
    storeAddress: snapshot.store.storeAddress ?? "-",
    picLabel: snapshot.store.picName ?? "-",
    salesmanName: snapshot.salesman.salesmanName,
    orderReference: snapshot.orderReference,
    deliveryReference: snapshot.deliveryReference,
    paymentTermsLabel: snapshot.paymentTermsDays !== null ? `${snapshot.paymentTermsDays} hari` : "-",
    lines: snapshot.lines.map((line) => ({
      no: line.no,
      productCode: line.productCode ?? "-",
      productName: line.productName,
      productType: line.productType ?? "-",
      unit: line.unit ?? "-",
      quantity: line.quantity,
      unitPriceLabel: formatRupiah(line.unitPrice),
      discountLabel: formatRupiah(line.discountAmount),
      lineTotalLabel: formatRupiah(line.lineTotal),
    })),
    subtotalLabel: formatRupiah(snapshot.totals.subtotal),
    totalDiscountLabel: formatRupiah(snapshot.totals.totalDiscount),
    grandTotalLabel: formatRupiah(snapshot.totals.grandTotal),
    terbilangLabel: terbilang(snapshot.totals.grandTotal),
    signatures: snapshot.signatures,
  };
}

/** Dua panel identik dari SATU snapshot -- tidak pernah dua query/dua build terpisah. */
export function buildPrintViewModel(snapshot: DocumentSnapshot): PrintDocumentViewModel {
  const panel = toPanelViewModel(snapshot);
  return {
    documentNumber: snapshot.documentNumber,
    panels: [panel, panel],
  };
}
