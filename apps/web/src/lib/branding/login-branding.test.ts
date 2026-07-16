import { describe, it, expect } from "vitest";
import { resolveLoginBranding } from "./login-branding";

describe("resolveLoginBranding", () => {
  it("aktif hanya ketika NEXT_PUBLIC_APP_ENV === 'demo'", () => {
    const branding = resolveLoginBranding({
      NEXT_PUBLIC_APP_ENV: "demo",
      NEXT_PUBLIC_DEMO_COMPANY_NAME: "PT. Sumber Warna Alam Sudiada",
    });
    expect(branding.isDemoEnvironment).toBe(true);
    expect(branding.companyName).toBe("PT. Sumber Warna Alam Sudiada");
  });

  it("tidak aktif untuk 'production'/'preview'/'pilot'/undefined", () => {
    for (const env of ["production", "preview", "pilot", undefined]) {
      const branding = resolveLoginBranding({ NEXT_PUBLIC_APP_ENV: env });
      expect(branding.isDemoEnvironment).toBe(false);
      expect(branding.companyName).toBeNull();
    }
  });

  it("tidak aktif untuk typo/casing salah (fail closed)", () => {
    const branding = resolveLoginBranding({ NEXT_PUBLIC_APP_ENV: "Demo" });
    expect(branding.isDemoEnvironment).toBe(false);
  });

  it("companyName null jika demo aktif tapi nama belum diset", () => {
    const branding = resolveLoginBranding({ NEXT_PUBLIC_APP_ENV: "demo" });
    expect(branding.isDemoEnvironment).toBe(true);
    expect(branding.companyName).toBeNull();
  });

  it("companyName di-trim, string kosong dianggap null", () => {
    const branding = resolveLoginBranding({
      NEXT_PUBLIC_APP_ENV: "demo",
      NEXT_PUBLIC_DEMO_COMPANY_NAME: "   ",
    });
    expect(branding.companyName).toBeNull();
  });
});
