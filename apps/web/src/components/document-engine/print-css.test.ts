// =============================================================================
// Print stylesheet spec test -- membaca print.css sebagai teks murni (tidak
// perlu jsdom/browser untuk memverifikasi aturan @page dan ukuran halaman).
//
// LOCKED (Founder, 23 Juli 2026, keputusan final hari ini): Continuous Form
// 3 Ply, SATU lembar fisik 9.5x11in dibagi 2 panel horizontal 9.5x5.5in
// (".doc-engine-sheet" > ".doc-engine-panel" x2). Supersede LOCK sebelumnya
// hari ini (satu transaksi = satu halaman penuh 11in, ".doc-engine-page")
// -- lihat AODP_DOCUMENT_LAYOUT_GUIDE.md revision history untuk kronologi
// lengkap.
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve(__dirname, "./print.css"), "utf-8");
/** CSS tanpa komentar -- dipakai untuk memeriksa DEKLARASI aktual, bukan komentar dokumentasi ("BUKAN A4" adalah komentar yang sah). */
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("print.css -- 13, 14, 15 (spesifikasi kertas LOCKED)", () => {
  it("13. @page menggunakan ukuran fisik 9.5in x 11in", () => {
    expect(css).toMatch(/@page\s*{[^}]*size:\s*9\.5in\s+11in/);
  });

  it("14. REGRESSION LOCKED 2026-07-23 (final): satu lembar fisik 9.5x11in (.doc-engine-sheet) dibagi 2 panel horizontal 9.5x5.5in (.doc-engine-panel) -- supersede LOCK 'satu transaksi = satu halaman penuh 11in' hari ini", () => {
    expect(css).toMatch(/\.doc-engine-sheet\s*{[^}]*width:\s*9\.5in/);
    expect(css).toMatch(/\.doc-engine-sheet\s*{[^}]*height:\s*11in/);
    expect(css).toMatch(/\.doc-engine-panel\s*{[^}]*height:\s*5\.5in/);
    // Kelas halaman-penuh lama (".doc-engine-page" persis) TIDAK BOLEH tersisa.
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-page\s*[{,]/);
  });

  it("15. tidak ada deklarasi CSS aktual yang memakai ukuran A4 (210mm/297mm) -- komentar dokumentasi 'BUKAN A4' tidak dihitung", () => {
    expect(cssWithoutComments.toUpperCase()).not.toContain("A4");
    expect(cssWithoutComments).not.toMatch(/210mm/);
    expect(cssWithoutComments).not.toMatch(/297mm/);
  });

  it("tidak memakai layout bagi 3 (tidak ada pembagian 33%/panel ketiga)", () => {
    expect(css).not.toMatch(/33\.3+%/);
    expect(css).not.toMatch(/\/\s*3\b/);
    expect(css).not.toMatch(/panel-c\b/i);
    expect(css).not.toMatch(/third-panel/i);
  });

  it("konten panel dijaga tidak melebihi 5.5in (overflow hidden pada .doc-engine-panel dan .doc-engine-sheet)", () => {
    expect(css).toMatch(/\.doc-engine-panel\s*{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.doc-engine-sheet\s*{[^}]*overflow:\s*hidden/);
  });

  it("lembar fisik dipisah setelah setiap sheet (page-break-after pada .doc-engine-sheet, BUKAN per panel) supaya dua panel tetap dalam satu lembar 11in", () => {
    expect(css).toMatch(/\.doc-engine-sheet\s*{[^}]*page-break-after:\s*always/);
    // page-break-after TIDAK boleh dipasang pada level panel individual --
    // itu akan memaksa setiap panel jadi lembar terpisah, melanggar "dua
    // transaksi per lembar fisik".
    const panelBlockMatch = cssWithoutComments.match(/\.doc-engine-panel\s*{[^}]*}/);
    expect(panelBlockMatch?.[0] ?? "").not.toMatch(/page-break-after/);
  });

  it("safe padding tersedia pada area konten (tidak menempel tepi/perforasi)", () => {
    expect(css).toMatch(/\.doc-engine-content\s*{[^}]*padding:\s*0\.\d+in/);
  });

  it("margin browser dihilangkan pada @page dan body", () => {
    expect(css).toMatch(/@page\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/(?:html,\s*\n?\s*)?body\s*{[^}]*margin:\s*0/);
  });

  it("AUDIT FIX (corrective pass kedua, LOCK 'AODP WALUYO'): ilustrasi perforasi/sprocket DIHAPUS TOTAL dari stylesheet -- tidak ada kelas, aturan, atau radial-gradient perforasi tersisa sama sekali", () => {
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-perforation/);
    expect(cssWithoutComments).not.toMatch(/radial-gradient/);
    expect(cssWithoutComments).not.toMatch(/print-color-adjust/);
  });

  it("garis identitas hijau/oranye di bawah header tersedia", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-identity-divider\b/);
  });

  it("REGRESSION LOCKED: footer benefit/service, badge continuous-form, dan strip COPY 1-4 tetap DIHAPUS (ruang panel 5.5in tidak cukup untuk elemen dekoratif tambahan)", () => {
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-copy-strip\b/);
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-benefit\b/);
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-thanks\b/);
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-form-badge\b/);
  });

  it("panel kosong (slot bawah pada jumlah transaksi ganjil) tersedia sebagai kelas terpisah tanpa konten dokumen", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-panel-empty\s*{[^}]*height:\s*5\.5in/);
  });

  it("label proof (Panel Atas/Bawah) disembunyikan PAKSA saat @media print, apa pun nilai data-proof-mode -- TIDAK PERNAH tercetak di PDF produksi maupun PDF debug (AUDIT FIX: lihat EmptyPrintPanel.test.ts/laporan corrective pass untuk koreksi klaim Proof C sebelumnya)", () => {
    const printBlockMatch = cssWithoutComments.match(/@media print\s*{[\s\S]*?\n}/);
    expect(printBlockMatch).not.toBeNull();
    expect(printBlockMatch![0]).toMatch(/\.doc-engine-proof-label\s*{[^}]*display:\s*none\s*!important/);
  });

  it("label proof HANYA tampil ketika data-proof-mode=\"true\" pada SCREEN (default tersembunyi) -- tidak pernah pada PDF/print apa pun nilai atributnya", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-proof-label\s*{[^}]*display:\s*none/);
    expect(cssWithoutComments).toMatch(/\.doc-engine-sheet\[data-proof-mode="true"\]\s*\.doc-engine-proof-label\s*{[^}]*display:\s*block/);
  });

  it("garis bagi (.doc-engine-divider-guide) TIDAK dipaksa disembunyikan saat @media print -- ini penanda potong production yang sah (LOCK bagian 5.5-5.6), berbeda dari label proof teks", () => {
    const printBlockMatch = cssWithoutComments.match(/@media print\s*{[\s\S]*?\n}/);
    expect(printBlockMatch![0]).not.toMatch(/\.doc-engine-divider-guide/);
  });

  it("indikator Halaman X/N tersedia sebagai styling ringan (continuation panel, LOCK 'AODP WALUYO')", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-page-indicator\b/);
  });

  it("penanda continuation ('Bersambung') tersedia, terpisah dari footer-row (totals/tanda tangan)", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-continuation-marker\b/);
  });
});
