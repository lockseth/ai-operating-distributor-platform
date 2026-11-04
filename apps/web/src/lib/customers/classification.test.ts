import { describe, expect, it } from "vitest";
import { resolveOrderPaymentTerms, validateClassInput } from "./classification";

describe("resolveOrderPaymentTerms", () => {
  const grosir = { defaultPaymentTermsDays: 14 };
  it("customer tanpa klasifikasi: pakai input manual", () => {
    expect(resolveOrderPaymentTerms({ requested: 30, customerClass: null, isPrivileged: false })).toBe(30);
    expect(resolveOrderPaymentTerms({ requested: null, customerClass: null, isPrivileged: false })).toBeNull();
  });
  it("sales tidak bisa menimpa tempo klasifikasi", () => {
    expect(resolveOrderPaymentTerms({ requested: 90, customerClass: grosir, isPrivileged: false })).toBe(14);
    expect(resolveOrderPaymentTerms({ requested: null, customerClass: grosir, isPrivileged: false })).toBe(14);
  });
  it("owner/admin boleh mengoreksi, kosong -> default klasifikasi", () => {
    expect(resolveOrderPaymentTerms({ requested: 7, customerClass: grosir, isPrivileged: true })).toBe(7);
    expect(resolveOrderPaymentTerms({ requested: null, customerClass: grosir, isPrivileged: true })).toBe(14);
  });
  it("klasifikasi tunai (tanpa tempo) mengunci non-privileged ke tunai", () => {
    expect(resolveOrderPaymentTerms({ requested: 30, customerClass: { defaultPaymentTermsDays: null }, isPrivileged: false })).toBeNull();
  });
});

describe("validateClassInput", () => {
  it("menerima input valid dan mengosongkan opsional", () => {
    expect(validateClassInput({ name: " Grosir ", defaultPaymentTermsDays: "14", approvalThresholdAmount: "" }))
      .toEqual({ ok: true, value: { name: "Grosir", defaultPaymentTermsDays: 14, approvalThresholdAmount: null } });
  });
  it("menolak nama pendek, tempo tidak bulat/di luar rentang, ambang negatif", () => {
    expect(validateClassInput({ name: "A", defaultPaymentTermsDays: null, approvalThresholdAmount: null }).ok).toBe(false);
    expect(validateClassInput({ name: "Besar", defaultPaymentTermsDays: "1.5", approvalThresholdAmount: null }).ok).toBe(false);
    expect(validateClassInput({ name: "Besar", defaultPaymentTermsDays: "400", approvalThresholdAmount: null }).ok).toBe(false);
    expect(validateClassInput({ name: "Besar", defaultPaymentTermsDays: null, approvalThresholdAmount: "-1" }).ok).toBe(false);
  });
});
