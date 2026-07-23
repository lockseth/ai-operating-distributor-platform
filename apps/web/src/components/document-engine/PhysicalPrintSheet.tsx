// =============================================================================
// AODP Document Engine -- physical print sheet. SATU sheet = SATU lembar
// fisik Continuous Form 3 Ply 9.5x11in, berisi maksimal DUA panel 9.5x5.5in
// (top/bottom) -- LOCKED Founder 23 Juli 2026, lihat AODP_DOCUMENT_LAYOUT_GUIDE.md.
// Komponen ini PURE PRESENTATIONAL, sama seperti PrintDocumentPanel: hanya
// menerima PrintSheet (antrean panel yang sudah tervalidasi/di-paginate
// lewat lib/document-engine/print-batch.ts), TIDAK PERNAH query
// repository/database.
//
// LOCK "AODP WALUYO -- CONTINUATION PANEL PRINT GATE" (corrective pass
// kedua): satu sheet BOLEH berisi dua transaksi pendek, dua halaman dari
// satu transaksi panjang (continuation), atau halaman final satu transaksi
// + halaman awal transaksi berikutnya -- SATU panel TIDAK PERNAH berisi
// bagian dari DUA transaksi berbeda (dijamin oleh print-batch.ts).
//
// Slot bawah kosong (tidak ada panel/dokumen berikutnya dalam antrean batch)
// dirender sebagai ".doc-engine-panel-empty" TANPA header/tabel/tanda tangan
// -- bukan dummy document.
//
// AUDIT FIX (corrective pass kedua): ilustrasi perforasi/sprocket DIHAPUS
// TOTAL dari production print (sebelumnya dibatasi arealateral lewat
// data-has-bottom -- sekarang dihapus sepenuhnya, tidak dirender sama
// sekali, baik panel berisi transaksi maupun panel kosong).
//
// proofMode HANYA untuk visual proof/debug (garis bagi tengah + label "Panel
// Atas"/"Panel Bawah") -- TIDAK PERNAH tercetak di production print.css
// menyembunyikan elemen ini paksa lewat @media print terlepas dari prop ini.
// =============================================================================

import type { PrintSheet } from "@/lib/document-engine/print-batch";
import { PrintDocumentPanel } from "./PrintDocumentPanel";
import { EmptyPrintPanel } from "./EmptyPrintPanel";
import "./print.css";

export interface PhysicalPrintSheetProps {
  sheet: PrintSheet;
  proofMode?: boolean;
}

export function PhysicalPrintSheet({ sheet, proofMode = false }: PhysicalPrintSheetProps) {
  return (
    <div
      className="doc-engine-sheet"
      data-proof-mode={proofMode ? "true" : "false"}
      data-has-bottom={sheet.bottom ? "true" : "false"}
      data-top-document-number={sheet.top.documentNumber}
      data-top-page={`${sheet.top.pageIndex}/${sheet.top.pageCount}`}
      data-bottom-document-number={sheet.bottom?.documentNumber ?? ""}
      data-bottom-page={sheet.bottom ? `${sheet.bottom.pageIndex}/${sheet.bottom.pageCount}` : ""}
    >
      {proofMode ? <div className="doc-engine-proof-label doc-engine-proof-label-top">Panel Atas</div> : null}
      <PrintDocumentPanel panel={sheet.top} />

      <div className="doc-engine-divider-guide" />

      {sheet.bottom ? (
        <>
          {proofMode ? <div className="doc-engine-proof-label doc-engine-proof-label-bottom">Panel Bawah</div> : null}
          <PrintDocumentPanel panel={sheet.bottom} />
        </>
      ) : (
        <EmptyPrintPanel />
      )}
    </div>
  );
}
