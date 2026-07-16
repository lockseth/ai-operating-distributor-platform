// =============================================================================
// Tenant branding — resolusi aman dari companies.name / logo_url /
// settings.brand_color / settings.environment ke bentuk yang boleh langsung
// dipakai UI. Semua nilai dari database divalidasi di sini SEBELUM dipakai
// sebagai CSS value atau src gambar — jangan pernah pakai settings mentah
// langsung di komponen.
// =============================================================================

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const DEFAULT_BRAND_COLOR = "#2563EB";

export function sanitizeBrandColor(input: unknown): string {
  if (typeof input === "string" && HEX_COLOR_RE.test(input.trim())) {
    return input.trim();
  }
  return DEFAULT_BRAND_COLOR;
}

export function sanitizeLogoUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.trim() === "") return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isDemoEnvironment(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return false;
  return (settings as Record<string, unknown>).environment === "DEMO";
}

export interface CompanyBranding {
  name: string;
  logoUrl: string | null;
  brandColor: string;
  isDemoEnvironment: boolean;
}

export function resolveCompanyBranding(company: {
  name: string;
  logo_url?: string | null;
  settings?: unknown;
}): CompanyBranding {
  const settings = (company.settings ?? {}) as Record<string, unknown>;
  return {
    name: company.name,
    logoUrl: sanitizeLogoUrl(company.logo_url),
    brandColor: sanitizeBrandColor(settings.brand_color),
    isDemoEnvironment: isDemoEnvironment(settings),
  };
}
