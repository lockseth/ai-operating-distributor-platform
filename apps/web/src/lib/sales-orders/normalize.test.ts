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

  // ---------------------------------------------------------------------
  // Remediation UAT SO-2608-0002 -- bukti langsung dari raw_payload hosted:
  // "Kirim ke Warna Jaya\ncat exterior 20 kilo 10 ember" gagal dipetakan ke
  // master "DEMO-Toko Warna Jaya Bangunan" / "DEMO-Cat Tembok Eksterior
  // 20kg" karena tiga bug tokenisasi generik (bukan spesifik data ini).
  // ---------------------------------------------------------------------

  it("prefix menempel via tanda hubung (mis. 'DEMO-Cat') -> kata pertama tetap terdeteksi terpisah, generik untuk PREFIX APA PUN bukan cuma 'DEMO-'", () => {
    expect(containsAllWords("cat exterior", "DEMO-Cat Tembok Eksterior 20kg")).toBe(true);
    // Bukti generik: prefix lain (bukan "demo") juga terpisah, bukan hardcode literal "demo".
    expect(containsAllWords("cat exterior", "STOK-Cat Tembok Eksterior 20kg")).toBe(true);
  });

  it("angka menempel dengan satuan (mis. '20kg') -> tetap terpisah jadi kata angka + kata satuan", () => {
    expect(containsAllWords("cat 20 kg", "Cat Tembok 20kg")).toBe(true);
  });

  it("ejaan Inggris umum vs ejaan Indonesia baku (exterior/eksterior, x<->ks) -> dianggap kata yang sama, deterministic (bukan fuzzy)", () => {
    expect(containsAllWords("exterior", "Eksterior")).toBe(true);
    expect(containsAllWords("index", "Indeks")).toBe(true);
  });

  it("sinonim satuan generik (kilo->kg) ikut dinormalisasi saat pencocokan kata, bukan hanya saat menentukan field unit final", () => {
    expect(containsAllWords("20 kilo", "20kg")).toBe(true);
  });

  it("kombinasi PENUH bug nyata UAT: 'cat exterior 20 kilo' (teks Sales) vs 'DEMO-Cat Tembok Eksterior 20kg' (master) -> match", () => {
    expect(containsAllWords("cat exterior 20 kilo", "DEMO-Cat Tembok Eksterior 20kg")).toBe(true);
  });

  it("perbaikan tokenisasi TIDAK melonggarkan uniqueness -- overlap sebagian pada nama berprefix tetap tidak match", () => {
    // "cat interior" tidak boleh cocok dengan "DEMO-Cat Tembok Eksterior
    // 20kg" (produk BERBEDA) hanya karena sama-sama diawali "DEMO-Cat".
    expect(containsAllWords("cat interior", "DEMO-Cat Tembok Eksterior 20kg")).toBe(false);
  });
});
