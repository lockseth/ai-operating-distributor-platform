import { describe, it, expect } from "vitest";
import { autoAllocateFifo, sortInvoicesByAge, type AllocatableInvoice } from "./allocation";

function invoice(id: string, outstandingBalance: number, dueDate: string | null): AllocatableInvoice {
  return { id, outstandingBalance, dueDate };
}

describe("sortInvoicesByAge", () => {
  it("urut dari due_date paling awal (tertua) ke paling baru", () => {
    const result = sortInvoicesByAge([
      invoice("new", 100, "2026-08-01"),
      invoice("old", 100, "2026-06-01"),
      invoice("mid", 100, "2026-07-01"),
    ]);
    expect(result.map((i) => i.id)).toEqual(["old", "mid", "new"]);
  });

  it("invoice tanpa due_date diletakkan paling terakhir", () => {
    const result = sortInvoicesByAge([
      invoice("no-date", 100, null),
      invoice("old", 100, "2026-06-01"),
    ]);
    expect(result.map((i) => i.id)).toEqual(["old", "no-date"]);
  });

  it("tidak mengubah array asli (immutable)", () => {
    const original = [invoice("a", 100, "2026-08-01"), invoice("b", 100, "2026-06-01")];
    const originalOrder = original.map((i) => i.id);
    sortInvoicesByAge(original);
    expect(original.map((i) => i.id)).toEqual(originalOrder);
  });
});

describe("autoAllocateFifo", () => {
  it("amount <= 0 -> map kosong, tidak crash", () => {
    expect(autoAllocateFifo(0, [invoice("a", 100, "2026-06-01")])).toEqual({});
    expect(autoAllocateFifo(-500, [invoice("a", 100, "2026-06-01")])).toEqual({});
  });

  it("array invoice kosong -> map kosong", () => {
    expect(autoAllocateFifo(500_000, [])).toEqual({});
  });

  it("1 invoice, amount pas -> alokasi penuh", () => {
    const result = autoAllocateFifo(500_000, [invoice("inv1", 500_000, "2026-06-01")]);
    expect(result).toEqual({ inv1: 500_000 });
  });

  it("1 invoice, amount lebih besar dari outstanding -> alokasi dibatasi outstanding, sisa tidak dialokasikan ke mana pun", () => {
    const result = autoAllocateFifo(800_000, [invoice("inv1", 500_000, "2026-06-01")]);
    expect(result).toEqual({ inv1: 500_000 });
  });

  it("2 invoice, amount cukup utk keduanya -> invoice tertua diisi penuh dulu baru sisanya ke yang lebih baru", () => {
    const result = autoAllocateFifo(
      800_000,
      [invoice("baru", 300_000, "2026-08-01"), invoice("lama", 500_000, "2026-06-01")],
    );
    expect(result).toEqual({ lama: 500_000, baru: 300_000 });
  });

  it("2 invoice, amount cuma cukup utk invoice tertua -> invoice lebih baru tidak dapat alokasi sama sekali", () => {
    const result = autoAllocateFifo(
      300_000,
      [invoice("baru", 300_000, "2026-08-01"), invoice("lama", 500_000, "2026-06-01")],
    );
    expect(result).toEqual({ lama: 300_000 });
    expect(result.baru).toBeUndefined();
  });

  it("3 invoice campur due_date null -> invoice tanpa due_date diisi paling akhir", () => {
    const result = autoAllocateFifo(
      1_000_000,
      [
        invoice("tanpa-tanggal", 400_000, null),
        invoice("lama", 300_000, "2026-06-01"),
        invoice("tengah", 300_000, "2026-07-01"),
      ],
    );
    expect(result).toEqual({ lama: 300_000, tengah: 300_000, "tanpa-tanggal": 400_000 });
  });

  it("invoice dengan outstandingBalance 0 dilewati (tidak masuk hasil)", () => {
    const result = autoAllocateFifo(
      500_000,
      [invoice("lunas", 0, "2026-06-01"), invoice("outstanding", 500_000, "2026-07-01")],
    );
    expect(result).toEqual({ outstanding: 500_000 });
    expect(result.lunas).toBeUndefined();
  });
});
