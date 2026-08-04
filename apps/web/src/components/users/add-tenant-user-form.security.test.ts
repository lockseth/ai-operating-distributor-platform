import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const form = readFileSync(path.resolve(__dirname, "add-tenant-user-form.tsx"), "utf8");

describe("AddTenantUserForm UI contract (Gate 3E-C-C2-B3)", () => {
  it('CTA utama berlabel "Tambah Pengguna", bukan "Tambah Salesman"', () => {
    expect(form).toContain("Tambah Pengguna");
    expect(form).not.toContain("Tambah Salesman");
  });

  it("role selector hanya berisi admin dan sales -- owner/super_admin tidak pernah muncul sebagai opsi", () => {
    const start = form.indexOf("const ROLE_OPTIONS");
    const end = form.indexOf("];", start);
    const roleOptionsBlock = form.slice(start, end);
    expect(roleOptionsBlock).toContain('value: "admin"');
    expect(roleOptionsBlock).toContain('value: "sales"');
    expect(roleOptionsBlock).not.toMatch(/value:\s*"owner"/);
    expect(roleOptionsBlock).not.toMatch(/value:\s*"super_admin"/);
    expect(form).not.toMatch(/"owner"|"super_admin"/);
  });

  it("tidak ada field password input -- owner tidak pernah mengetik/memilih password", () => {
    expect(form).not.toMatch(/type=(["']){1}password\1/);
    expect(form).not.toMatch(/type=\{["']password["']\}/);
    expect(form).not.toMatch(/tempPassword,\s*setTempPassword/);
  });

  it("submit memanggil createTenantUserAction hanya dengan fullName/email/phone/role -- tidak ada password/company/actor dari client", () => {
    const start = form.indexOf("await createTenantUserAction({");
    expect(start).toBeGreaterThan(-1);
    const end = form.indexOf("});", start);
    const callBody = form.slice(start, end);
    expect(callBody).toContain("fullName: fullName.trim()");
    expect(callBody).toContain("email: email.trim()");
    expect(callBody).toContain("phone: phone.trim()");
    expect(callBody).toContain("role,");
    expect(callBody).not.toMatch(/password/i);
    expect(callBody).not.toMatch(/company_?id/i);
    expect(callBody).not.toMatch(/actor_?id/i);
  });

  it("tempPassword yang dirender berasal HANYA dari hasil sukses sekali panggil (result.tempPassword), tidak pernah dari state lain", () => {
    const setCreatedStart = form.indexOf("setCreated({");
    const setCreatedEnd = form.indexOf("});", setCreatedStart);
    const setCreatedBody = form.slice(setCreatedStart, setCreatedEnd);
    expect(setCreatedBody).toContain("tempPassword: result.tempPassword");

    // Guard: setCreated hanya dipanggil di jalur sukses (setelah early-return
    // pada !result.ok), tidak pernah dengan data parsial pada error.
    const guardStart = form.indexOf("if (!result.ok || !result.tempPassword)");
    expect(guardStart).toBeGreaterThan(-1);
    expect(guardStart).toBeLessThan(setCreatedStart);

    // Render password hanya muncul di dalam blok sukses (if (created)),
    // bukan di form input awal.
    const createdBlockStart = form.indexOf("if (created) {");
    const createdBlockEnd = form.indexOf("\n  const inputCls", createdBlockStart);
    const createdBlock = form.slice(createdBlockStart, createdBlockEnd);
    expect(createdBlock).toContain("created.tempPassword");

    const formSectionStart = createdBlockEnd;
    const formSection = form.slice(formSectionStart);
    expect(formSection).not.toMatch(/created\.tempPassword/);
  });

  it("password lenyap dari state setelah dismiss -- handleDismiss membersihkan state SEBELUM navigasi", () => {
    const start = form.indexOf("function handleDismiss()");
    const end = form.indexOf("\n  }", start);
    const body = form.slice(start, end);
    expect(body.indexOf("setCreated(null)")).toBeGreaterThan(-1);
    expect(body.indexOf("setCreated(null)")).toBeLessThan(body.indexOf("router.push"));
  });

  it("tidak pernah menyimpan/menampilkan ulang password lewat localStorage/sessionStorage/URL/console/refetch", () => {
    expect(form).not.toMatch(/localStorage\.|sessionStorage\./);
    expect(form).not.toMatch(/console\.(log|error|warn|info|debug)/);
    expect(form).not.toMatch(/searchParams|URLSearchParams|router\.push\([^)]*tempPassword/);
  });

  it("duplicate submit diblok: guard isPending eksplisit + tombol submit disabled selama pending", () => {
    expect(form).toContain("if (isPending) return;");
    expect(form).toMatch(/disabled=\{isPending\}/);
  });

  it("error fail closed: exception ditangkap dan tidak pernah menampilkan detail exception mentah, tidak pernah men-set state created", () => {
    const tryStart = form.indexOf("try {\n        result = await createTenantUserAction");
    expect(tryStart).toBeGreaterThan(-1);
    const catchStart = form.indexOf("} catch {", tryStart);
    expect(catchStart).toBeGreaterThan(-1);
    const catchEnd = form.indexOf("}", catchStart + "} catch {".length);
    const catchBody = form.slice(catchStart, catchEnd);
    expect(catchBody).not.toContain("setCreated");
    expect(catchBody).toContain("setError(");
    expect(catchBody).not.toMatch(/\$\{.*(err|error|exception)/i);
  });

  it("tidak mengimpor/memanggil createSalesmanAction atau AddSalesmanForm (jalur lama)", () => {
    expect(form).not.toMatch(/createSalesmanAction|AddSalesmanForm|add-salesman-form/);
  });

  it("tidak ada field Wilayah Kerja pada form generik ini", () => {
    expect(form).not.toMatch(/Wilayah Kerja|areaIds|coverage[-_]?area/i);
  });
});
