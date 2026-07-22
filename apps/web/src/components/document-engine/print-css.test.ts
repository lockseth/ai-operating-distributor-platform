// =============================================================================
// Print stylesheet spec test -- membaca print.css sebagai teks murni (tidak
// perlu jsdom/browser untuk memverifikasi aturan @page dan ukuran panel).
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

  it("14. layout terdiri dari dua panel 9.5in x 5.5in", () => {
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*width:\s*9\.5in/);
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*height:\s*11in/);
    expect(css).toMatch(/\.doc-engine-panel\s*{[^}]*width:\s*9\.5in/);
    expect(css).toMatch(/\.doc-engine-panel\s*{[^}]*height:\s*5\.5in/);
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

  it("panel dilindungi dari page-break di dalamnya (page-break-inside avoid)", () => {
    expect(css).toMatch(/\.doc-engine-panel\s*{[^}]*page-break-inside:\s*avoid/);
  });

  it("halaman dipisah setelah 2 panel (page-break-after) supaya tidak melewati batas halaman", () => {
    expect(css).toMatch(/\.doc-engine-page\s*{[^}]*page-break-after:\s*always/);
  });

  it("safe padding tersedia pada panel (tidak menempel tepi/perforasi)", () => {
    expect(css).toMatch(/\.doc-engine-panel\s*{[^}]*padding:\s*0\.\d+in/);
  });

  it("margin browser dihilangkan pada @page dan body", () => {
    expect(css).toMatch(/@page\s*{[^}]*margin:\s*0/);
    expect(css).toMatch(/(?:html,\s*\n?\s*)?body\s*{[^}]*margin:\s*0/);
  });
});
