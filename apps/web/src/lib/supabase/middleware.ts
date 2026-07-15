import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { DEMO_MODE_COOKIE, isDemoModeAllowed } from "@/lib/demo/config";

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Webhook routes diautentikasi via secret/credential milik masing-masing,
  // BUKAN Supabase session — pemanggilnya adalah service eksternal tanpa
  // cookie sama sekali. Middleware auth wajib dilewati di sini, jika tidak
  // setiap webhook selalu di-redirect ke /login sebelum route handler-nya
  // sempat jalan.
  //
  // SENGAJA daftar eksplisit (bukan prefix "/api/webhooks/") — supaya
  // route baru di bawah /api/webhooks/ tidak otomatis mewarisi bypass ini
  // hanya karena lokasinya, sebelum autentikasi mandirinya diaudit dan
  // ditambahkan ke daftar ini secara sadar.
  const AUDITED_WEBHOOK_ROUTES = ["/api/webhooks/telegram", "/api/webhooks/n8n"];
  if (AUDITED_WEBHOOK_ROUTES.includes(pathname)) {
    return NextResponse.next({ request });
  }

  const isAuthRoute =
    pathname.startsWith("/login") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password") ||
    pathname.startsWith("/callback");

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

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
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
