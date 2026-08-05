// =============================================================================
// GATE AODP — Direct Edit UX & permission-name bugfix regression guard.
//
// Root cause yang diperbaiki gate ini: halaman produk mengecek permission
// "products.edit" yang TIDAK PERNAH di-seed ke public.permissions (nama asli
// yang di-seed & dipakai RLS adalah "products.update") -- akibatnya tombol
// Edit Produk tidak pernah bisa muncul untuk siapa pun, termasuk owner.
// List page Produk/Pelanggan juga hanya punya link "Detail" yang
// opacity-0 sampai di-hover -- tidak permission-gated, tidak mobile-safe.
//
// React Server Component pages di repo ini belum punya harness render test
// (tidak ada contoh existing) -- pola yang SUDAH dipakai di service.test.ts
// ("20. Raw file tidak masuk log") adalah membaca source file langsung untuk
// menegakkan invarian struktural. Test ini mengikuti pola yang sama: bukti
// bug lama tidak regresi, dan bukti kontrak UX (selalu terlihat + permission-
// gated) benar-benar ada di kode, bukan cuma diklaim.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("products.edit -> products.update bugfix (root cause tombol Edit tidak pernah muncul)", () => {
  it("actions.ts TIDAK PERNAH lagi mengecek permission 'products.edit' yang tidak pernah di-seed", () => {
    const content = read("apps/web/src/lib/products/actions.ts");
    expect(content).not.toContain('"products.edit"');
    expect(content).toContain('"products.update"');
  });

  it("halaman detail & edit produk memakai 'products.update', bukan 'products.edit'", () => {
    const detail = read("apps/web/src/app/(dashboard)/dashboard/products/[id]/page.tsx");
    const edit = read("apps/web/src/app/(dashboard)/dashboard/products/[id]/edit/page.tsx");
    expect(detail).not.toContain('"products.edit"');
    expect(detail).toContain('"products.update"');
    expect(edit).not.toContain('"products.edit"');
    expect(edit).toContain('"products.update"');
  });
});

describe("Tombol Edit list page -- selalu terlihat, permission-gated (kontrak UX)", () => {
  it("list Produk: link aksi TIDAK LAGI opacity-0/hover-only, dan ada Edit yang di-gate products.update", () => {
    const content = read("apps/web/src/app/(dashboard)/dashboard/products/page.tsx");
    expect(content).not.toContain("opacity-0 group-hover:opacity-100");
    expect(content).toContain('hasPermission(user.permissions, "products.update")');
    expect(content).toMatch(/canEdit\s*&&/);
    expect(content).toContain("/edit");
  });

  it("list Pelanggan: link aksi TIDAK LAGI opacity-0/hover-only, dan ada Edit yang di-gate customers.update", () => {
    const content = read("apps/web/src/app/(dashboard)/dashboard/customers/page.tsx");
    expect(content).not.toContain("opacity-0 group-hover:opacity-100");
    expect(content).toContain('hasPermission(user.permissions, "customers.update")');
    expect(content).toMatch(/canEdit\s*&&/);
    expect(content).toContain("/edit");
  });
});

describe("Cross-tenant enforcement tetap di server action (UI tidak pernah jadi satu-satunya penjaga)", () => {
  it("updateProductAction & updateCustomerAction tetap men-scope company_id pada UPDATE", () => {
    const products = read("apps/web/src/lib/products/actions.ts");
    const customers = read("apps/web/src/lib/customers/actions.ts");
    expect(products).toMatch(/\.eq\("company_id",\s*user\.company_id\)/);
    expect(customers).toMatch(/\.eq\("company_id",\s*user\.company_id\)/);
  });
});
