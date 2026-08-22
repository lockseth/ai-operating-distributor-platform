import { describe, expect, it } from "vitest";
import { normalizeIndonesianPhone } from "./bablast";

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
