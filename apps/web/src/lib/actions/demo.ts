"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_MODE_COOKIE, isDemoModeAllowed } from "@/lib/demo/config";

/**
 * Bypass login untuk demo lokal — development-only (lihat lib/demo/config.ts).
 * Tidak pernah memanggil Supabase Auth; hanya menandai sesi via cookie.
 */
export async function enterDemoModeAction(): Promise<void> {
  if (!isDemoModeAllowed()) {
    throw new Error("Demo mode hanya tersedia di lingkungan development.");
  }

  const cookieStore = await cookies();
  cookieStore.set(DEMO_MODE_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });

  redirect("/dashboard/owner");
}
