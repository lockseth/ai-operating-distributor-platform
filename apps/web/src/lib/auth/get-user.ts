import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { DEMO_MODE_COOKIE, isDemoModeAllowed } from "@/lib/demo/config";

export interface AuthUser {
  id: string;
  email: string;
  company_id: string;
  company: {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    subscription_plan: string;
    settings: Record<string, unknown> | null;
  };
  roles: string[];
  permissions: string[];
  /** true hanya untuk sesi demo bypass (development-only, lihat lib/demo/config.ts) */
  isDemo: boolean;
}

// Permission super-set (mengikuti seed role "owner" + varian "*.edit" yang
// dipakai sebagian halaman) supaya sesi demo bisa melihat seluruh UI owner
// tanpa bergantung pada data role_permissions di database.
const DEMO_AUTH_USER: AuthUser = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "demo-owner@aodp.local",
  company_id: "00000000-0000-0000-0000-000000000000",
  company: {
    id: "00000000-0000-0000-0000-000000000000",
    name: "AODP Demo Distributor",
    slug: "aodp-demo",
    logo_url: null,
    subscription_plan: "owner_protection",
    settings: null,
  },
  roles: ["owner"],
  permissions: [
    "companies.view", "companies.manage",
    "users.view", "users.create", "users.update", "users.delete", "users.manage",
    "products.view", "products.create", "products.update", "products.edit", "products.delete", "products.manage",
    "customers.view", "customers.create", "customers.update", "customers.edit", "customers.delete", "customers.manage",
    "orders.view", "orders.create", "orders.update", "orders.edit", "orders.delete", "orders.manage",
    "reports.view", "reports.create", "reports.update", "reports.export", "reports.manage",
    "settings.view", "settings.manage",
    "ai.view", "ai.manage",
    "automation.view", "automation.manage",
    "imports.view", "imports.execute", "imports.commit", "imports.rollback",
  ],
  isDemo: true,
};

