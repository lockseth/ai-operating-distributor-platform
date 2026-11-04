import { describe, expect, it } from "vitest";
import { decideInvoiceApproval } from "./invoice-approval";

describe("decideInvoiceApproval", () => {
  const base = { amount: 6_000_000, threshold: 5_000_000, alreadyApproved: false, isOwner: false };
  it("tanpa ambang: lanjut", () => expect(decideInvoiceApproval({ ...base, threshold: null })).toBe("proceed"));
  it("tepat di ambang atau di bawah: lanjut", () => {
    expect(decideInvoiceApproval({ ...base, amount: 5_000_000 })).toBe("proceed");
    expect(decideInvoiceApproval({ ...base, amount: 100 })).toBe("proceed");
  });
  it("di atas ambang tanpa persetujuan: minta persetujuan", () => expect(decideInvoiceApproval(base)).toBe("request"));
  it("di atas ambang sudah disetujui: lanjut", () => expect(decideInvoiceApproval({ ...base, alreadyApproved: true })).toBe("proceed"));
  it("Owner menerbitkan sendiri: persetujuan otomatis tercatat", () => expect(decideInvoiceApproval({ ...base, isOwner: true })).toBe("owner_self_approve"));
});
