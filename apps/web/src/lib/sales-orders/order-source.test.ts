import { describe, it, expect } from "vitest";
import { detectOrderSource } from "./order-source";

describe("detectOrderSource", () => {
  it("REPEAT_ORDER untuk kata kunci repeat/ulang/langganan", () => {
    expect(detectOrderSource("Order Toko Sinar Jaya, repeat order minggu lalu")).toBe("REPEAT_ORDER");
    expect(detectOrderSource("order ulang seperti biasa")).toBe("REPEAT_ORDER");
  });

  it("CUSTOMER_WHATSAPP untuk kata kunci wa/whatsapp", () => {
    expect(detectOrderSource("Order dari WA toko Melati")).toBe("CUSTOMER_WHATSAPP");
    expect(detectOrderSource("dipesan lewat whatsapp")).toBe("CUSTOMER_WHATSAPP");
  });

  it("CUSTOMER_PHONE untuk kata kunci telepon/telp/call", () => {
    expect(detectOrderSource("Toko telepon minta tambah stok")).toBe("CUSTOMER_PHONE");
    expect(detectOrderSource("ditelpon owner toko pagi ini")).toBe("CUSTOMER_PHONE");
  });

  it("FIELD_VISIT untuk kata kunci kunjungan/visit", () => {
    expect(detectOrderSource("Kunjungan ke Toko Abadi, order langsung")).toBe("FIELD_VISIT");
  });

  it("OTHER sebagai default ketika tidak ada penanda", () => {
    expect(detectOrderSource("Toko Sinar Jaya:\nCat Mawar Putih 20 dus harga 450 ribu")).toBe("OTHER");
  });

  it("tidak pernah throw untuk input kosong/aneh", () => {
    expect(() => detectOrderSource("")).not.toThrow();
    expect(detectOrderSource("")).toBe("OTHER");
  });

  it("REPEAT_ORDER diprioritaskan bila beberapa kata kunci muncul bersamaan", () => {
    // repeat order yang disampaikan lewat WA -- REPEAT_ORDER lebih spesifik secara bisnis
    expect(detectOrderSource("repeat order dari WA toko")).toBe("REPEAT_ORDER");
  });
});
