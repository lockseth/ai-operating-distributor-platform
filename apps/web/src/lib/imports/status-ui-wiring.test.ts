// =============================================================================
// Import Data — Status UX Correction: architecture fitness function.
//
// Codebase ini tidak punya infra React component-rendering test (vitest.config.ts:
// environment "node", tidak ada @testing-library/react/jsdom -- lihat juga
// dispatch/ui-wiring.test.ts untuk pola yang sama). Test di sini memverifikasi
// KONTRAK WIRING lewat pembacaan source: setiap halaman yang menampilkan status
// batch WAJIB memakai deriveImportStatusLabel(), TIDAK PERNAH menampilkan
// batch.status/b.status mentah (enum internal "VALIDATED" dkk) langsung ke
// pengguna. Logika derivasi sendiri (lima label + edge case) sudah diuji penuh
// di data-onboarding/core/status-label.test.ts.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const listPageSource = readFileSync(
  path.resolve(__dirname, "../../app/(dashboard)/dashboard/imports/page.tsx"), "utf-8"
);
const detailPageSource = readFileSync(
  path.resolve(__dirname, "../../app/(dashboard)/dashboard/imports/[id]/page.tsx"), "utf-8"
);
const wizardSource = readFileSync(
  path.resolve(__dirname, "../../components/imports/import-wizard.tsx"), "utf-8"
);

describe("Import Data status UX -- konsisten pakai deriveImportStatusLabel, tidak pernah enum mentah", () => {
  it("daftar batch (list page) memakai deriveImportStatusLabel, bukan {b.status} mentah", () => {
    expect(listPageSource).toContain("deriveImportStatusLabel");
    expect(listPageSource).not.toMatch(/\{b\.status\}/);
  });

  it("halaman detail batch memakai deriveImportStatusLabel, bukan {batch.status} mentah", () => {
    expect(detailPageSource).toContain("deriveImportStatusLabel");
    expect(detailPageSource).not.toMatch(/\{batch\.status\}/);
  });

  it("wizard step hasil validasi memakai deriveImportStatusLabel", () => {
    expect(wizardSource).toContain("deriveImportStatusLabel");
  });

  it("tombol Commit di halaman detail TIDAK hanya digerbang oleh batch.status mentah -- ada guard commitAllowed dari status turunan", () => {
    expect(detailPageSource).toContain("commitAllowed");
    expect(detailPageSource).toMatch(/commitAllowed\s*&&\s*canCommit/);
  });

  it("ketiga file mengimpor deriveImportStatusLabel dari Universal Core (satu sumber kebenaran, tidak duplikat logika)", () => {
    for (const src of [listPageSource, detailPageSource, wizardSource]) {
      expect(src).toContain('@/lib/data-onboarding/core/status-label');
    }
  });
});
