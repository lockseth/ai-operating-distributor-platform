import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, "login-form.tsx"), "utf8");

describe("Login form demo UI contract (Gate 3C)", () => {
  it("tidak menampilkan Google Sign-In (signInWithOAuth) sama sekali", () => {
    expect(source).not.toContain("signInWithOAuth");
    expect(source).not.toContain("Masuk dengan Google");
    expect(source).not.toContain("handleGoogleSignIn");
  });

  it("tidak menampilkan/hardcode password demo di source", () => {
    expect(source.toLowerCase()).not.toMatch(/password\s*[:=]\s*["'][^"']+["']/);
  });

  it("tombol submit login di-disable saat loading (mencegah submit ganda)", () => {
    const start = source.indexOf('type="submit"');
    expect(start).toBeGreaterThan(-1);
    const following = source.slice(start, start + 100);
    expect(following).toContain("disabled={loading}");
  });

  it("pesan error login generik -- tidak membocorkan apakah email terdaftar", () => {
    expect(source).toContain("Email atau password tidak valid");
    expect(source.toLowerCase()).not.toMatch(/email (ini |)(tidak terdaftar|belum terdaftar|not found)/);
  });

  it("demo bypass (jika ada) tetap digate NODE_ENV development, bukan environment demo/staging baru", () => {
    if (source.includes("enterDemoModeAction")) {
      expect(source).toContain('process.env.NODE_ENV === "development"');
    }
  });
});
