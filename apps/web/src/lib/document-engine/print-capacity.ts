// =============================================================================
// Document Engine -- kapasitas baris item per panel cetak Continuous Form 3
// Ply, bagi 2 (9.5x5.5in per panel, LOCKED Founder 23 Juli 2026). Nilai
// MAX_ITEM_ROWS_PER_PANEL diukur dari layout print.css AKTUAL -- BUKAN
// tebakan (lihat dokumentasi pengukuran di bawah).
//
// LOCK Founder "AODP WALUYO -- CONTINUATION PANEL PRINT GATE" (23 Juli 2026,
// corrective pass kedua): transaksi yang melebihi kapasitas SATU panel
// TIDAK LAGI ditolak (PanelCapacityExceededError/assertPanelCapacity
// DIHAPUS dari modul ini) -- transaksi dilanjutkan ke panel berikutnya lewat
// print-pagination.ts (paginatePrintDocument). Nilai MAX_ITEM_ROWS_PER_PANEL
// di sini SEKARANG dipakai sebagai kapasitas PER HALAMAN continuation, bukan
// lagi sebagai batas penolakan. Batas DOMAIN dokumen (berapa banyak baris
// yang boleh dimiliki SATU dokumen sebelum issuance ditolak) adalah hal
// TERPISAH -- lihat source-validation.ts (MAX_DOCUMENT_LINE_ITEMS, 30, TIDAK
// lagi disatukan dengan angka di sini).
// =============================================================================

/**
 * Diukur dari rendering NYATA print.css pada panel 5.5in dengan fixture
 * WORST-CASE realistis (Chrome headless, getBoundingClientRect: posisi
 * bawah .doc-engine-footer-row relatif terhadap batas bawah panel -- lihat
 * laporan gate "Document Governance Reconciliation and Half-Sheet Print
 * Gate", 23 Juli 2026, corrective pass pertama, bagian Visual Proof/Capacity;
 * dikonfirmasi ulang pada corrective pass kedua (continuation panel) dengan
 * indikator "Halaman X/N" ditambahkan pada panel final -- tetap aman pada
 * margin yang sama karena continuation marker pada panel NON-final
 * menggantikan footer-row yang jauh lebih besar, bukan menambahnya).
 *
 * Pengukuran AWAL dengan fixture nama produk PENDEK satu baris ("Produk
 * Contoh N") sempat menunjukkan 21 baris muat -- ANGKA INI TERBUKTI TIDAK
 * AMAN dan sudah DIKOREKSI, karena tidak merepresentasikan nama
 * produk/jenis produk/alamat toko asli yang jauh lebih panjang dan bisa
 * wrap ke 2+ baris per sel tabel.
 *
 * Pengukuran ULANG dengan fixture WORST-CASE (nama produk ~80 karakter,
 * jenis produk ~55 karakter, kode barang ~45 karakter, harga/qty besar,
 * alamat toko ~120 karakter, nama salesman/PIC panjang -- domain distributor
 * sembako realistis), untuk PO dan Invoice (Invoice punya 1 baris info
 * tambahan "Ref. Delivery"):
 *   - n=10 baris: PO slack 0.32in, Invoice slack 0.31in dari batas panel
 *     (footer-row TETAP di dalam 5.5in) -- AMAN.
 *   - n=11 baris: PO slack 0.07in, Invoice slack 0.06in -- MASIH muat tapi
 *     margin terlalu tipis (kurang dari satu baris teks) untuk dianggap
 *     aman lintas printer/rendering environment.
 *   - n=12 baris: PO/Invoice OVERFLOW terbukti (footer-row keluar panel,
 *     scrollHeight 5.6458in > clientHeight 5.5in).
 *
 * MAX_ITEM_ROWS_PER_PANEL ditetapkan **10** -- angka teraman yang benar-benar
 * terbukti muat (margin >0.3in) di bawah worst-case terukur, BUKAN tebakan.
 * Kelebihan baris TIDAK LAGI ditolak -- dilanjutkan ke panel berikutnya.
 */
export const MAX_ITEM_ROWS_PER_PANEL = 10;
