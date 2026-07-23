// =============================================================================
// Document Engine -- print view model. Mengubah SATU DocumentSnapshot menjadi
// SATU tampilan siap-render (1 dokumen = 1 panel transaksi 9.5x5.5in, LOCKED
// Founder 2026-07-23 -- Continuous Form 3 Ply berarti kertas rangkap FISIK/
// carbonless printer, bukan duplikasi konten oleh renderer. Dua panel
// (dari dua view model independen) disusun ke dalam satu physical sheet
// 9.5x11in oleh lib/document-engine/print-batch.ts +
// components/document-engine/PhysicalPrintSheet.tsx -- lihat
// AODP_DOCUMENT_LAYOUT_GUIDE.md revision history untuk kronologi lengkap).
//
// formatRupiah()/terbilang() dipanggil DI SINI (view model), bukan di
// renderer -- supaya renderer (components/document-engine) tidak pernah
// menyentuh angka mentah atau melakukan kalkulasi apa pun (lihat komentar
// monetary.ts). Formatting tanggal Indonesia (formatIndonesianDate) dan
// perhitungan tanggal jatuh tempo (computeDueDateLabel) JUGA presentasi
// murni -- input (documentDate, paymentTermsDays) sudah final dari snapshot,
// fungsi di sini tidak pernah menghasilkan nilai bisnis baru.
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

export interface PrintDocumentViewModel {
  documentTypeLabel: string;
  documentNumber: string;
  /** "15 Juli 2026" -- format tanggal Indonesia, bukan ISO mentah. */
  documentDateLabel: string;
  /**
   * "29 Juli 2026 (14 Hari)" -- dihitung dari documentDate + paymentTermsDays.
   * Null HANYA bila snapshot.paymentTermsDays null (seharusnya tidak pernah
   * terjadi untuk dokumen yang berhasil diterbitkan sejak PAYMENT_TERMS_INCOMPLETE
   * ditegakkan di issuance -- null-safe di sini murni jaga-jaga, renderer
   * menyembunyikan baris ini bila null, TIDAK menampilkan placeholder.
   */
  dueDateLabel: string | null;
  tenant: TenantIdentity;
  /** "-" bila customers.code belum tersedia (konvensi sama dengan storeAddress). */
  storeCode: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  salesmanName: string;
  orderReference: string;
  deliveryReference: string | null;
  /**
   * "14 Hari" -- null bila paymentTermsDays belum tersedia. Renderer
   * menyembunyikan baris ini sepenuhnya saat null (TIDAK menampilkan "-"
   * atau placeholder lain) -- keputusan Founder 2026-07-23: baris kosong
   * disembunyikan, bukan diisi karangan.
   */
  paymentTermsLabel: string | null;
  lines: PrintLineViewModel[];
  subtotalLabel: string;
  totalDiscountLabel: string;
  grandTotalLabel: string;
  /**
   * LOCKED (Repository & Persistence Closure Gate, dipertegas Founder
   * 2026-07-23): Subtotal/Potongan/Grand Total/Terbilang adalah SATU-SATUNYA
   * baris Totals kontrak aktif Pak Waluyo -- TIDAK ADA DPP/PPN/Biaya Lain.
   * Jangan menambahkan field pajak di sini tanpa kontrak bisnis baru yang
   * eksplisit.
   */
  terbilangLabel: string;
  signatures: DocumentSignatures;
  /**
   * Nama PIC/penerima toko untuk panel tanda tangan "PENERIMA" -- null
   * bila belum ditentukan (garis tanda tangan tetap ditampilkan kosong untuk
   * tanda tangan manual, TIDAK diisi nama karangan).
   */
  receiverName: string | null;
}

function documentTypeLabel(snapshot: DocumentSnapshot): string {
  return snapshot.documentType === "PURCHASE_ORDER" ? "PURCHASE ORDER" : "INVOICE / FAKTUR";
}

const INDONESIAN_MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** Presentasi STRING murni ("2026-07-15" -> "15 Juli 2026") -- tidak mengubah nilai tanggal. */
function formatIndonesianDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  return `${day} ${INDONESIAN_MONTHS[month - 1]} ${year}`;
}

/** "29 Juli 2026 (14 Hari)" -- null bila paymentTermsDays null (lihat dueDateLabel di atas). */
function computeDueDateLabel(documentDate: string, paymentTermsDays: number | null): string | null {
  if (paymentTermsDays === null) return null;
  const [year, month, day] = documentDate.slice(0, 10).split("-").map(Number);
  const due = new Date(Date.UTC(year, month - 1, day));
  due.setUTCDate(due.getUTCDate() + paymentTermsDays);
  const dueIso = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, "0")}-${String(due.getUTCDate()).padStart(2, "0")}`;
  return `${formatIndonesianDate(dueIso)} (${paymentTermsDays} Hari)`;
}

/** SATU snapshot -> SATU view model (1 dokumen = 1 panel transaksi, tidak ada duplikasi isi). */
export function buildPrintViewModel(snapshot: DocumentSnapshot): PrintDocumentViewModel {
  return {
    documentTypeLabel: documentTypeLabel(snapshot),
    documentNumber: snapshot.documentNumber,
    documentDateLabel: formatIndonesianDate(snapshot.documentDate),
    dueDateLabel: computeDueDateLabel(snapshot.documentDate, snapshot.paymentTermsDays),
    tenant: snapshot.tenant,
    storeCode: snapshot.store.storeCode ?? "-",
    storeName: snapshot.store.storeName,
    storeAddress: snapshot.store.storeAddress ?? "-",
    storePhone: snapshot.store.storePhone ?? "-",
    salesmanName: snapshot.salesman.salesmanName,
    orderReference: snapshot.orderReference,
    deliveryReference: snapshot.deliveryReference,
    paymentTermsLabel: snapshot.paymentTermsDays !== null ? `${snapshot.paymentTermsDays} Hari` : null,
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
    receiverName: snapshot.store.picName,
  };
}
