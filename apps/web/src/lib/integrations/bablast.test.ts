import { afterEach, describe, expect, it, vi } from "vitest";
import { initiateBablastPairing, normalizeIndonesianPhone } from "./bablast";

describe("normalizeIndonesianPhone", () => {
  it("nomor diawali 0 -> diganti jadi 62", () => {
    expect(normalizeIndonesianPhone("087778404085")).toBe("6287778404085");
  });

  it("nomor sudah diawali 62 -> dipertahankan", () => {
    expect(normalizeIndonesianPhone("6287778404085")).toBe("6287778404085");
  });

  it("nomor dengan +62 -> tanda + dibuang", () => {
    expect(normalizeIndonesianPhone("+6287778404085")).toBe("6287778404085");
  });

  it("nomor dengan spasi/dash/kurung -> dibersihkan dulu", () => {
    expect(normalizeIndonesianPhone("0877-7840-4085")).toBe("6287778404085");
    expect(normalizeIndonesianPhone("(0877) 7840 4085")).toBe("6287778404085");
  });

  it("nomor tanpa 0/62 depan -> tetap diawali 62", () => {
    expect(normalizeIndonesianPhone("87778404085")).toBe("6287778404085");
  });

  it("terlalu pendek -> null (bukan nomor valid)", () => {
    expect(normalizeIndonesianPhone("12345")).toBeNull();
  });

  it("string kosong -> null", () => {
    expect(normalizeIndonesianPhone("")).toBeNull();
    expect(normalizeIndonesianPhone("abc")).toBeNull();
  });

  it("terlalu panjang -> null", () => {
    expect(normalizeIndonesianPhone("0877784040851234567890")).toBeNull();
  });
});

describe("initiateBablastPairing -- parsing kontrak nyata /connector/pairing", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.BABLAST_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.BABLAST_API_KEY = originalApiKey;
  });

  function mockFetchOnce(body: unknown) {
    process.env.BABLAST_API_KEY = "test-key";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }) as unknown as typeof fetch;
  }

  it("data adalah STRING mentah (QR-mode nyata) -> masuk sebagai qrCode, bukan hilang jadi null", async () => {
    mockFetchOnce({
      success: true,
      message: "QR Code generated successfully",
      data: "https://wa.me/settings/linked_devices#2@abc123",
    });

    const result = await initiateBablastPairing();
    expect(result.qrCode).toBe("https://wa.me/settings/linked_devices#2@abc123");
    expect(result.pairingCode).toBeNull();
    expect(result.alreadyConnected).toBe(false);
  });

  it("data kosong object + pesan 'sudah terpairing' -> alreadyConnected true", async () => {
    mockFetchOnce({ success: true, message: "sender sudah terpairing", data: {} });

    const result = await initiateBablastPairing();
    expect(result.alreadyConnected).toBe(true);
    expect(result.qrCode).toBeNull();
  });
});
