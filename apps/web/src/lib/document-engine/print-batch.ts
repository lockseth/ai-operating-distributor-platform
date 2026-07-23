// =============================================================================
// Document Engine -- print batching. Mengelompokkan array PrintDocumentViewModel
// (SUDAH dibangun via buildPrintViewModel, satu per transaksi) menjadi
// physical sheets Continuous Form 3 Ply 9.5x11in, dua slot 5.5in per sheet
// (LOCKED Founder 23 Juli 2026 -- lihat AODP_DOCUMENT_LAYOUT_GUIDE.md).
//
// LOCK "AODP WALUYO -- CONTINUATION PANEL PRINT GATE" (corrective pass
// kedua): transaksi yang lebih besar dari kapasitas satu panel TIDAK LAGI
// ditolak -- setiap transaksi di-paginate (print-pagination.ts) menjadi 1+
// PaginatedPrintPanel SEBELUM dimasukkan ke antrean sheet. Antrean panel
// dari SELURUH transaksi (setelah pagination) diisi berurutan ke slot
// atas/bawah setiap sheet secara deterministik -- SATU panel TIDAK PERNAH
// berisi bagian dari DUA transaksi berbeda (continuation dari transaksi A
// tidak pernah bercampur dengan transaksi B dalam satu panel), tapi SATU
// sheet fisik BOLEH berisi: dua transaksi pendek, dua halaman dari satu
// transaksi panjang, atau halaman final satu transaksi + halaman awal
// transaksi berikutnya.
//
// Urutan deterministik: transaksi diproses sesuai urutan array input; setiap
// transaksi menyumbang panel halaman 1..N (pagination) ke antrean; antrean
// gabungan diisi slot atas lalu bawah per sheet. Sisa slot bawah pada sheet
// TERAKHIR (bila jumlah panel ganjil) TETAP kosong -- TIDAK PERNAH diisi
// dummy document/transaksi karangan.
//
// Fungsi ini PURE (tidak menyentuh repository/database) -- sama seperti
// print-view-model.ts/print-pagination.ts, hanya menyusun ulang view model
// yang sudah tervalidasi.
// =============================================================================

import { paginatePrintDocument, type PaginatedPrintPanel } from "./print-pagination";
import { MAX_ITEM_ROWS_PER_PANEL } from "./print-capacity";
import type { PrintDocumentViewModel } from "./print-view-model";

export interface PrintSheet {
  top: PaginatedPrintPanel;
  bottom: PaginatedPrintPanel | null;
}

/** Satu physical sheet = satu stok kertas continuous form tenant -- tidak boleh mencampur company_id berbeda dalam satu batch. */
export class CrossTenantBatchError extends Error {
  constructor(companyIds: string[]) {
    super(
      `Batch cetak berisi dokumen dari lebih dari satu tenant (company_id): ${[...new Set(companyIds)].join(", ")}. Satu batch cetak Continuous Form hanya boleh berisi dokumen dari satu tenant (satu stok kertas fisik).`,
    );
    this.name = "CrossTenantBatchError";
  }
}

/**
 * SATU array datar transaksi (urutan batch cetak) -> daftar physical sheet
 * 2-slot. Setiap transaksi di-paginate lebih dulu (continuation panel bila
 * melebihi kapasitas satu panel); antrean panel gabungan diisi berurutan ke
 * slot sheet. Tidak pernah mengarang panel/transaksi kosong; array kosong ->
 * daftar sheet kosong.
 */
export function buildPrintSheets(viewModels: PrintDocumentViewModel[], capacityPerPanel: number = MAX_ITEM_ROWS_PER_PANEL): PrintSheet[] {
  if (viewModels.length === 0) return [];

  const companyIds = viewModels.map((vm) => vm.tenant.companyId);
  if (new Set(companyIds).size > 1) {
    throw new CrossTenantBatchError(companyIds);
  }

  const panelQueue: PaginatedPrintPanel[] = [];
  for (const vm of viewModels) {
    panelQueue.push(...paginatePrintDocument(vm, capacityPerPanel));
  }

  const sheets: PrintSheet[] = [];
  for (let i = 0; i < panelQueue.length; i += 2) {
    sheets.push({
      top: panelQueue[i]!,
      bottom: panelQueue[i + 1] ?? null,
    });
  }
  return sheets;
}
