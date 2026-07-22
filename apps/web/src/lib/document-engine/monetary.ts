// =============================================================================
// Document Engine -- monetary/quantity invariant. SATU-SATUNYA tempat yang
// menghitung lineTotal/subtotal/discount/grandTotal. Builder (po-builder.ts,
// invoice-builder.ts) WAJIB memanggil fungsi di sini, tidak pernah menghitung
// uang sendiri -- dan renderer (components/document-engine) TIDAK PERNAH
// mengimpor file ini sama sekali (renderer murni membaca DocumentSnapshot
// yang sudah jadi). formatRupiah()/terbilang() di bawah adalah presentasi
// STRING murni, bukan kalkulasi nilai -- tidak mengubah angka apa pun.
//
// KEPUTUSAN BISNIS LOCKED (Repository & Persistence Closure Gate): template
// Totals kontrak aktif Pak Waluyo HANYA Subtotal/Potongan/Total/Terbilang --
// TIDAK ADA DPP/PPN/Other Charges. Template lama yang sempat menampilkan
// DPP/PPN (docs/document-engine/constitution/AODP_DOCUMENT_LAYOUT_GUIDE.md)
// adalah draft lama yang SUDAH SUPERSEDED, bukan source-of-truth kontrak
// aktif -- JANGAN menambahkan field/kolom pajak (bahkan bernilai 0) tanpa
// konfigurasi dan data pajak eksplisit dari kontrak bisnis yang baru.
// =============================================================================

import type { DocumentLineSnapshot, DocumentTotals } from "./types";

export interface MonetaryLineInput {
  quantity: number;
  unitPrice: number;
  discountAmount: number;
}

export function computeLineTotal(input: MonetaryLineInput): number {
  return input.quantity * input.unitPrice - input.discountAmount;
}

export function computeTotals(lines: DocumentLineSnapshot[]): DocumentTotals {
  let subtotal = 0;
  let totalDiscount = 0;
  for (const line of lines) {
    subtotal += line.quantity * line.unitPrice;
    totalDiscount += line.discountAmount;
  }
  return {
    subtotal,
    totalDiscount,
    grandTotal: subtotal - totalDiscount,
  };
}

/** Presentasi STRING murni (format "Rp1.234") -- tidak pernah dipakai untuk kalkulasi ulang. */
export function formatRupiah(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString("id-ID")}`;
}

const SATUAN = [
  "",
  "satu",
  "dua",
  "tiga",
  "empat",
  "lima",
  "enam",
  "tujuh",
  "delapan",
  "sembilan",
  "sepuluh",
  "sebelas",
];

function terbilangInt(n: number): string {
  if (n < 12) return SATUAN[n];
  if (n < 20) return `${terbilangInt(n - 10)} belas`;
  if (n < 100) {
    const sisa = n % 10;
    return `${terbilangInt(Math.floor(n / 10))} puluh${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  if (n < 200) {
    const sisa = n % 100;
    return `seratus${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  if (n < 1000) {
    const sisa = n % 100;
    return `${terbilangInt(Math.floor(n / 100))} ratus${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  if (n < 2000) {
    const sisa = n % 1000;
    return `seribu${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  if (n < 1_000_000) {
    const sisa = n % 1000;
    return `${terbilangInt(Math.floor(n / 1000))} ribu${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  if (n < 1_000_000_000) {
    const sisa = n % 1_000_000;
    return `${terbilangInt(Math.floor(n / 1_000_000))} juta${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  if (n < 1_000_000_000_000) {
    const sisa = n % 1_000_000_000;
    return `${terbilangInt(Math.floor(n / 1_000_000_000))} miliar${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
  }
  const sisa = n % 1_000_000_000_000;
  return `${terbilangInt(Math.floor(n / 1_000_000_000_000))} triliun${sisa !== 0 ? ` ${terbilangInt(sisa)}` : ""}`;
}

/**
 * Presentasi STRING murni (angka -> kata Bahasa Indonesia + "Rupiah"), sesuai
 * keputusan LOCKED gate ini -- SATU-SATUNYA baris Totals tambahan di luar
 * Subtotal/Potongan/Total (tidak ada DPP/PPN). Selalu dibulatkan ke rupiah
 * bulat (tidak menghasilkan angka desimal dalam kata) -- tidak pernah dipakai
 * untuk kalkulasi ulang.
 */
export function terbilang(amount: number): string {
  const rounded = Math.round(Math.abs(amount));
  const words = rounded === 0 ? "nol" : terbilangInt(rounded);
  const capitalized = words.replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  const sign = amount < 0 ? "Minus " : "";
  return `${sign}${capitalized} Rupiah`;
}
