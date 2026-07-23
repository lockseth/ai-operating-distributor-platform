// =============================================================================
// Document Engine -- pagination (continuation panel). LOCKED Founder,
// "AODP WALUYO -- CONTINUATION PANEL PRINT GATE": transaksi yang tidak muat
// dalam satu panel 9.5x5.5in DILANJUTKAN ke panel berikutnya (continuation),
// BUKAN ditolak. Supersede LOCK sebelumnya ("transaksi >10 baris ditolak") --
// lihat AODP_DOCUMENT_LAYOUT_GUIDE.md revision history.
//
// Fungsi ini PURE (tidak menyentuh repository/database, tidak mengubah
// issued_documents/snapshot) -- murni membagi SATU PrintDocumentViewModel
// (sudah lengkap, immutable) menjadi N PaginatedPrintPanel berurutan. Nomor
// dokumen, versi, tenant, pelanggan, dan seluruh identitas TETAP SAMA di
// setiap panel -- continuation TIDAK PERNAH membuat dokumen baru.
//
// Invariant yang dijaga (lihat print-pagination.test.ts):
//   1. Tidak ada item hilang (union seluruh panel.lines === vm.lines).
//   2. Tidak ada item duplikat.
//   3. Urutan item dipertahankan (line.no tetap berlanjut, TIDAK reset ke 1).
//   4. Jumlah panel = Math.ceil(lineCount / capacityPerPanel), minimum 1.
//   5. HANYA panel terakhir (isFinalPanel) memiliki totals & signatures --
//      panel non-final totals/signatures = null (TIDAK membuat subtotal
//      continuation karangan; grand total tetap dihitung dari SELURUH item
//      dokumen, sudah final di vm.grandTotalLabel).
// =============================================================================

import type { DocumentSignatures, TenantIdentity } from "./types";
import type { PrintDocumentViewModel, PrintLineViewModel } from "./print-view-model";
import { MAX_ITEM_ROWS_PER_PANEL } from "./print-capacity";

export interface PaginatedPrintPanelTotals {
  subtotalLabel: string;
  totalDiscountLabel: string;
  grandTotalLabel: string;
  terbilangLabel: string;
}

export interface PaginatedPrintPanel {
  documentTypeLabel: string;
  documentNumber: string;
  /** Sama di seluruh panel dokumen yang sama -- null bila tidak disediakan pemanggil (pagination tidak membaca dari database). */
  documentVersion: number | null;
  documentDateLabel: string;
  dueDateLabel: string | null;
  tenant: TenantIdentity;
  storeCode: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  salesmanName: string;
  orderReference: string;
  deliveryReference: string | null;
  paymentTermsLabel: string | null;
  /** Potongan (slice) baris item untuk panel INI SAJA -- line.no tetap nomor asli dari dokumen utuh, TIDAK direset. */
  lines: PrintLineViewModel[];
  /** 1-based -- "Halaman 1/N". */
  pageIndex: number;
  pageCount: number;
  isFirstPanel: boolean;
  isFinalPanel: boolean;
  /** null pada panel non-final (LOCKED: hanya panel final punya total). */
  totals: PaginatedPrintPanelTotals | null;
  /** null pada panel non-final (LOCKED: hanya panel final punya tanda tangan). */
  signatures: DocumentSignatures | null;
  /** null pada panel non-final. */
  receiverName: string | null;
}

/**
 * SATU PrintDocumentViewModel (dokumen utuh, sudah immutable) -> N
 * PaginatedPrintPanel berurutan. capacityPerPanel default MAX_ITEM_ROWS_PER_PANEL
 * (diukur nyata, lihat print-capacity.ts) -- parameter eksplisit tersedia
 * HANYA untuk testability (unit test memakai angka kecil supaya kasus
 * multi-panel tidak perlu ratusan baris fixture).
 */
export function paginatePrintDocument(
  vm: PrintDocumentViewModel,
  capacityPerPanel: number = MAX_ITEM_ROWS_PER_PANEL,
  documentVersion: number | null = null,
): PaginatedPrintPanel[] {
  const totalLines = vm.lines.length;
  const pageCount = Math.max(1, Math.ceil(totalLines / capacityPerPanel));

  const panels: PaginatedPrintPanel[] = [];
  for (let page = 0; page < pageCount; page++) {
    const start = page * capacityPerPanel;
    const end = Math.min(start + capacityPerPanel, totalLines);
    const isFirstPanel = page === 0;
    const isFinalPanel = page === pageCount - 1;

    panels.push({
      documentTypeLabel: vm.documentTypeLabel,
      documentNumber: vm.documentNumber,
      documentVersion,
      documentDateLabel: vm.documentDateLabel,
      dueDateLabel: vm.dueDateLabel,
      tenant: vm.tenant,
      storeCode: vm.storeCode,
      storeName: vm.storeName,
      storeAddress: vm.storeAddress,
      storePhone: vm.storePhone,
      salesmanName: vm.salesmanName,
      orderReference: vm.orderReference,
      deliveryReference: vm.deliveryReference,
      paymentTermsLabel: vm.paymentTermsLabel,
      lines: vm.lines.slice(start, end),
      pageIndex: page + 1,
      pageCount,
      isFirstPanel,
      isFinalPanel,
      totals: isFinalPanel
        ? {
            subtotalLabel: vm.subtotalLabel,
            totalDiscountLabel: vm.totalDiscountLabel,
            grandTotalLabel: vm.grandTotalLabel,
            terbilangLabel: vm.terbilangLabel,
          }
        : null,
      signatures: isFinalPanel ? vm.signatures : null,
      receiverName: isFinalPanel ? vm.receiverName : null,
    });
  }
  return panels;
}
