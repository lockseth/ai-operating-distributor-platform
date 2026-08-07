import { describe, it, expect } from "vitest";
import { NAV_SECTIONS } from "./sidebar";

describe("Gate 3E-D5-B -- sidebar menu Kunjungan Sales", () => {
  const item = NAV_SECTIONS.flatMap((s) => s.items).find(
    (i) => i.href === "/dashboard/sales-visits",
  );

  it("menu Kunjungan Sales terdaftar", () => {
    expect(item).toBeTruthy();
    expect(item?.label).toBe("Kunjungan Sales");
  });

  it("hanya role sales yang bisa melihat -- tidak ada permission fallback", () => {
    expect(item?.roles).toEqual(["sales"]);
    expect(item?.permission).toBeUndefined();
  });

  it("tidak ditempatkan di menu Laporan Sales -- href berbeda dan tidak overlap", () => {
    const reportsItem = NAV_SECTIONS.flatMap((s) => s.items).find(
      (i) => i.label === "Laporan Sales",
    );
    expect(reportsItem?.href).not.toBe(item?.href);
  });
});
