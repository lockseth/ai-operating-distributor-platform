import { describe, it, expect } from "vitest";
import {
  isValidDemoProjectHost,
  isAllowedDemoEmail,
  assertNewPasswordProvided,
  buildResetSuccessMessage,
  buildResetFailureMessage,
  DEMO_PROJECT_REF,
} from "./reset-rules";

describe("isValidDemoProjectHost", () => {
  it("true untuk hostname project Demo yang benar", () => {
    expect(isValidDemoProjectHost(`${DEMO_PROJECT_REF}.supabase.co`)).toBe(true);
  });

  it("false untuk project ref lain (mis. project production/ASOS/flowsales)", () => {
    expect(isValidDemoProjectHost("xpqapptqvtjydurbnduv.supabase.co")).toBe(false);
  });

  it("false untuk null/undefined/kosong", () => {
    expect(isValidDemoProjectHost(null)).toBe(false);
    expect(isValidDemoProjectHost(undefined)).toBe(false);
    expect(isValidDemoProjectHost("")).toBe(false);
  });
});

describe("isAllowedDemoEmail", () => {
  it("true untuk pasangan account/email yang benar", () => {
    expect(isAllowedDemoEmail("owner", "owner.demo@waluyo.aodp.test")).toBe(true);
    expect(isAllowedDemoEmail("admin", "admin.demo@waluyo.aodp.test")).toBe(true);
    expect(isAllowedDemoEmail("sales", "sales.demo@waluyo.aodp.test")).toBe(true);
  });

  it("false ketika email satu account dipakai untuk account lain", () => {
    expect(isAllowedDemoEmail("sales", "owner.demo@waluyo.aodp.test")).toBe(false);
    expect(isAllowedDemoEmail("owner", "sales.demo@waluyo.aodp.test")).toBe(false);
    expect(isAllowedDemoEmail("admin", "owner.demo@waluyo.aodp.test")).toBe(false);
    expect(isAllowedDemoEmail("owner", "admin.demo@waluyo.aodp.test")).toBe(false);
    expect(isAllowedDemoEmail("admin", "sales.demo@waluyo.aodp.test")).toBe(false);
    expect(isAllowedDemoEmail("sales", "admin.demo@waluyo.aodp.test")).toBe(false);
  });

  it("false untuk email arbitrer di luar allowlist", () => {
    expect(isAllowedDemoEmail("owner", "attacker@evil.com")).toBe(false);
    expect(isAllowedDemoEmail("owner", undefined)).toBe(false);
  });
});

describe("assertNewPasswordProvided — fail-closed", () => {
  it("throw untuk undefined/null/string kosong", () => {
    expect(() => assertNewPasswordProvided(undefined)).toThrow(/fail-closed/i);
    expect(() => assertNewPasswordProvided(null)).toThrow();
    expect(() => assertNewPasswordProvided("")).toThrow();
  });

  it("mengembalikan nilai apa adanya jika tersedia (bukan generate sendiri)", () => {
    expect(assertNewPasswordProvided("nilai-dari-operator")).toBe("nilai-dari-operator");
  });

  it("pesan error TIDAK PERNAH memuat nilai password (karena fungsi tidak menerima value saat gagal)", () => {
    try {
      assertNewPasswordProvided(undefined);
    } catch (e) {
      expect((e as Error).message).not.toMatch(/nilai-dari-operator|password123|secret/i);
    }
  });
});

describe("buildResetSuccessMessage / buildResetFailureMessage — tidak pernah membawa password", () => {
  it("pesan sukses hanya memuat email dan nama kunci, tidak ada parameter password", () => {
    const msg = buildResetSuccessMessage("owner.demo@waluyo.aodp.test", "AODP_DEMO_OWNER_PASSWORD");
    expect(msg).toContain("owner.demo@waluyo.aodp.test");
    expect(msg).toContain("tidak ditampilkan");
    // Signature fungsi tidak menerima nilai password sama sekali -> tidak
    // mungkin bocor lewat pesan ini secara struktural.
  });

  it("pesan gagal hanya memuat reason yang diberikan, tidak menambahkan data lain", () => {
    const msg = buildResetFailureMessage("target project bukan Demo");
    expect(msg).toBe("FAIL: target project bukan Demo");
  });
});
