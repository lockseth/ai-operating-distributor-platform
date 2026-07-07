import type { NextConfig } from "next";

const securityHeaders = [
  // Prevent MIME type sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Prevent clickjacking via iframe embedding
  { key: "X-Frame-Options", value: "DENY" },
  // Enable browser XSS filter (legacy browsers)
  { key: "X-XSS-Protection", value: "1; mode=block" },
  // Control referrer information
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Restrict browser features
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Content Security Policy — permissive baseline for Next.js + Supabase
  // Tighten per-route in production when inline styles/scripts are eliminated
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js requires unsafe-inline for styles in development; keep for now
      "style-src 'self' 'unsafe-inline'",
      // Next.js hydration requires unsafe-inline/eval for scripts in dev
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Supabase API + auth
      `connect-src 'self' ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""} wss://*.supabase.co`,
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
