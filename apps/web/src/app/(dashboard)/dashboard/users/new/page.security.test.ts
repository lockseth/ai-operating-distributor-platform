import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

describe("Tambah Pengguna page contract (Gate 3E-C-C2-B3)", () => {
  it("merender AddTenantUserForm (kontrak baru), bukan AddSalesmanForm (jalur lama)", () => {
    expect(page).toContain("AddTenantUserForm");
    expect(page).toContain('@/components/users/add-tenant-user-form');
    expect(page).not.toMatch(/AddSalesmanForm|add-salesman-form/);
  });

  it('judul halaman "Tambah Pengguna", bukan "Tambah Salesman"', () => {
    expect(page).toContain("Tambah Pengguna");
    expect(page).not.toContain("Tambah Salesman");
  });

  it("hanya Owner tenant yang dapat mengakses halaman ini -- non-owner (manager/admin/super_admin) di-redirect", () => {
    const start = page.indexOf("export default async function NewTenantUserPage");
    const body = page.slice(start, start + 600);
    expect(body).toContain('user.roles.includes("owner")');
    expect(body).toContain("if (!isOwner) redirect(");
    // Gate ini SENGAJA lebih ketat dari MANAGE_ROLES lama -- tidak boleh ada
    // jalur alternatif manager/admin/super_admin untuk lolos gating.
    expect(body).not.toMatch(/MANAGE_ROLES|hasPermission/);
  });

  it("tidak lagi query coverage_areas -- form generik tidak butuh Wilayah Kerja", () => {
    expect(page).not.toMatch(/coverage_areas|availableAreas/);
  });
});
