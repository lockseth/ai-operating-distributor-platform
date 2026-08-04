// Gate 3E-C-C2-B4-R1 — source-contract test untuk forgot-password-form.tsx.
// Komponen ini TIDAK diubah oleh gate ini -- test ini membuktikan tujuan
// canonical (item #1 daftar test gate) tetap dipakai: redirectTo fixed
// same-origin ke /reset-password, tidak pernah dari input/query pengguna.
// Link email SENDIRI (token_hash + /auth/confirm) dibangun oleh HOSTED
// Recovery email template Supabase, bukan oleh redirectTo ini -- lihat
// laporan HOSTED CONFIGURATION gate ini.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "forgot-password-form.tsx"), "utf8");

describe("forgot-password-form security contract (Gate 3E-C-C2-B4-R1)", () => {
  it("redirectTo fixed same-origin ke /reset-password (tujuan produksi canonical), tidak dari query/input", () => {
    expect(source).toContain("redirectTo: `${window.location.origin}/reset-password`");
  });

  it("email diambil dari input form sendiri, bukan dari query string", () => {
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("useSearchParams");
  });

  it("email/token tidak pernah di-log", () => {
    expect(source).not.toMatch(/console\.(log|error|warn|info)/);
  });
});
