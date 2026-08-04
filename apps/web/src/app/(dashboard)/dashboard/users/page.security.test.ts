import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = readFileSync(path.resolve(__dirname, "page.tsx"), "utf8");

describe("Users page Telegram pairing control gating (Gate 1C)", () => {
  it("kontrol pairing/reset Telegram Salesman hanya dirender untuk Owner (isOwner), bukan canManageTelegram", () => {
    const start = page.indexOf("<TelegramEnrollmentControl");
    expect(start).toBeGreaterThan(-1);
    const precedingCondition = page.slice(Math.max(0, start - 200), start);
    expect(precedingCondition).toContain("isOwner");
    expect(precedingCondition).not.toContain("canManageTelegram &&");
  });

  it("Gate 1C corrective: query identity/pending-token Telegram digate ke isOwner, bukan canManageTelegram -- manager/admin/super_admin tidak menerima data ini lewat RSC props sama sekali", () => {
    for (const marker of [
      'const { data: telegramData } = isOwner',
      'const { data: previousIdentityData } = isOwner',
      'const { data: pendingTokenData } = isOwner',
    ]) {
      expect(page).toContain(marker);
    }
    for (const marker of [
      'const { data: telegramData } = canManageTelegram',
      'const { data: previousIdentityData } = canManageTelegram',
      'const { data: pendingTokenData } = canManageTelegram',
    ]) {
      expect(page).not.toContain(marker);
    }
  });

  it("Gate 1C corrective: query coverage (Gate 1A/1B, bukan Telegram) tetap tidak berubah -- masih digate canManageTelegram, bukan digeser ke isOwner tanpa perlu", () => {
    expect(page).toContain('const { data: coverageData } = canManageTelegram');
  });
});

describe("Users page Tambah Salesman link gating (Gate 3C)", () => {
  it("tombol/link Tambah Salesman hanya dirender untuk isOwner, bukan canManageTelegram -- halaman tujuannya (/dashboard/users/new) owner-only", () => {
    const start = page.indexOf('href="/dashboard/users/new"');
    expect(start).toBeGreaterThan(-1);
    const precedingCondition = page.slice(Math.max(0, start - 200), start);
    expect(precedingCondition).toContain("isOwner ?");
    expect(precedingCondition).not.toContain("canManageTelegram ?");
  });
});

describe("Users page Tambah Pengguna CTA (Gate 3E-C-C2-B3)", () => {
  it('tombol CTA berlabel "Tambah Pengguna", jalur lama "Tambah Salesman" tidak lagi ada di halaman ini', () => {
    const start = page.indexOf('href="/dashboard/users/new"');
    const end = page.indexOf("</Link>", start);
    const linkBlock = page.slice(start, end);
    expect(linkBlock).toContain("Tambah Pengguna");
    expect(page).not.toContain("Tambah Salesman");
  });
});
