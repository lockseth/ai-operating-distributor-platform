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

describe("Sidebar — Finance Operations (Gate 2I.1, FIN-01)", () => {
  it("FIN-01-01/02/03: item 'Finance Operations' ada, mengarah /dashboard/finance, gate permission receivable.view (owner/manager/admin/super_admin/finance otomatis lolos)", () => {
    const item = allItems().find((i) => i.label === "Finance Operations");
    expect(item).toBeDefined();
    expect(item?.href).toBe("/dashboard/finance");
    expect(item?.permission).toBe("receivable.view");
  });

  it("FIN-01-04: tidak memakai roles override yang bisa memberi akses ke sales/warehouse/driver tanpa permission receivable.view", () => {
    const item = allItems().find((i) => i.label === "Finance Operations");
    // roles harus undefined -- visibility HANYA lewat permission (migration
    // Gate 2A hanya grant receivable.view ke owner/manager/admin/super_admin/
    // finance, sales/warehouse/driver tidak pernah mendapatkannya).
    expect(item?.roles).toBeUndefined();
  });

  it("tidak menghapus/mengubah item 'Collection' existing yang sudah ada sebelum Finance Operations", () => {
    const collection = allItems().find((i) => i.label === "Collection");
    expect(collection?.href).toBe("/dashboard/collection");
    expect(collection?.roles).toEqual(["super_admin", "owner", "manager", "admin", "finance"]);
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

describe("Sidebar — Activity & Audit Log (Gate 1D-A)", () => {
  it("menu 'Activity & Audit Log' ada di section Sistem, tepat sebelum 'Automation'", () => {
    const sistemSection = NAV_SECTIONS.find((s) => s.title === "Sistem");
    expect(sistemSection).toBeDefined();
    const labels = sistemSection!.items.map((i) => i.label);
    const activityIdx = labels.indexOf("Activity & Audit Log");
    const automationIdx = labels.indexOf("Automation");
    expect(activityIdx).toBeGreaterThan(-1);
    expect(automationIdx).toBeGreaterThan(-1);
    expect(activityIdx).toBe(automationIdx - 1);
  });

  it("hanya role owner yang bisa melihat menu ini -- bukan manager/admin/super_admin", () => {
    const item = allItems().find((i) => i.label === "Activity & Audit Log");
    expect(item?.roles).toEqual(["owner"]);
    expect(item?.permission).toBeUndefined();
  });

  it("href menunjuk ke halaman owner-only /dashboard/owner/activity-log", () => {
    const item = allItems().find((i) => i.label === "Activity & Audit Log");
    expect(item?.href).toBe("/dashboard/owner/activity-log");
  });

  it("tidak mengubah item 'Automation' atau 'Automation Outbox (n8n)' existing", () => {
    const automation = allItems().find((i) => i.label === "Automation");
    const outbox = allItems().find((i) => i.label === "Automation Outbox (n8n)");
    expect(automation?.href).toBe("/dashboard/automation");
    expect(automation?.permission).toBe("settings.view");
    expect(outbox?.href).toBe("/dashboard/automation/outbox");
    expect(outbox?.roles).toEqual(["owner", "manager", "super_admin"]);
  });
});
