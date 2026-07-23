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
