import { redirect } from "next/navigation";
import Link from "next/link";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { UserPlus } from "lucide-react";
import { TelegramEnrollmentControl } from "@/components/users/telegram-enrollment-control";
import { resolveSalesmanTelegramStatus } from "@/lib/salesman/status";
import { SalesmanCoverageControl } from "@/components/users/salesman-coverage-control";

export const metadata = { title: "Pengguna — AODP" };

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  manager: "Manager",
  sales: "Sales",
  admin: "Admin",
  warehouse: "Gudang",
  finance: "Keuangan",
  driver: "Driver",
};

const ROLE_COLOR: Record<string, string> = {
  super_admin: "bg-red-50 text-red-700",
  owner: "bg-purple-50 text-purple-700",
  manager: "bg-blue-50 text-blue-700",
  sales: "bg-green-50 text-green-700",
  admin: "bg-orange-50 text-orange-700",
  warehouse: "bg-yellow-50 text-yellow-700",
  finance: "bg-teal-50 text-teal-700",
  driver: "bg-gray-100 text-gray-700",
};

type UserRow = {
  id: string;
  full_name: string | null;
  email: string;
  is_active: boolean;
  created_at: string;
  user_roles: Array<{ role: { name: string } | null }>;
};

type TelegramIdentityRow = {
  user_id: string;
  telegram_username: string | null;
  is_active: boolean;
};

type PendingTokenRow = {
  user_id: string;
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
};

type CoverageAreaRow = {
  user_id: string;
  area: string;
};

function extractCoverageAreas(settings: unknown): string[] {
  if (!settings || typeof settings !== "object") return [];
  const raw = (settings as Record<string, unknown>).coverage_areas;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function UsersPage() {
  const user = await getAuthUser();

  const hasAccess =
    user.permissions.includes("users.view") ||
    user.roles.includes("super_admin") ||
    user.roles.includes("owner") ||
    user.roles.includes("admin");

  if (!hasAccess) redirect("/dashboard");

  const supabase = await createClient();

  const { data } = await supabase
    .from("users")
    .select(
      `
      id, full_name, email, is_active, created_at,
      user_roles!user_id(role:roles(name))
    `,
    )
    .eq("company_id", user.company_id)
    .order("full_name");

  const users = (data ?? []) as unknown as UserRow[];
  const canManageTelegram =
    user.permissions.includes("telegram.manage") ||
    ["owner", "manager", "admin", "super_admin"].some((role) =>
      user.roles.includes(role),
    );

  const { data: telegramData } = canManageTelegram
    ? await supabase
        .from("telegram_identities")
        .select("user_id, telegram_username, is_active")
        .eq("company_id", user.company_id)
        .eq("is_active", true)
    : { data: [] };

  const telegramByUser = new Map(
    ((telegramData ?? []) as TelegramIdentityRow[]).map((identity) => [
      identity.user_id,
      identity,
    ]),
  );

  // Status Telegram lengkap (Pairing Aktif/Kedaluwarsa/Diputuskan) butuh dua
  // sinyal tambahan di luar identity aktif: identity yang pernah ada lalu
  // dinonaktifkan (revoke), dan token enrollment yang masih pending.
  const { data: previousIdentityData } = canManageTelegram
    ? await supabase
        .from("telegram_identities")
        .select("user_id")
        .eq("company_id", user.company_id)
        .eq("is_active", false)
    : { data: [] };
  const hadPreviousIdentitySet = new Set(
    ((previousIdentityData ?? []) as { user_id: string }[]).map((r) => r.user_id),
  );

  const { data: pendingTokenData } = canManageTelegram
    ? await supabase
        .from("telegram_enrollment_tokens")
        .select("user_id, expires_at, claimed_at, revoked_at")
        .eq("company_id", user.company_id)
        .is("claimed_at", null)
        .is("revoked_at", null)
    : { data: [] };
  const pendingTokenByUser = new Map(
    ((pendingTokenData ?? []) as PendingTokenRow[]).map((t) => [t.user_id, t]),
  );

  const { data: companyRow } = await supabase
    .from("companies")
    .select("settings")
    .eq("id", user.company_id)
    .maybeSingle();
  const availableAreas = extractCoverageAreas((companyRow as { settings?: unknown } | null)?.settings);

  const { data: coverageData } = canManageTelegram
    ? await supabase
        .from("salesman_coverage_areas")
        .select("user_id, area")
        .eq("company_id", user.company_id)
    : { data: [] };
  const areasByUser = new Map<string, string[]>();
  for (const row of (coverageData ?? []) as CoverageAreaRow[]) {
    const list = areasByUser.get(row.user_id) ?? [];
    list.push(row.area);
    areasByUser.set(row.user_id, list);
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Pengguna"
        subtitle={`${users.length} pengguna terdaftar di perusahaan ini`}
      >
        {canManageTelegram ? (
          <Link
            href="/dashboard/users/new"
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <UserPlus className="h-4 w-4" />
            Tambah Salesman
          </Link>
        ) : null}
      </PageHeader>

      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3">
        <p className="text-sm text-blue-800">
          Manajemen pengguna lengkap untuk seluruh role sedang dalam pengembangan.
          Admin/Owner/Manager dapat menambahkan Salesman dan menghubungkan
          identitas Telegram-nya dari halaman ini.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Nama
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Email
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Peran
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Bergabung
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Wilayah Kerja
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                Telegram Salesman
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-gray-400"
                >
                  Belum ada pengguna. Setup pengguna awal dilakukan oleh super
                  admin via Supabase.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const roles = u.user_roles
                  .map((ur) => ur.role?.name)
                  .filter((n): n is string => !!n);

                const displayName = u.full_name || u.email;
                const initials = displayName.charAt(0).toUpperCase();
                const telegramIdentity = telegramByUser.get(u.id) ?? null;
                const pendingToken = pendingTokenByUser.get(u.id) ?? null;
                const telegramStatus = resolveSalesmanTelegramStatus({
                  hasActiveIdentity: !!telegramIdentity,
                  hadPreviousIdentity: hadPreviousIdentitySet.has(u.id),
                  pendingToken: pendingToken
                    ? {
                        expiresAt: pendingToken.expires_at,
                        claimedAt: pendingToken.claimed_at,
                        revokedAt: pendingToken.revoked_at,
                      }
                    : null,
                });

                return (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-700">
                          {initials}
                        </div>
                        <span className="font-medium text-gray-900">
                          {u.full_name || "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{u.email}</td>
                    <td className="px-4 py-3">
                      {roles.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {roles.map((r) => (
                            <span
                              key={r}
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                ROLE_COLOR[r] ?? "bg-gray-100 text-gray-700"
                              }`}
                            >
                              {ROLE_LABEL[r] ?? r}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.is_active ? (
                        <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                          Aktif
                        </span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                          Nonaktif
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDate(u.created_at)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {roles.includes("sales") ? (
                        canManageTelegram ? (
                          <SalesmanCoverageControl
                            salesmanId={u.id}
                            availableAreas={availableAreas}
                            assignedAreas={areasByUser.get(u.id) ?? []}
                          />
                        ) : (
                          <span className="text-xs text-gray-400">Akses diperlukan</span>
                        )
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {canManageTelegram && roles.includes("sales") ? (
                        <TelegramEnrollmentControl
                          salesmanId={u.id}
                          activeIdentity={
                            telegramIdentity
                              ? { username: telegramIdentity.telegram_username }
                              : null
                          }
                          status={telegramStatus}
                        />
                      ) : roles.includes("sales") ? (
                        <span className="text-xs text-gray-400">
                          Akses diperlukan
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
