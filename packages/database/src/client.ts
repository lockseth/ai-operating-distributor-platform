import { createBrowserClient as supabaseCreateBrowserClient } from "@supabase/ssr";
import { createServerClient as supabaseCreateServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import type { Database } from "./database.types";

export type { SupabaseClient } from "@supabase/supabase-js";

export function createBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables."
    );
  }

  return supabaseCreateBrowserClient<Database>(url, key);
}

export function createServerClient(
  cookieStore: {
    getAll: () => { name: string; value: string }[] | Promise<{ name: string; value: string }[]>;
    setAll?: (
      cookies: { name: string; value: string; options?: CookieOptions }[]
    ) => void | Promise<void>;
  }
) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variables."
    );
  }

  return supabaseCreateServerClient<Database>(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        if (cookieStore.setAll) {
          cookieStore.setAll(cookiesToSet);
        }
      },
    },
  });
}