export async function getAuthUser(): Promise<AuthUser> {
  if (isDemoModeAllowed()) {
    const cookieStore = await cookies();
    if (cookieStore.get(DEMO_MODE_COOKIE)?.value === "1") {
      return DEMO_AUTH_USER;
    }
  }

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) redirect("/login");

  // User profile
  const { data: profileData } = await supabase
    .from("users")
    .select("id, company_id, email, full_name, is_active, must_change_password")
    .eq("id", user.id)
    .maybeSingle();

  const profile = profileData as {
    id: string;
    company_id: string;
    email: string;
    full_name: string;
    is_active: boolean;
    must_change_password: boolean;
  } | null;

  // Gate 3E-C-C1 — auth user valid tapi TANPA baris public.users sama sekali
  // berarti signup-nya terputus SEBELUM provision_first_owner() sempat
  // dipanggil (bukan "belum pernah signup" -- middleware sudah menolak !user
  // di atas). Redirect ke /login di sini dulu menyebabkan redirect loop tak
  // berujung: middleware.ts mengarahkan authenticated user di /login balik ke
  // /dashboard (user && isAuthRoute), yang memanggil getAuthUser() ini lagi,
  // menemukan !profile lagi, redirect /login lagi -- tanpa akhir. /signup
  // SENGAJA dikecualikan dari isAuthRoute di middleware persis untuk kasus
  // ini (lihat komentar middleware.ts) -- evaluateSession() di
  // signup-form.tsx mendeteksi session tanpa profile lalu menampilkan layar
  // "continue" untuk melanjutkan provisioning dengan aman, tanpa membuat
  // auth user/company/role baru. Sesi TIDAK di-signOut di sini (berbeda dari
  // cabang is_active/zero-role di bawah) karena sesi ini justru dibutuhkan --
  // provision_first_owner() mengidentifikasi caller lewat auth.uid().
  if (!profile) redirect("/signup");
  // Gate 1B — shared boundary: sesi/token lama milik user yang sudah
  // dinonaktifkan (mis. Salesman non-aktif) tidak boleh melewati halaman
  // atau server action manapun yang bergantung pada getAuthUser().
  if (!profile.is_active) {
    await supabase.auth.signOut();
    redirect("/login");
  }

  // Gate 3E-C-C2-B1 — mandatory password change: user yang dibuat owner
  // dengan temporary password (must_change_password = TRUE, lihat
  // provision_owner_created_tenant_user(), migration 20260911000001) tidak
  // boleh mengakses satu pun halaman/server action dashboard sampai password
  // sungguh diganti. Self-heal di sini (bukan lewat UI/route baru): panggil
  // complete_mandatory_password_change() memakai sesi user ini sendiri
  // (auth.uid() di dalam RPC, sama seperti provision_first_owner()) -- RPC
  // hanya membersihkan flag bila auth.users.encrypted_password terbukti
  // berbeda dari snapshot yang direkam saat provisioning (bukti password
  // benar-benar sudah diganti, bukan klaim client). Bila belum berubah,
  // redirect ke /reset-password (halaman existing, reset-password-form.tsx,
  // TIDAK diubah sama sekali oleh gate ini) -- TANPA signOut, karena
  // halaman itu butuh sesi ini untuk memanggil updateUser({ password }).
  // middleware.ts sengaja mengecualikan /reset-password dari redirect-away-
  // if-authenticated (lihat komentar di sana) supaya redirect ini tidak
  // berujung loop, identik alasan pengecualian /signup di atas.
  if (profile.must_change_password) {
    const { data: rpcData } = await supabase.rpc("complete_mandatory_password_change");
    const outcome = ((rpcData ?? []) as { result_outcome: string }[])[0]?.result_outcome;
    if (outcome !== "cleared") {
      redirect("/reset-password");
    }
  }

  // Company
  const { data: companyData } = await supabase
    .from("companies")
    .select("id, name, slug, logo_url, subscription_plan, settings")
    .eq("id", profile.company_id)
    .maybeSingle();

  const company = companyData as {
    id: string;
    name: string;
    slug: string;
    logo_url: string | null;
    subscription_plan: string;
    settings: Record<string, unknown> | null;
  } | null;

  if (!company) redirect("/login");

  // Role IDs
  const { data: userRolesData } = await supabase
    .from("user_roles")
    .select("role_id")
    .eq("user_id", profile.id)
    .eq("company_id", profile.company_id);

  const roleIds = ((userRolesData ?? []) as { role_id: string }[]).map(
    (r) => r.role_id
  );

  // Role names
  const roleNames: string[] = [];
  if (roleIds.length > 0) {
    const { data: rolesData } = await supabase
      .from("roles")
      .select("name")
      .in("id", roleIds);
    roleNames.push(...((rolesData ?? []) as { name: string }[]).map((r) => r.name));
  }

  // Gate 3C — shared boundary: user dengan profile aktif tapi TANPA baris
  // user_roles (tidak ada canonical membership sama sekali) sebelumnya lolos
  // ke sini dengan roles=[], lalu getPrimaryRole([]) diam-diam fallback ke
  // "sales" -- mengarahkan user tanpa membership ke /dashboard/sales, yang
  // menolaknya lagi ke /dashboard, yang mengarahkannya balik ke
  // /dashboard/sales (redirect loop tanpa akhir). Gagal-tutup di sini,
  // konsisten dengan gate is_active di atas.
  if (roleNames.length === 0) {
    await supabase.auth.signOut();
    redirect("/login");
  }

  // Permission IDs via role_permissions
  const permissionNames: string[] = [];
  if (roleIds.length > 0) {
    const { data: rolePermsData } = await supabase
      .from("role_permissions")
      .select("permission_id")
      .in("role_id", roleIds);

    const permIds = [
      ...new Set(
        ((rolePermsData ?? []) as { permission_id: string }[]).map(
          (rp) => rp.permission_id
        )
      ),
    ];

    if (permIds.length > 0) {
      const { data: permsData } = await supabase
        .from("permissions")
        .select("name")
        .in("id", permIds);
      permissionNames.push(
        ...((permsData ?? []) as { name: string }[]).map((p) => p.name)
      );
    }
  }

  return {
    id: profile.id,
    email: profile.email,
    company_id: profile.company_id,
    company,
    roles: roleNames,
    permissions: permissionNames,
    isDemo: false,
  };
}
