import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveConfirmNextPath } from "@/lib/auth/confirm";

// Gate 3E-C-C2-B4-R1 — menukar `token_hash` dari link recovery email menjadi
// session yang tersimpan di cookie, lewat verifyOtp() SERVER-SIDE. Berbeda
// dari /auth/callback (exchangeCodeForSession, PKCE `code`): token_hash TIDAK
// bergantung pada code_verifier yang tersimpan di browser yang memicu
// resetPasswordForEmail() -- verifikasi murni terjadi di Supabase Auth API
// memakai token_hash sebagai satu-satunya kredensial, sehingga link recovery
// bisa dibuka di browser/device APA PUN, bukan hanya browser yang meminta
// reset. Ini akar perbaikan Gate 3E-C-C2-B4 (reset password gagal lintas
// device/browser karena PKCE code_verifier hanya ada di browser pemohon).
//
// Scoped KHUSUS type=recovery untuk gate ini -- type lain (signup,
// email_change, dst) ditolak fail-closed; bukan tanggung jawab route ini
// (lihat /auth/callback untuk signup confirmation, mekanisme terpisah).
//
// Fail-closed: token_hash hilang, type != recovery, atau verifyOtp gagal
// karena sebab apa pun -> redirect ke /login dengan flag error generik.
// token_hash dan pesan error Supabase mentah TIDAK PERNAH diteruskan ke
// client maupun di-log (bocor token_hash di log setara membocorkan
// kredensial reset password sekali-pakai).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = resolveConfirmNextPath(searchParams.get("next"));

  if (!tokenHash || type !== "recovery") {
    return NextResponse.redirect(`${origin}/login?error=recovery_failed`);
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: "recovery",
    });

    if (error) {
      return NextResponse.redirect(`${origin}/login?error=recovery_failed`);
    }
  } catch {
    return NextResponse.redirect(`${origin}/login?error=recovery_failed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
