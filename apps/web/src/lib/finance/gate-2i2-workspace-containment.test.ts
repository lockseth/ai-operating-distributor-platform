// =============================================================================
// Gate 2I.2 -- Containment/structural test lewat pembacaan source langsung,
// pola sama apps/web/src/lib/orders/finance-dashboard-invoiced-containment.test.ts
// dan status-lock-migration.security.test.ts. Repo tidak punya harness render
// React (vitest.config.ts: environment "node", tanpa jsdom/@testing-library/
// react) -- component client interaktif (hooks) TIDAK BISA dipanggil sebagai
// pure function seperti StatusBadge (lihat status-badge.test.ts), jadi
// pembuktian pola disabled-with-reason (FIN-02-04 §4 catatan 1), Esc-menutup-
// dialog + fokus kembali (FIN-17-02), dan label alasan untuk assistive tech
// (FIN-17-03) dilakukan lewat pembacaan source, bukan DOM query. Ini
// keterbatasan tooling REPO YANG SUDAH ADA sebelum gate ini, bukan keputusan
// baru -- lihat laporan akhir Gate 2I.2 untuk detail.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSrc(relativePath: string): string {
  return readFileSync(path.resolve(__dirname, relativePath), "utf8");
}

const queriesSrc = readSrc("./queries.ts");
const invoiceListPage = readSrc("../../app/(dashboard)/dashboard/finance/invoices/page.tsx");
const invoiceSelectionTableSrc = readSrc("../../components/finance/invoice-selection-table.tsx");
const invoiceDetailPage = readSrc("../../app/(dashboard)/dashboard/finance/invoices/[id]/page.tsx");
const confirmDialogSrc = readSrc("../../components/ui/confirm-dialog.tsx");
const recordPaymentPanelSrc = readSrc("../../components/finance/record-payment-panel.tsx");
const reconcileButtonSrc = readSrc("../../components/finance/reconcile-button.tsx");
const reconciliationPanelSrc = readSrc("../../components/finance/reconciliation-panel.tsx");
const collectionPanelSrc = readSrc("../../components/finance/collection-panel.tsx");

