// =============================================================================
// Supabase Admin Client — Server-only singleton with service role key.
//
// SECURITY: This module MUST NEVER be imported in client components or any
// file that ends up in the browser bundle. The service role key bypasses ALL
// Row Level Security policies.
//
// Usage: import { getAdminClient } from "@/lib/supabase/admin"
//        Only in: server actions, API routes, server components.
// =============================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Module-level singleton — one client per Node.js process lifetime.
// In serverless (Vercel), each cold start creates one instance; warm invocations reuse it.
let _client: SupabaseClient | null = null;

/**
 * Returns the Supabase admin client that bypasses RLS.
 * Throws if the required environment variables are not set.
 */
export function getAdminClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase admin credentials. " +
      "Ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set."
    );
  }

  _client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _client;
}
