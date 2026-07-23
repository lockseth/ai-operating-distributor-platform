// =============================================================================
// Print stylesheet spec test -- membaca print.css sebagai teks murni (tidak
// perlu jsdom/browser untuk memverifikasi aturan @page dan ukuran halaman).
//
// LOCKED (Founder, 2026-07-23): satu transaksi = SATU halaman fisik 9.5x11in
// -- supersede LOCK lama (2 panel horizontal 9.5x5.5in per halaman). Test
// lama yang mengunci struktur 2-panel (".doc-engine-panel" 5.5in,
// page-break-inside pada panel) DIHAPUS/diubah di sini sesuai instruksi
// Founder -- lihat AODP_DOCUMENT_LAYOUT_GUIDE.md revision history.
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

  it("14. REGRESSION LOCKED 2026-07-23: SATU halaman 9.5in x 11in = SATU dokumen -- TIDAK ADA lagi pembagian 2 panel 9.5x5.5in (supersede LOCK lama)", () => {
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*width:\s*9\.5in/);
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*height:\s*11in/);
    // Kelas panel dua-salinan lama (".doc-engine-panel" persis, BUKAN turunan
    // seperti ".doc-engine-info-panel"/".doc-engine-panel-title") TIDAK BOLEH
    // tersisa sama sekali di stylesheet.
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-panel\s*[{,]/);
    expect(cssWithoutComments).not.toMatch(/5\.5in/);
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

  it("konten dijaga tidak melebihi satu halaman (overflow hidden pada .doc-engine-page)", () => {
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*overflow:\s*hidden/);
  });

  it("halaman dipisah setelah setiap dokumen (page-break-after) supaya tidak melewati batas halaman", () => {
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*page-break-after:\s*always/);
  });

  it("safe padding tersedia pada area konten (tidak menempel tepi/perforasi)", () => {
    expect(css).toMatch(/\.doc-engine-content\s*{[^}]*padding:\s*0\.\d+in/);
  });

  it("margin browser dihilangkan pada @page dan body", () => {
    expect(css).toMatch(/@page\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/(?:html,\s*\n?\s*)?body\s*{[^}]*margin:\s*0/);
  });

  it("perforasi continuous form kiri DAN kanan tersedia (elemen struktural template LOCK)", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-perforation-left\b/);
    expect(cssWithoutComments).toMatch(/\.doc-engine-perforation-right\b/);
  });

  it("garis identitas hijau/oranye di bawah header tersedia", () => {
    expect(cssWithoutComments).toMatch(/\.doc-engine-identity-divider\b/);
  });

  it("REGRESSION LOCKED 2026-07-23: footer benefit/service, badge continuous-form, dan strip COPY 1-4 DIHAPUS (ruang dibebaskan agar tabel tidak bertabrakan pada order banyak baris)", () => {
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-copy-strip\b/);
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-benefit\b/);
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-thanks\b/);
    expect(cssWithoutComments).not.toMatch(/\.doc-engine-form-badge\b/);
  });
});