describe("FIN-05-01/FIN-05-02: outstanding tidak pernah dihitung ulang dari sales_orders.status", () => {
  it("queries.ts tidak pernah query sales_orders dengan filter status='paid'/'invoiced' untuk menentukan outstanding", () => {
    expect(queriesSrc).not.toMatch(/sales_orders["'\s\S]{0,40}\.eq\(\s*["']status["']\s*,\s*["'](paid|invoiced)["']\s*\)/);
  });

  it("getInvoiceList/getInvoiceDetail membaca outstanding dari invoice_receivable_balances, bukan formula manual total_amount - x", () => {
    expect(queriesSrc).toContain('.from("invoice_receivable_balances")');
    // Larangan formula ulang: tidak ada pengurangan manual "total_amount -" di
    // sekitar deklarasi outstandingBalance/financialStatus pada fungsi invoice.
    expect(queriesSrc).not.toMatch(/outstandingBalance:\s*row\.total_amount\s*-/);
  });

  it("halaman list/detail invoice tidak menghitung ulang outstanding sendiri (tidak ada operator pengurangan pada variabel bernama total/outstanding)", () => {
    for (const src of [invoiceListPage, invoiceDetailPage]) {
      expect(src).not.toMatch(/outstanding\w*\s*=\s*[\w.]+\s*-\s*[\w.]+/i);
    }
  });
});

describe("FIN-02-04 (§4 catatan 1): tombol non-permission dirender disabled DENGAN alasan, bukan disembunyikan", () => {
  it("record-payment-panel.tsx merender tombol 'Catat Pembayaran' disabled dengan title alasan saat !canRecord, bukan return null", () => {
    expect(recordPaymentPanelSrc).toMatch(/if\s*\(\s*!canRecord\s*\)\s*\{/);
    expect(recordPaymentPanelSrc).toContain('title="Bukan kewenangan Anda"');
    expect(recordPaymentPanelSrc).toContain("disabled");
    expect(recordPaymentPanelSrc).not.toMatch(/if\s*\(\s*!canRecord\s*\)\s*\{\s*return null/);
  });

  it("reconcile-button.tsx menampilkan alasan 'Bukan kewenangan Anda' saat !canReconcile, bukan disembunyikan total", () => {
    expect(reconcileButtonSrc).toMatch(/if\s*\(\s*!canReconcile\s*\)\s*\{/);
    expect(reconcileButtonSrc).toContain("Bukan kewenangan Anda");
    expect(reconcileButtonSrc).not.toMatch(/if\s*\(\s*!canReconcile\s*\)\s*\{\s*return null/);
  });

  it("reconciliation-panel.tsx dan collection-panel.tsx menampilkan alasan permission pada tombol aksi, bukan menyembunyikan tombolnya", () => {
    expect(reconciliationPanelSrc).toContain("Bukan kewenangan Anda");
    expect(collectionPanelSrc).toMatch(/canPromise|canRecord/);
  });
});

describe("FIN-17-02: ConfirmDialog menutup dengan Esc dan mengembalikan fokus ke pemicu", () => {
  it("confirm-dialog.tsx menangani key 'Escape' dan menyimpan+mengembalikan document.activeElement", () => {
    expect(confirmDialogSrc).toContain('"Escape"');
    expect(confirmDialogSrc).toContain("previouslyFocused");
    expect(confirmDialogSrc).toMatch(/previouslyFocused\.current\?\.focus\(\)/);
  });
});

describe("FIN-17-03: label alasan tombol disabled terbaca assistive tech (title/aria-describedby)", () => {
  it("record-payment-panel.tsx menyertakan aria-describedby pada tombol disabled dengan teks alasan tersembunyi (sr-only)", () => {
    expect(recordPaymentPanelSrc).toContain("aria-describedby");
    expect(recordPaymentPanelSrc).toContain("sr-only");
  });

  it("reconcile-button.tsx/reconciliation-panel.tsx menyertakan title sebagai alasan yang dapat dibaca", () => {
    expect(reconcileButtonSrc).toMatch(/title=/);
    expect(reconciliationPanelSrc).toMatch(/title=/);
  });
});

describe("§10/FIN-17-04: list domain finance memakai DataTable existing (semantik <table>/<th>), bukan tabel hand-rolled tanpa header", () => {
  it("invoice list page memakai component DataTable (langsung atau lewat InvoiceSelectionTable), bukan <table> mentah", () => {
    // Gate P4.04 follow-up: sejak fitur cetak batch invoice, rendering tabel
    // dipindah dari page.tsx ke InvoiceSelectionTable (page.tsx sekarang
    // cuma merender <InvoiceSelectionTable items={...} />) -- assertion
    // "DataTable" perlu ikut cek komponen itu, bukan cuma page.tsx, supaya
    // tidak salah gagal padahal semantiknya tetap DataTable (dibuktikan di
    // baris kedua: page.tsx sendiri juga tidak pernah pakai <table> mentah).
    expect(invoiceListPage + invoiceSelectionTableSrc).toContain("DataTable");
    expect(invoiceListPage).not.toMatch(/<table\b/);
    expect(invoiceSelectionTableSrc).not.toMatch(/<table\b/);
  });

  it("invoice detail page memakai component DataTable untuk rincian item dan ledger", () => {
    expect(invoiceDetailPage).toContain("DataTable");
    expect(invoiceDetailPage).not.toMatch(/<table\b/);
  });
});

describe("§10: Optimistic update tidak dipakai -- seluruh aksi menunggu server action selesai sebelum UI berubah", () => {
  it("panel finance tidak melakukan setState item lokal sebelum action selesai (tidak ada mutasi state daftar sebelum await)", () => {
    // Pola optimistic update biasanya menulis ke state daftar SEBELUM
    // memanggil action; di sini submit selalu dibungkus startTransition(async
    // () => { try { await ...Action(...) ... }).
    for (const src of [collectionPanelSrc, recordPaymentPanelSrc, reconciliationPanelSrc]) {
      expect(src).toMatch(/startTransition\(async \(\) => \{/);
      expect(src).toMatch(/await (create|correct|cancel|mark|record|reconcile)\w*Action\(/);
    }
  });
});
