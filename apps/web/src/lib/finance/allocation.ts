// =============================================================================
// Alokasi otomatis pembayaran ke invoice outstanding -- insight Pak Waluyo
// (2026-08-19): kalau toko "titip uang" tanpa menyebut invoice spesifik dan
// punya >1 tagihan outstanding, uang itu dialokasikan ke tagihan PALING LAMA
// (tertua) dulu (FIFO by due_date). Pure function (tanpa I/O) -- hasilnya
// dipakai sebagai PRE-FILL di layar approval Finance, BUKAN auto-commit;
// Finance tetap bisa koreksi sebelum konfirmasi (ledger tidak pernah
// tersentuh langsung dari fungsi ini).
// =============================================================================

export interface AllocatableInvoice {
  id: string;
  outstandingBalance: number;
  /** ISO date string atau null kalau invoice tidak punya jatuh tempo tercatat. */
  dueDate: string | null;
}

/**
 * Urutkan invoice dari yang paling lama (due_date paling awal) ke paling
 * baru. Invoice tanpa due_date diletakkan PALING TERAKHIR (bukan paling
 * awal) -- umurnya tidak diketahui, jadi tidak diasumsikan sebagai yang
 * paling mendesak.
 */
export function sortInvoicesByAge(invoices: AllocatableInvoice[]): AllocatableInvoice[] {
  return [...invoices].sort((a, b) => {
    if (a.dueDate === null && b.dueDate === null) return 0;
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
  });
}

/**
 * Alokasikan `amount` ke `invoices` mulai dari yang paling tua, mengisi
 * penuh outstanding_balance tiap invoice sebelum lanjut ke invoice
 * berikutnya, sampai amount habis. Hasil: map invoiceId -> nominal
 * teralokasi (hanya invoice yang benar-benar dapat alokasi > 0).
 */
export function autoAllocateFifo(amount: number, invoices: AllocatableInvoice[]): Record<string, number> {
  const result: Record<string, number> = {};
  if (amount <= 0) return result;

  let remaining = amount;
  for (const inv of sortInvoicesByAge(invoices)) {
    if (remaining <= 0) break;
    if (inv.outstandingBalance <= 0) continue;
    const alloc = Math.min(remaining, inv.outstandingBalance);
    result[inv.id] = alloc;
    remaining -= alloc;
  }
  return result;
}
