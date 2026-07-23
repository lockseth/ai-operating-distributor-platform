// =============================================================================
// EmptyPrintPanel test -- membuktikan panel kosong (slot bawah pada jumlah
// transaksi ganjil) BENAR-BENAR kosong: tidak ada sprocket/perforation
// holes, decorative dots, background illustration, header, nomor dokumen,
// tabel item, atau tanda tangan. AUDIT FIX 23 Juli 2026 (corrective pass) --
// sebelumnya perforasi sheet meluber ke area panel kosong ini pada PDF
// produksi (lihat print.css: .doc-engine-sheet[data-has-bottom="false"]
// .doc-engine-perforation).
// =============================================================================

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyPrintPanel } from "./EmptyPrintPanel";

describe("EmptyPrintPanel", () => {
  const html = renderToStaticMarkup(createElement(EmptyPrintPanel));

  it("markup HANYA satu elemen kosong tanpa children -- tidak ada elemen lain tersembunyi di dalamnya", () => {
    expect(html).toBe('<div class="doc-engine-panel-empty" data-empty-panel="true"></div>');
  });

  it("tidak merender perforasi/sprocket/dekorasi continuous-form apa pun", () => {
    expect(html).not.toContain("doc-engine-perforation");
  });

  it("tidak merender header/identitas perusahaan/logo", () => {
    expect(html).not.toContain("doc-engine-header");
    expect(html).not.toContain("doc-engine-logo");
    expect(html).not.toContain("doc-engine-company");
  });

  it("tidak merender nomor dokumen apa pun (data-document-number)", () => {
    expect(html).not.toContain("data-document-number");
  });

  it("tidak merender tabel item", () => {
    expect(html).not.toContain("doc-engine-items");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<td");
  });

  it("tidak merender panel tanda tangan (Salesman/Pengirim/Penerima) atau ringkasan total", () => {
    expect(html).not.toContain("doc-engine-signature");
    expect(html).not.toContain("SALESMAN");
    expect(html).not.toContain("PENGIRIM");
    expect(html).not.toContain("PENERIMA");
    expect(html).not.toContain("doc-engine-totals");
    expect(html).not.toContain("GRAND TOTAL");
  });

  it("tidak merender label proof/debug apa pun", () => {
    expect(html).not.toContain("Panel Atas");
    expect(html).not.toContain("Panel Bawah");
    expect(html).not.toContain("doc-engine-proof-label");
  });
});
