import { describe, it, expect } from "vitest";
import {
  sanitizeBrandColor,
  sanitizeLogoUrl,
  isDemoEnvironment,
  resolveCompanyBranding,
  DEFAULT_BRAND_COLOR,
} from "./service";

describe("sanitizeBrandColor", () => {
  it("menerima hex 6 digit valid", () => {
    expect(sanitizeBrandColor("#AB12CD")).toBe("#AB12CD");
  });

  it("menerima hex 3 digit valid", () => {
    expect(sanitizeBrandColor("#abc")).toBe("#abc");
  });

  it("fallback ke default untuk nilai bukan hex (mis. CSS injection attempt)", () => {
    expect(sanitizeBrandColor("red; background-image:url(evil)")).toBe(DEFAULT_BRAND_COLOR);
  });

  it("fallback ke default untuk undefined/null/non-string", () => {
    expect(sanitizeBrandColor(undefined)).toBe(DEFAULT_BRAND_COLOR);
    expect(sanitizeBrandColor(null)).toBe(DEFAULT_BRAND_COLOR);
    expect(sanitizeBrandColor(123)).toBe(DEFAULT_BRAND_COLOR);
  });

  it("fallback untuk string kosong", () => {
    expect(sanitizeBrandColor("")).toBe(DEFAULT_BRAND_COLOR);
  });
});

describe("sanitizeLogoUrl", () => {
  it("menerima https URL valid", () => {
    expect(sanitizeLogoUrl("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png");
  });

  it("menerima http URL valid", () => {
    expect(sanitizeLogoUrl("http://example.com/logo.png")).toBe("http://example.com/logo.png");
  });

  it("menolak javascript: URL", () => {
    expect(sanitizeLogoUrl("javascript:alert(1)")).toBeNull();
  });

  it("menolak data: URL", () => {
    expect(sanitizeLogoUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("menolak string bukan URL", () => {
    expect(sanitizeLogoUrl("not-a-url")).toBeNull();
  });

  it("null untuk null/undefined/kosong", () => {
    expect(sanitizeLogoUrl(null)).toBeNull();
    expect(sanitizeLogoUrl(undefined)).toBeNull();
    expect(sanitizeLogoUrl("")).toBeNull();
  });
});

describe("isDemoEnvironment", () => {
  it("true ketika settings.environment === 'DEMO'", () => {
    expect(isDemoEnvironment({ environment: "DEMO" })).toBe(true);
  });

  it("false ketika settings.environment nilai lain", () => {
    expect(isDemoEnvironment({ environment: "production" })).toBe(false);
    expect(isDemoEnvironment({ environment: "demo" })).toBe(false); // case-sensitive, kontrak = "DEMO"
  });

  it("false ketika settings null/undefined/bukan object", () => {
    expect(isDemoEnvironment(null)).toBe(false);
    expect(isDemoEnvironment(undefined)).toBe(false);
    expect(isDemoEnvironment("DEMO")).toBe(false);
  });
});

describe("resolveCompanyBranding", () => {
  it("tenant lain (non-DEMO) TIDAK mendapat badge DEMO meskipun nama/brand berbeda", () => {
    const branding = resolveCompanyBranding({
      name: "PT. Tenant Lain",
      logo_url: null,
      settings: { brand_color: "#112233" },
    });
    expect(branding.name).toBe("PT. Tenant Lain");
    expect(branding.brandColor).toBe("#112233");
    expect(branding.isDemoEnvironment).toBe(false);
  });

  it("tenant Demo Waluyo mendapat badge DEMO dan brand color tervalidasi", () => {
    const branding = resolveCompanyBranding({
      name: "PT. Sumber Warna Alam Sudiada",
      logo_url: null,
      settings: { environment: "DEMO", brand_color: "#2563EB" },
    });
    expect(branding.name).toBe("PT. Sumber Warna Alam Sudiada");
    expect(branding.isDemoEnvironment).toBe(true);
    expect(branding.brandColor).toBe("#2563EB");
  });

  it("settings undefined tidak crash, fallback aman", () => {
    const branding = resolveCompanyBranding({ name: "PT. X", logo_url: null });
    expect(branding.brandColor).toBe(DEFAULT_BRAND_COLOR);
    expect(branding.isDemoEnvironment).toBe(false);
    expect(branding.logoUrl).toBeNull();
  });
});
