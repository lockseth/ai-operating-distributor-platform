import { describe, it, expect } from "vitest";
import { NAV_SECTIONS, type NavItem } from "./sidebar";

function allItems(): NavItem[] {
  return NAV_SECTIONS.flatMap((s) => s.items);
}

function isImportRelated(item: NavItem): boolean {
  return item.href.includes("/dashboard/imports") || item.href.includes("/dashboard/settings/import");
}

describe("Sidebar — single canonical Import Data menu", () => {
  it("1. hanya ada SATU navigation item terkait import", () => {
    const importItems = allItems().filter(isImportRelated);
    expect(importItems.length).toBe(1);
  });

  it("2/3. item tunggal berlabel 'Import Data' dan href /dashboard/imports", () => {
    const [item] = allItems().filter(isImportRelated);
    expect(item?.label).toBe("Import Data");
    expect(item?.href).toBe("/dashboard/imports");
  });

  it("4. tidak ada label 'Import Data Lama' di mana pun pada sidebar", () => {
    expect(allItems().some((i) => i.label === "Import Data Lama")).toBe(false);
  });

  it("5. tidak ada href legacy (/dashboard/settings/import) pada sidebar", () => {
    expect(allItems().some((i) => i.href === "/dashboard/settings/import")).toBe(false);
  });

  it("6/7. gate permission imports.view -- owner/admin/manager/super_admin bisa lihat, sales tidak", () => {
    const [item] = allItems().filter(isImportRelated);
    expect(item?.permission).toBe("imports.view");
    // Menu Import Data TIDAK memiliki roles override yang bisa memberi akses ke sales
    // tanpa permission imports.view (imports.view hanya diberikan ke owner/manager/admin/super_admin
    // per migration 20260801000001 -- sales tidak pernah mendapatkannya).
    expect(item?.roles).toBeUndefined();
  });
});

describe("Active-state prefix logic tidak ambigu", () => {
  it("10. /dashboard/imports, /dashboard/imports/new, /dashboard/imports/[id] semua match prefix item", () => {
    const [item] = allItems().filter(isImportRelated);
    const href = item!.href;
    expect("/dashboard/imports".startsWith(href)).toBe(true);
    expect("/dashboard/imports/new".startsWith(href)).toBe(true);
    expect(`/dashboard/imports/${"batch-123"}`.startsWith(href)).toBe(true);
  });

  it("route legacy tidak lagi match item manapun di sidebar (sudah dihapus)", () => {
    const legacyPath = "/dashboard/settings/import/new";
    const matches = allItems().filter((i) => legacyPath.startsWith(i.href));
    // Boleh match "Pengaturan" (/dashboard/settings) sebagai prefix umum, tapi TIDAK boleh
    // ada item import yang match.
    expect(matches.some(isImportRelated)).toBe(false);
  });
});
