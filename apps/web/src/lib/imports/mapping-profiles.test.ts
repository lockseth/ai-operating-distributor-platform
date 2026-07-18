import { describe, it, expect } from "vitest";
import { InMemoryMappingProfileStore } from "./mapping-profiles";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";

describe("Saved import mapping profile -- tenant isolation & versioning (addendum)", () => {
  it("profil tenant A tidak pernah terlihat oleh tenant B walau domain+sourceSystem+nama persis sama", async () => {
    const store = new InMemoryMappingProfileStore();
    await store.saveProfile({
      companyId: COMPANY_A, domain: "CUSTOMER_PIC", sourceSystem: "Excel Toko Pak Waluyo",
      profileName: "Mapping v1", columnMappings: [{ sourceColumn: "Nama Outlet", targetField: "store_name" }],
      templateVersion: "1.0.0", createdBy: "owner-a",
    });
    await store.saveProfile({
      companyId: COMPANY_B, domain: "CUSTOMER_PIC", sourceSystem: "Excel Toko Pak Waluyo",
      profileName: "Mapping v1", columnMappings: [{ sourceColumn: "Store Name", targetField: "store_name" }],
      templateVersion: "1.0.0", createdBy: "owner-b",
    });

    const listA = await store.listProfiles(COMPANY_A, "CUSTOMER_PIC");
    const listB = await store.listProfiles(COMPANY_B, "CUSTOMER_PIC");
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
    expect(listA[0]!.id).not.toBe(listB[0]!.id);
    expect(listA[0]!.columnMappings[0]!.sourceColumn).toBe("Nama Outlet");
    expect(listB[0]!.columnMappings[0]!.sourceColumn).toBe("Store Name");

    // Tenant B tidak bisa mengakses profil tenant A lewat getProfile meski tahu id-nya.
    const leaked = await store.getProfile(COMPANY_B, listA[0]!.id);
    expect(leaked).toBeNull();
  });

  it("menyimpan ulang profil dengan nama+domain+sourceSystem sama menaikkan version, bukan membuat baris baru", async () => {
    const store = new InMemoryMappingProfileStore();
    const v1 = await store.saveProfile({
      companyId: COMPANY_A, domain: "PRODUCT_PRICE", sourceSystem: "Accurate",
      profileName: "Export Customer Accurate v1", columnMappings: [{ sourceColumn: "SKU", targetField: "sku" }],
      templateVersion: "1.0.0", createdBy: "owner-a",
    });
    expect(v1.version).toBe(1);

    const v2 = await store.saveProfile({
      companyId: COMPANY_A, domain: "PRODUCT_PRICE", sourceSystem: "Accurate",
      profileName: "Export Customer Accurate v1", columnMappings: [{ sourceColumn: "Kode SKU", targetField: "sku" }],
      templateVersion: "1.0.0", createdBy: "owner-a",
    });
    expect(v2.version).toBe(2);
    expect(v2.id).toBe(v1.id); // baris yang sama, hanya version + mapping yang berubah.

    const list = await store.listProfiles(COMPANY_A, "PRODUCT_PRICE");
    expect(list).toHaveLength(1);
    expect(list[0]!.columnMappings[0]!.sourceColumn).toBe("Kode SKU");
  });

  it("profil di-scope per domain -- import type berbeda tidak saling terlihat walau sourceSystem+nama sama", async () => {
    const store = new InMemoryMappingProfileStore();
    await store.saveProfile({
      companyId: COMPANY_A, domain: "CUSTOMER_PIC", sourceSystem: "Excel Manual",
      profileName: "Default", columnMappings: [], templateVersion: "1.0.0", createdBy: "owner-a",
    });
    const productProfiles = await store.listProfiles(COMPANY_A, "PRODUCT_PRICE");
    expect(productProfiles).toHaveLength(0);
  });
});
