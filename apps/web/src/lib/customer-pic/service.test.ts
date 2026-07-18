import { describe, it, expect } from "vitest";
import { normalizeIdPhone } from "./phone";
import { normalizeEmail, isValidEmailFormat } from "./email";
import { isValidPicRoles, findExactStoreDuplicate, findSimilarStoreDuplicate, findPicPhoneOnOtherStore } from "./service";
import type { DuplicateCandidateStore, DuplicateCandidatePic } from "./service";

describe("normalizeIdPhone", () => {
  it("081234567890 -> +6281234567890", () => {
    expect(normalizeIdPhone("081234567890")).toBe("+6281234567890");
  });
  it("6281234567890 -> +6281234567890", () => {
    expect(normalizeIdPhone("6281234567890")).toBe("+6281234567890");
  });
  it("+6281234567890 -> +6281234567890 (sudah normal)", () => {
    expect(normalizeIdPhone("+6281234567890")).toBe("+6281234567890");
  });
  it("dengan spasi/dash/kurung -> tetap ternormalisasi", () => {
    expect(normalizeIdPhone("0812-3456-7890")).toBe("+6281234567890");
    expect(normalizeIdPhone("(0812) 3456 7890")).toBe("+6281234567890");
  });
  it("null/undefined/kosong -> null", () => {
    expect(normalizeIdPhone(null)).toBeNull();
    expect(normalizeIdPhone(undefined)).toBeNull();
    expect(normalizeIdPhone("")).toBeNull();
    expect(normalizeIdPhone("   ")).toBeNull();
  });
  it("nomor tanpa prefix dikenal -> tetap diberi +62", () => {
    expect(normalizeIdPhone("81234567890")).toBe("+6281234567890");
  });
});

describe("normalizeEmail", () => {
  it("trim + lowercase", () => {
    expect(normalizeEmail("  Budi.Santoso@EXAMPLE.com  ")).toBe("budi.santoso@example.com");
  });
  it("null/undefined/kosong -> null", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });
  it("sudah lowercase tetap sama", () => {
    expect(normalizeEmail("budi@example.com")).toBe("budi@example.com");
  });
});

describe("isValidEmailFormat", () => {
  it("format valid diterima", () => {
    expect(isValidEmailFormat("budi@example.com")).toBe(true);
    expect(isValidEmailFormat("budi.santoso@example.co.id")).toBe(true);
  });
  it("tanpa @ ditolak", () => {
    expect(isValidEmailFormat("bukan-email")).toBe(false);
  });
  it("tanpa domain (titik) ditolak", () => {
    expect(isValidEmailFormat("budi@example")).toBe(false);
  });
  it("mengandung spasi ditolak", () => {
    expect(isValidEmailFormat("budi santoso@example.com")).toBe(false);
  });
});

describe("isValidPicRoles", () => {
  it("array kosong ditolak", () => {
    expect(isValidPicRoles([])).toBe(false);
  });
  it("null/undefined ditolak", () => {
    expect(isValidPicRoles(null)).toBe(false);
    expect(isValidPicRoles(undefined)).toBe(false);
  });
  it("role tidak dikenal ditolak", () => {
    expect(isValidPicRoles(["OWNER", "INVALID_ROLE"])).toBe(false);
  });
  it("satu role valid diterima", () => {
    expect(isValidPicRoles(["OWNER"])).toBe(true);
  });
  it("multiple role valid diterima", () => {
    expect(isValidPicRoles(["OWNER", "ORDERER", "RECEIVER"])).toBe(true);
  });
});

