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
    pathname.startsWith("/forgot-password");

  // /reset-password sengaja BUKAN bagian dari isAuthRoute (Gate 3E-C-C2-B1):
  // seorang user dengan must_change_password = TRUE (dibuat owner dengan
  // temporary password, lihat provision_owner_created_tenant_user()) PUNYA
  // sesi authenticated yang SAH -- bukan sesi recovery Supabase Auth
  // terpisah -- tapi WAJIB tetap bisa mencapai halaman ini untuk mengganti
  // password (get-user.ts redirect ke sini selama flag masih TRUE). Bila
  // /reset-password tetap dianggap isAuthRoute, blok "user && isAuthRoute"
  // di bawah akan membalikkan authenticated user ini ke /dashboard, yang
  // memanggil getAuthUser() lagi, yang redirect ke /reset-password lagi --
  // redirect loop tanpa akhir, identik alasan /signup dikecualikan di bawah.
  // Konsekuensi: user yang SUDAH login normal (must_change_password = FALSE)
  // dan sengaja membuka /reset-password juga tidak lagi dibalikkan ke
  // /dashboard -- halaman itu sendiri hanya memanggil updateUser({ password })
  // pada sesi aktif, jadi ini tidak membuka privilege baru, hanya menghindari
  // bounce yang sebelumnya bisa bentrok dengan sesi recovery yang dibuka di
  // tab lain oleh user yang sama.
  const isResetPasswordRoute = pathname.startsWith("/reset-password");

  // /signup sengaja BUKAN bagian dari isAuthRoute: rute lain di sana redirect
  // authenticated user ke /dashboard, tapi /signup harus tetap bisa diakses
  // oleh user yang SUDAH authenticated tapi BELUM diprovisi (lanjutan setelah
  // email confirmation, atau retry setelah provisioning gagal) -- getAuthUser()
  // akan sign-out + redirect user tanpa user_roles yang mencapai /dashboard
  // (Gate 3C fail-closed), jadi memaksa redirect ke /dashboard di sini akan
  // merusak sesi sebelum provisioning sempat selesai. Halaman /signup sendiri
  // yang menentukan (client-side, via query users profil) apakah authenticated
  // user ini sudah diprovisi dan perlu diarahkan ke /dashboard.
  const isSignupRoute = pathname.startsWith("/signup");

  // /auth/callback (Gate 3D-B3-F1) menukar PKCE `code` dari link konfirmasi
  // email menjadi session -- request ini SELALU datang tanpa session (belum
  // ada cookie sama sekali), jadi wajib diizinkan lewat sebelum auth-gate di
  // bawah, sama seperti /login dan /signup.
  const isAuthCallbackRoute = pathname.startsWith("/auth/callback");

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

  // isResetPasswordRoute tetap bagian dari isPublicRoute (perilaku existing
  // tidak berubah): link recovery Supabase datang tanpa cookie session sama
  // sekali pada request GET pertama (token ada di URL fragment, diproses
  // client-side oleh supabase-js) -- rute ini WAJIB tetap bisa diakses tanpa
  // sesi. Yang berubah HANYA: rute ini tidak lagi dibalikkan ke /dashboard
  // ketika user SUDAH authenticated (lihat komentar isResetPasswordRoute
  // di atas).
  const isPublicRoute =
    isAuthRoute || isSignupRoute || isAuthCallbackRoute || isResetPasswordRoute || pathname === "/";

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
