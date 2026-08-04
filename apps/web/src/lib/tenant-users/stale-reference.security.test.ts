import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "../../app");
const componentsRoot = path.resolve(__dirname, "../../components");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry) && !/\.test\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("No stale references to the removed Tambah Salesman creation UI (Gate 3E-C-C2-B3)", () => {
  it('tidak ada file app/ atau components/ (selain modul salesman operasional yang tetap dipakai) yang mengimpor add-salesman-form / AddSalesmanForm', () => {
    const files = [...listSourceFiles(appRoot), ...listSourceFiles(componentsRoot)];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (/add-salesman-form|AddSalesmanForm/.test(content)) {
        offenders.push(path.relative(path.resolve(__dirname, "../.."), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('halaman "Tambah Pengguna" (/dashboard/users/new) tidak lagi merender label "Tambah Salesman" di seluruh pohon app/', () => {
    const files = listSourceFiles(appRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (content.includes("Tambah Salesman")) {
        offenders.push(path.relative(path.resolve(__dirname, "../.."), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