describe("findExactStoreDuplicate", () => {
  const existing: DuplicateCandidateStore[] = [
    { id: "s1", name: "Toko Sinar Jaya", phone: "081234567890", address: "Jl. Merdeka 1", area: "Jakarta Selatan", isActive: true },
  ];

  it("nomor toko sama SENDIRIAN (nama berbeda) -> BUKAN exact -- satu pemilik boleh punya beberapa cabang dengan nomor sama", () => {
    const found = findExactStoreDuplicate("Toko Baru Cabang Lain", "0812-3456-7890", "Alamat lain", existing);
    expect(found).toBeNull();
  });
  it("nama+alamat sama persis (case-insensitive) -> exact duplicate", () => {
    const found = findExactStoreDuplicate("toko sinar jaya", "089900001111", "jl. merdeka 1", existing);
    expect(found?.id).toBe("s1");
  });
  it("nama+nomor sama (kombinasi dua sinyal kuat, alamat beda) -> exact duplicate", () => {
    const found = findExactStoreDuplicate("Toko Sinar Jaya", "0812-3456-7890", "Alamat yang berbeda", existing);
    expect(found?.id).toBe("s1");
  });
  it("nama beda + alamat beda + nomor beda -> tidak duplicate", () => {
    const found = findExactStoreDuplicate("Toko Lain Sekali", "089911112222", "Jl. Lain", existing);
    expect(found).toBeNull();
  });
  it("toko yang sudah tidak aktif tidak dihitung", () => {
    const inactiveExisting: DuplicateCandidateStore[] = [{ ...existing[0]!, isActive: false }];
    const found = findExactStoreDuplicate("Toko Sinar Jaya", null, "Jl. Merdeka 1", inactiveExisting);
    expect(found).toBeNull();
  });
});

describe("findSimilarStoreDuplicate", () => {
  const existing: DuplicateCandidateStore[] = [
    { id: "s1", name: "Toko Sinar Jaya", phone: "081234567890", address: "Jl. Merdeka 1", area: "Jakarta Selatan", isActive: true },
  ];

  it("nomor toko sama, nama berbeda -> similar (warning, bukan block) -- sah untuk cabang berbeda", () => {
    const found = findSimilarStoreDuplicate("Toko Cabang Kedua", "0812-3456-7890", "Alamat cabang berbeda", "Jakarta Barat", existing);
    expect(found?.id).toBe("s1");
  });
  it("nama mirip (substring) di area yang sama -> similar", () => {
    const found = findSimilarStoreDuplicate("Toko Sinar Jaya 2", null, null, "Jakarta Selatan", existing);
    expect(found?.id).toBe("s1");
  });
  it("nama mirip tapi area berbeda -> tidak similar (by name)", () => {
    const found = findSimilarStoreDuplicate("Toko Sinar Jaya 2", null, null, "Jakarta Barat", existing);
    expect(found).toBeNull();
  });
  it("alamat sama persis, nama beda -> similar", () => {
    const found = findSimilarStoreDuplicate("Toko Yang Sama Sekali Beda", null, "Jl. Merdeka 1", "Jakarta Barat", existing);
    expect(found?.id).toBe("s1");
  });
  it("nama+alamat+nomor+area semua beda -> tidak similar", () => {
    const found = findSimilarStoreDuplicate("Warung Makmur", "089977778888", "Jl. Sudirman 99", "Bandung", existing);
    expect(found).toBeNull();
  });
});

describe("findPicPhoneOnOtherStore", () => {
  const existingPics: DuplicateCandidatePic[] = [
    { id: "p1", customerId: "s1", phone: "+6281234567890" },
    { id: "p2", customerId: "s2", phone: "+6289900001111" },
  ];

  it("nomor PIC sama pada toko lain -> terdeteksi (bukan fraud, murni informational)", () => {
    const found = findPicPhoneOnOtherStore("+6281234567890", "s2", existingPics);
    expect(found?.customerId).toBe("s1");
  });
  it("nomor PIC sama pada toko yang SAMA -> tidak terdeteksi (bukan lintas toko)", () => {
    const found = findPicPhoneOnOtherStore("+6281234567890", "s1", existingPics);
    expect(found).toBeNull();
  });
  it("nomor tidak ditemukan di toko manapun -> null", () => {
    const found = findPicPhoneOnOtherStore("+6281111111111", "s3", existingPics);
    expect(found).toBeNull();
  });
});
