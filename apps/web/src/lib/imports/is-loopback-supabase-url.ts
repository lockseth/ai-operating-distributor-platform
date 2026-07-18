// =============================================================================
// Safety guard TEST-ONLY (bukan production logic) -- dipakai satu-satunya
// oleh commit-invalid-status.integration.test.ts untuk memastikan DB
// integration test TIDAK BISA terhubung ke Supabase cloud/demo/production
// hanya karena .env.local kebetulan menunjuk ke sana.
//
// WAJIB pakai new URL(value).hostname (parsing URL sungguhan), BUKAN
// string.includes("localhost")/includes("127.0.0.1") -- substring match
// bisa ditipu URL seperti "http://localhost@evil.example.com" (di situ
// "localhost" adalah USERNAME userinfo, bukan hostname) atau
// "http://localhost.evil.test" (subdomain, host sungguhan bukan loopback).
// .hostname dari WHATWG URL parser mengembalikan HOST SUNGGUHAN, kebal
// terhadap kedua trik itu.
// =============================================================================

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackSupabaseUrl(value: string): boolean {
  if (!value) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // Normalisasi IPv6: WHATWG URL bisa mengembalikan hostname dengan bracket
  // ("[::1]") tergantung representasi -- disamakan ke bentuk tanpa bracket.
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  return LOOPBACK_HOSTNAMES.has(hostname);
}
