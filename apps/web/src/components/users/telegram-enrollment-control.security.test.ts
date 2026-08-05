import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Gate 3E-D2-C1-R3-U1: tautan pairing Telegram siap klik. Repo ini tidak
// punya jsdom/@testing-library/react (vitest environment = "node"), jadi
// verifikasi mengikuti pola source-content assertion yang sudah dipakai di
// lib/telegram-enrollment/security.test.ts, bukan render test.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const component = readFileSync(
  path.resolve(__dirname, "telegram-enrollment-control.tsx"),
  "utf8",
);
const usersPage = readFileSync(
  path.resolve(__dirname, "../../app/(dashboard)/dashboard/users/page.tsx"),
  "utf8",
);

describe("TelegramEnrollmentControl pairing link UI", () => {
  it("tombol Salin menyalin deepLink (URL lengkap), bukan command/token mentah", () => {
    expect(component).toContain("navigator.clipboard.writeText(deepLink)");
    expect(component).not.toMatch(/clipboard\.writeText\(command\)/);
    expect(component).toContain("Salin Tautan Pairing");
  });

  it("tombol Buka Telegram memakai deepLink yang sama dengan yang disalin", () => {
    const anchorStart = component.indexOf("<a\n              href={deepLink}");
    expect(anchorStart).toBeGreaterThan(-1);
    const anchorBlock = component.slice(anchorStart, anchorStart + 350);
    expect(anchorBlock).toContain('target="_blank"');
    expect(anchorBlock).toContain("Buka Telegram");
  });

  it("tidak pernah merender command/raw token sebagai instruksi manual", () => {
    expect(component).not.toMatch(/\bcommand\b/);
    expect(component).not.toContain("setCommand");
  });

  it("username kosong/tidak valid (deepLink null) gagal tertutup dengan pesan error konfigurasi, bukan fallback token mentah", () => {
    expect(component).toContain("if (!result.enrollment.deepLink)");
    const guardStart = component.indexOf("if (!result.enrollment.deepLink)");
    const guardBlock = component.slice(guardStart, guardStart + 300);
    expect(guardBlock).toContain("setConfigError(true)");
    expect(guardBlock).toContain("setDeepLink(null)");

    expect(component).toContain("configError &&");
    expect(component).toContain("Konfigurasi bot Telegram belum lengkap");

    // Tombol Buka Telegram / Salin Tautan Pairing hanya dirender saat
    // deepLink truthy -- fail closed, tidak ada URL rusak yang bisa diklik.
    const linkBlockStart = component.indexOf("{deepLink && (");
    expect(linkBlockStart).toBeGreaterThan(-1);
  });

  it("menampilkan identitas dan role user tujuan agar Owner tidak salah kirim", () => {
    expect(component).toContain("targetName");
    expect(component).toContain("targetRoleLabel");
    expect(component).toContain("Untuk {targetName} · {targetRoleLabel}");
  });

  it("menampilkan peringatan sekali pakai dan hanya untuk penerima yang dituju", () => {
    expect(component).toContain("Tautan sekali pakai");
    expect(component).toContain("kirim hanya kepada {targetName}");
  });

  it("menampilkan masa berlaku (expiresAt) saat tautan diterbitkan", () => {
    expect(component).toContain("expiresAt &&");
    expect(component).toContain("Kedaluwarsa");
  });

  it("halaman Users meneruskan nama dan role tujuan ke komponen pairing", () => {
    expect(usersPage).toContain("targetName={displayName}");
    expect(usersPage).toContain("targetRoleLabel={");
  });
});
