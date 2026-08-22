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
    "/api/internal/automation/sales-report-afternoon",
    "/api/internal/automation/collection-plan-morning",
    "/api/internal/automation/dispatch",
    "/api/internal/automation/heartbeat",
  ];
  // Vercel Cron triggers (Gate P4.14, menggantikan n8n sebagai penjadwal) --
  // diautentikasi via CRON_SECRET (lib/n8n-automation/cron.ts), bukan
  // Supabase session -- Vercel memanggil endpoint ini tanpa cookie sama
  // sekali. Daftar eksplisit, alasan sama persis dengan dua daftar di atas.
  const AUDITED_CRON_ROUTES = [
    "/api/cron/morning-brief",
    "/api/cron/kpi-daily-summary",
    "/api/cron/sales-report-afternoon",
    "/api/cron/collection-plan-morning",
  ];
  // /api/health -- Gate 3E-C-C2-B4-R2-H1: public infra liveness probe (lihat
  // komentar di app/api/health/route.ts) SENGAJA TIDAK terautentikasi supaya
  // load balancer/orchestrator/uptime monitor bisa memeriksa "aplikasi
  // hidup" tanpa credential. Sebelumnya TIDAK ada pengecualian di sini sama
  // sekali -- middleware selalu meredirect anonymous request ke /login
  // sebelum route handler-nya (yang justru dirancang untuk anonymous)
  // sempat jalan, kontradiktif dengan kontrak yang didokumentasikan di route
  // itu sendiri.
  //
  // EXACT match (=== , bukan startsWith prefix) -- identik alasan
  // AUDITED_WEBHOOK_ROUTES di atas: /api/health/* atau nama mirip (mis.
  // /api/health-check, /api/health/private) TIDAK otomatis ikut ter-exempt
  // hanya karena mirip nama/lokasi, harus diaudit & ditambahkan sendiri
  // secara sadar bila memang perlu.
  const PUBLIC_HEALTH_ROUTE = "/api/health";

  if (
    AUDITED_WEBHOOK_ROUTES.includes(pathname) ||
    AUDITED_INTERNAL_AUTOMATION_ROUTES.includes(pathname) ||
    AUDITED_CRON_ROUTES.includes(pathname) ||
    pathname === PUBLIC_HEALTH_ROUTE
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
  //
  // Update Gate 3E-C-C2-B4-R1: sejak /auth/confirm ada, request recovery yang
  // sampai ke /reset-password SUDAH membawa cookie session (di-set oleh
  // verifyOtp() di /auth/confirm sebelum redirect ke sini) -- bukan lagi
  // "tanpa session sama sekali, token diproses client-side" seperti asumsi
  // lama. Route tetap public di sini (defense-in-depth, tidak mengubah
  // perilaku existing untuk kasus temp-password di atas) -- guard "wajib ada
  // session valid" yang sesungguhnya sekarang eksplisit di reset-password/
  // page.tsx sendiri (redirect fail-closed bila tidak ada user), bukan lagi
  // cuma implisit lewat kegagalan updateUser().
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

  // /auth/confirm (Gate 3E-C-C2-B4-R1) menukar `token_hash` dari link
  // recovery email menjadi session lewat verifyOtp() -- identik alasan
  // /auth/callback di atas: request ini SELALU datang tanpa session sama
  // sekali (link dibuka di browser/device manapun, termasuk yang berbeda
  // dari browser yang memicu resetPasswordForEmail() -- itulah sebabnya
  // token_hash dipakai, bukan PKCE `code`), jadi wajib diizinkan lewat
  // sebelum auth-gate di bawah.
  const isAuthConfirmRoute = pathname.startsWith("/auth/confirm");

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

  // isResetPasswordRoute tetap bagian dari isPublicRoute -- lihat komentar
  // lengkap di deklarasi isResetPasswordRoute di atas (termasuk update Gate
  // 3E-C-C2-B4-R1 soal /auth/confirm).
  const isPublicRoute =
    isAuthRoute ||
    isSignupRoute ||
    isAuthCallbackRoute ||
    isAuthConfirmRoute ||
    isResetPasswordRoute ||
    pathname === "/";

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
