// =============================================================================
// AODP Document Engine -- empty print panel. Dirender pada slot bawah sheet
// TERAKHIR ketika jumlah transaksi dalam batch cetak GANJIL (LOCKED Founder
// 23 Juli 2026, lihat AODP_DOCUMENT_LAYOUT_GUIDE.md bagian "Batching Dua
// Transaksi").
//
// AUDIT FIX 23 Juli 2026 (corrective pass): panel kosong WAJIB benar-benar
// kosong -- tidak ada header, nomor dokumen, tabel item, tanda tangan,
// perforasi/sprocket illustration, atau dekorasi continuous-form apa pun.
// Komponen ini SENGAJA hanya berupa satu elemen tanpa children supaya
// properti "benar-benar kosong" bisa dibuktikan langsung dari markup-nya
// (lihat EmptyPrintPanel.test.ts), bukan hanya diasumsikan dari CSS.
// Perforasi sheet (.doc-engine-perforation) TIDAK dirender di sini -- itu
// milik PhysicalPrintSheet, dan dibatasi tingginya lewat CSS
// (.doc-engine-sheet[data-has-bottom="false"] .doc-engine-perforation)
// supaya tidak meluber ke area panel kosong ini.
// =============================================================================

export function EmptyPrintPanel() {
  return <div className="doc-engine-panel-empty" data-empty-panel="true" />;
}
