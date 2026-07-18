import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "import-execution.ts"), "utf8");

describe("8/9. Modul import lama tidak lagi membuat batch baru (digantikan Universal Data Onboarding)", () => {
  it("executeImportAction melempar error sebelum menyentuh Supabase (tidak pernah insert import_jobs baru)", () => {
    const fnStart = source.indexOf("export async function executeImportAction");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf("\n}\n", fnStart));

    const throwIndex = fnBody.indexOf("throw new Error(");
    const lastThrowIndex = fnBody.lastIndexOf("throw new Error(");
    // Throw blocking harus ada, dan TIDAK ADA panggilan .insert("import_jobs" setelah access-check --
    // fungsi harus berhenti sebelum mencoba membuat job baru.
    expect(throwIndex).toBeGreaterThan(-1);
    expect(fnBody).not.toMatch(/from\(["']import_jobs["']\)\s*\.\s*insert/);
    void lastThrowIndex;
  });

  it("pesan error mengarahkan admin ke /dashboard/imports (modul canonical)", () => {
    expect(source).toMatch(/\/dashboard\/imports/);
  });

  it("getImportJobsAction (riwayat, read-only) TETAP ada -- data lama tidak dihapus/disembunyikan", () => {
    expect(source).toMatch(/export async function getImportJobsAction/);
  });
});
