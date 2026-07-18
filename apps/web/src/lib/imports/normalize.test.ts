import { describe, it, expect } from "vitest";
import { normalizeIdDate, normalizeIdCurrency, normalizeSku, normalizeBoolean } from "./normalize";
import { normalizeIdPhone } from "@/lib/customer-pic/phone";
import { normalizeEmail } from "@/lib/customer-pic/email";

describe("6. Normalisasi Indonesia -- telepon/tanggal/nominal", () => {
  it("nomor telepon (reuse customer-pic/phone.ts)", () => {
    expect(normalizeIdPhone("081234567890")).toBe("+6281234567890");
    expect(normalizeIdPhone("62812-3456-7890")).toBe("+6281234567890");
  });

  it("email (reuse customer-pic/email.ts)", () => {
    expect(normalizeEmail(" Budi@EXAMPLE.com ")).toBe("budi@example.com");
  });

  it("tanggal DD/MM/YYYY -> ISO", () => {
    expect(normalizeIdDate("01/07/2026")).toBe("2026-07-01");
    expect(normalizeIdDate("31-12-2025")).toBe("2025-12-31");
  });
  it("tanggal ISO tetap diterima", () => {
    expect(normalizeIdDate("2026-07-01")).toBe("2026-07-01");
  });
  it("tanggal tidak valid -> null (bukan ditebak)", () => {
    expect(normalizeIdDate("32/13/2026")).toBeNull();
    expect(normalizeIdDate("bukan tanggal")).toBeNull();
    expect(normalizeIdDate("")).toBeNull();
  });

  it("nominal dengan Rp + titik ribuan", () => {
    expect(normalizeIdCurrency("Rp 1.500.000")).toBe(1500000);
  });
  it("nominal dengan koma desimal", () => {
    expect(normalizeIdCurrency("1.500.000,50")).toBe(1500000.5);
  });
  it("nominal polos", () => {
    expect(normalizeIdCurrency("450000")).toBe(450000);
  });
  it("nominal tidak valid -> null", () => {
    expect(normalizeIdCurrency("bukan angka")).toBeNull();
    expect(normalizeIdCurrency("")).toBeNull();
  });

  it("normalizeSku trim + uppercase", () => {
    expect(normalizeSku(" sbn-cair 500ml ")).toBe("SBN-CAIR-500ML");
  });

  it("normalizeBoolean mengenali variasi ya/tidak Indonesia", () => {
    expect(normalizeBoolean("aktif")).toBe(true);
    expect(normalizeBoolean("nonaktif")).toBe(false);
    expect(normalizeBoolean("TRUE")).toBe(true);
    expect(normalizeBoolean("0")).toBe(false);
    expect(normalizeBoolean("", true)).toBe(true);
  });
});
