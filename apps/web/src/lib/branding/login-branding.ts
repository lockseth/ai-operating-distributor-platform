// =============================================================================
// Branding halaman login SEBELUM ada authenticated tenant. Sumber HANYA
// environment variable public yang tervalidasi di server (build-time), bukan
// query database tanpa autentikasi dan bukan parameter client (?tenant=,
// ?company_id=). Aktif hanya ketika NEXT_PUBLIC_APP_ENV === "demo".
// =============================================================================

export interface LoginBranding {
  isDemoEnvironment: boolean;
  companyName: string | null;
}

export function resolveLoginBranding(env: {
  NEXT_PUBLIC_APP_ENV?: string;
  NEXT_PUBLIC_DEMO_COMPANY_NAME?: string;
}): LoginBranding {
  const isDemo = env.NEXT_PUBLIC_APP_ENV === "demo";
  return {
    isDemoEnvironment: isDemo,
    companyName: isDemo ? (env.NEXT_PUBLIC_DEMO_COMPANY_NAME?.trim() || null) : null,
  };
}
