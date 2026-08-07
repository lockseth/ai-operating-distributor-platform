// =============================================================================
// Test — normalize.ts, fokus containsAllWords (Gate 3E-D4-C7 Temuan #4:
// field-language parsing). Deterministic word-containment, BUKAN fuzzy/
// similarity-score/typo-tolerant matching.
// =============================================================================

import { describe, it, expect } from "vitest";
import { containsAllWords } from "./normalize";

describe("containsAllWords — word-containment deterministic, bukan fuzzy", () => {
  it("teks lebih PENDEK dari master (singkatan) -> match ('Warna Jaya' vs 'Toko Warna Jaya Bangunan')", () => {
    expect(containsAllWords("Warna Jaya", "Toko Warna Jaya Bangunan")).toBe(true);
  });

  it("teks lebih PANJANG dari master (tambahan konteks) -> match ('Toko Baru, repeat order' vs 'Toko Baru')", () => {
    expect(containsAllWords("Toko Baru, repeat order", "Toko Baru")).toBe(true);
  });

  it("kata TIDAK berurutan/berdekatan tetap match (bukan substring literal) -- 'cat exterior' vs 'Cat Tembok Exterior 20 Kg'", () => {
    expect(containsAllWords("cat exterior", "Cat Tembok Exterior 20 Kg")).toBe(true);
  });

  it("tidak ada kata yang overlap sama sekali -> tidak match", () => {
    expect(containsAllWords("Toko Sentosa", "Warung Makan Sederhana")).toBe(false);
  });

  it("overlap SEBAGIAN (bukan seluruh kata salah satu sisi) -> tidak match, TIDAK boleh menebak", () => {
    // "Toko Warna" vs "Toko Jaya Abadi" -- sama-sama punya "toko" tapi
    // "warna" tidak ada di kanan, "jaya"/"abadi" tidak ada di kiri -- bukan
    // subset di kedua arah, jangan menganggap ini kecocokan.
    expect(containsAllWords("Toko Warna", "Toko Jaya Abadi")).toBe(false);
  });

  it("case-insensitive dan tanda baca penempel diabaikan (bukan pelonggaran ejaan per-huruf)", () => {
    expect(containsAllWords("WARNA JAYA", "toko, warna jaya! bangunan")).toBe(true);
  });

  it("string kosong tidak pernah match apa pun", () => {
    expect(containsAllWords("", "Toko Warna Jaya Bangunan")).toBe(false);
    expect(containsAllWords("Warna Jaya", "")).toBe(false);
  });

  it("identik persis -> match (kasus trivial, tetap dites eksplisit)", () => {
    expect(containsAllWords("Toko Warna Jaya", "Toko Warna Jaya")).toBe(true);
  });
});
