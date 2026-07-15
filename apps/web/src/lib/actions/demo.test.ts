// =============================================================================
// Test — enterDemoModeAction() harus menolak (throw), tidak pernah men-set
// cookie bypass, saat dipanggil di luar NODE_ENV=development. Ini adalah
// server action yang sesungguhnya dipanggil dari tombol "Masuk Demo" di UI
// login — jalur ini yang harus fail closed di production, bukan cuma
// tombolnya disembunyikan.
// =============================================================================

import { describe, it, expect, afterEach, vi } from "vitest";

const setMock = vi.fn();
const deleteMock = vi.fn();
const redirectMock = vi.fn();

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    set: setMock,
    delete: deleteMock,
    get: vi.fn(),
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("enterDemoModeAction — production fail-closed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setMock.mockClear();
    redirectMock.mockClear();
    vi.resetModules();
  });

  it("throw dan TIDAK men-set cookie bypass saat NODE_ENV='production'", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { enterDemoModeAction } = await import("./demo");

    await expect(enterDemoModeAction()).rejects.toThrow(
      "Demo mode hanya tersedia di lingkungan development."
    );
    expect(setMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("throw dan TIDAK men-set cookie bypass saat NODE_ENV salah konfigurasi", async () => {
    vi.stubEnv("NODE_ENV", "Production"); // typo kapitalisasi yang mungkin masuk config salah
    const { enterDemoModeAction } = await import("./demo");

    await expect(enterDemoModeAction()).rejects.toThrow();
    expect(setMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("berhasil men-set cookie & redirect HANYA saat NODE_ENV='development'", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { enterDemoModeAction } = await import("./demo");

    await enterDemoModeAction();

    expect(setMock).toHaveBeenCalledWith(
      "aodp_demo_mode",
      "1",
      expect.objectContaining({ httpOnly: true })
    );
    expect(redirectMock).toHaveBeenCalledWith("/dashboard/owner");
  });
});
