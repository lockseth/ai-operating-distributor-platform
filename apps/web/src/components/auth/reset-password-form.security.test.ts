// Gate 3E-C-C2-B4-R1 — source-contract test untuk reset-password-form.tsx.
// Komponen ini TIDAK diubah oleh gate ini (reuse penuh) -- test ini membuktikan
// kontrak yang sudah ada tetap berlaku untuk sesi recovery baru (item #10 dan
// #13 daftar test gate): kegagalan updateUser() tidak pernah dilaporkan
// sebagai sukses, dan user ordinary kembali ke journey yang aman.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "reset-password-form.tsx"), "utf8");

describe("reset-password-form security contract (Gate 3E-C-C2-B4-R1)", () => {
  it("kegagalan updateUser() TIDAK PERNAH lanjut ke router.push -- tidak melaporkan sukses", () => {
    const errIdx = source.indexOf("if (updateError)");
    expect(errIdx).toBeGreaterThan(-1);
    const returnIdx = source.indexOf("return;", errIdx);
    const pushIdx = source.indexOf("router.push", errIdx);
    expect(returnIdx).toBeGreaterThan(errIdx);
    // return terjadi SEBELUM baris router.push manapun berikutnya dieksekusi
    // pada cabang error ini (router.push hanya dipanggil setelah blok if).
    expect(pushIdx).toBeGreaterThan(returnIdx);
  });

  it("sukses -> redirect ke /login (journey aman, bukan langsung /dashboard)", () => {
    expect(source).toContain('router.push("/login?reset=success")');
  });

  it("tidak pernah menyentuh must_change_password langsung dari client", () => {
    expect(source).not.toContain("must_change_password");
    expect(source).not.toContain(".rpc(");
    expect(source).not.toMatch(/from\(["']users["']\)/);
  });

  it("password tidak pernah di-log", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });
});
