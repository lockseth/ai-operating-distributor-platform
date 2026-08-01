import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveCallbackNextPath } from "@/lib/auth/callback";

// Gate 3D-B3-F1 — menukar PKCE `code` dari link konfirmasi email menjadi
// session yang benar-benar tersimpan di cookie, sebelum meneruskan ke tujuan
// yang di-allowlist (lihat lib/auth/callback.ts). Tanpa route ini,
// getSession() di signup-form.tsx selalu null walau email sudah confirmed
// di sisi Supabase -- akar masalah yang ditemukan saat Gate 3D-B3-A2 rerun.
//
// Fail-closed: code hilang, invalid/expired, atau exchange gagal karena
// sebab apa pun -> redirect ke /login dengan flag error generik. Pesan error
// Supabase mentah TIDAK PERNAH diteruskan ke client (bisa membocorkan detail
// internal), dan tidak pernah di-log.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = resolveCallbackNextPath(searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
    }
  } catch {
    return NextResponse.redirect(`${origin}/login?error=confirmation_failed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
