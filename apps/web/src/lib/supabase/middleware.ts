import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { DEMO_MODE_COOKIE, isDemoModeAllowed } from "@/lib/demo/config";

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Webhook & internal automation routes diautentikasi via secret/credential
  // milik masing-masing, BUKAN Supabase session — pemanggilnya adalah
  // service eksternal (n8n) tanpa cookie sama sekali. Middleware auth wajib
  // dilewati di sini, jika tidak setiap panggilan selalu di-redirect ke
  // /login sebelum route handler-nya (dan Bearer-token auth-nya sendiri)
  // sempat jalan.
  //
  // SENGAJA daftar eksplisit (bukan prefix "/api/webhooks/" atau
  // "/api/internal/") — supaya route baru di bawah path ini tidak otomatis
  // mewarisi bypass ini hanya karena lokasinya, sebelum autentikasi
  // mandirinya diaudit dan ditambahkan ke daftar ini secara sadar.
  const AUDITED_WEBHOOK_ROUTES = ["/api/webhooks/telegram", "/api/webhooks/n8n"];
  // Automation Outbox internal API (n8n Automation & Orchestration
  // Foundation) -- semua rute ini memakai resolveAutomationCredential()
  // (Bearer token -> SHA-256 hash -> n8n_inbound_credentials, company_id
  // SELALU dari credential) sebagai gate 401/403 mandiri sebelum operasi
  // apa pun -- lihat lib/n8n-automation/service.ts.
  const AUDITED_INTERNAL_AUTOMATION_ROUTES = [
    "/api/internal/automation/claim",
    "/api/internal/automation/complete",
    "/api/internal/automation/fail",
    "/api/internal/automation/replay",
    "/api/internal/automation/health",
    "/api/internal/automation/morning-brief",
    "/api/internal/automation/kpi-daily-summary",
    "/api/internal/automation/dispatch",
    "/api/internal/automation/heartbeat",
  ];
  if (
    AUDITED_WEBHOOK_ROUTES.includes(pathname) ||
    AUDITED_INTERNAL_AUTOMATION_ROUTES.includes(pathname)
  ) {
    return NextResponse.next({ request });
  }

  const isAuthRoute =
    pathname.startsWith("/login") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password");

  // Demo mode: dev-only bypass — jangan sentuh Supabase sama sekali di jalur
  // ini, supaya demo tetap jalan walau Supabase/Docker sedang tidak aktif.
  if (isDemoModeAllowed() && request.cookies.get(DEMO_MODE_COOKIE)?.value === "1") {
    if (isAuthRoute) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing Supabase credentials in middleware. " +
      "Ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set."
    );
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2])
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicRoute = isAuthRoute || pathname === "/";

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
