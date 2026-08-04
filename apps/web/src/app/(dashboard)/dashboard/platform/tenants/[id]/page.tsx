import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { OnboardingChecklist } from "@/components/platform/onboarding-checklist";
import { FirstUserForm } from "@/components/platform/first-user-form";
import { ResetTenantUserPasswordButton } from "@/components/platform/reset-tenant-user-password-button";
import {
  ChevronLeft, Edit2, Building2, CheckCircle2, XCircle,
  Users, Package, ShoppingCart, FileText, Globe,
} from "lucide-react";

export const metadata = { title: "Detail Tenant — AODP" };

const PLAN_BADGE: Record<string, string> = {
  trial: "bg-gray-100 text-gray-600", starter: "bg-blue-100 text-blue-700",
  professional: "bg-purple-100 text-purple-700", enterprise: "bg-amber-100 text-amber-700",
};
const PLAN_LABEL: Record<string, string> = {
  trial: "Trial", starter: "Starter", professional: "Professional", enterprise: "Enterprise",
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface Company {
  id: string; name: string; slug: string; domain: string | null;
  logo_url: string | null; settings: Record<string, string>;
  subscription_plan: string; subscription_status: string;
  is_active: boolean; created_at: string; updated_at: string;
}

interface TenantUserRow {
  id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  user_roles: { roles: { name: string } | null }[] | null;
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner", admin: "Admin", sales: "Sales", manager: "Manager",
  finance: "Finance", warehouse: "Warehouse", driver: "Driver", super_admin: "Super Admin",
};

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();
  if (!user.roles.includes("super_admin")) redirect("/dashboard");

  const supabase = getAdminClient();

  const [companyResult, statsResult, tenantUsersResult] = await Promise.all([
    supabase.from("companies").select("*").eq("id", id).single(),
    Promise.all([
      supabase.from("users").select("id", { count: "exact", head: true }).eq("company_id", id),
      supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", id),
      supabase.from("customers").select("id", { count: "exact", head: true }).eq("company_id", id),
      supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("company_id", id),
      supabase.from("import_templates").select("id", { count: "exact", head: true }).eq("company_id", id).eq("is_active", true),
      supabase.from("settings").select("id", { count: "exact", head: true }).eq("company_id", id),
    ]),
    supabase
      .from("users")
      .select("id, full_name, email, is_active, user_roles(roles(name))")
      .eq("company_id", id)
      .order("created_at", { ascending: true }),
  ]);

  if (!companyResult.data) notFound();

  const company = companyResult.data as unknown as Company;
  const tenantUsers = (tenantUsersResult.data ?? []) as unknown as TenantUserRow[];
  const [usersR, productsR, customersR, ordersR, importsR, settingsR] = statsResult;

  const userCount     = usersR.count ?? 0;
  const productCount  = productsR.count ?? 0;
  const customerCount = customersR.count ?? 0;
  const orderCount    = ordersR.count ?? 0;
  const importCount   = importsR.count ?? 0;
  const settingCount  = settingsR.count ?? 0;

  const checklistItems = [
    {
      key: "company_created", label: "Perusahaan didaftarkan", done: true,
      description: `Tenant "${company.name}" berhasil dibuat`,
    },
    {
      key: "first_user", label: "User pertama (Owner) dibuat", done: userCount > 0,
      description: userCount > 0 ? `${userCount} user terdaftar` : "Buat akun owner agar tenant dapat login",
    },
    {
      key: "products", label: "Minimal 1 produk ditambahkan", done: productCount > 0,
      description: productCount > 0 ? `${productCount} produk` : "Import atau tambah produk secara manual",
    },
    {
      key: "customers", label: "Minimal 1 pelanggan ditambahkan", done: customerCount > 0,
      description: customerCount > 0 ? `${customerCount} pelanggan` : "Import atau tambah pelanggan secara manual",
    },
    {
      key: "settings", label: "Pengaturan perusahaan dikonfigurasi", done: settingCount > 0,
      description: settingCount > 0 ? "Settings terkonfigurasi" : "Lengkapi pengaturan dasar tenant",
    },
    {
      key: "import_template", label: "Template import dikonfigurasi", done: importCount > 0,
      description: importCount > 0 ? `${importCount} template import` : "Opsional — buat mapping import Excel/CSV",
      warning: true,
    },
  ];

  const settings = company.settings as Record<string, string>;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Breadcrumb + Actions */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <Link href="/dashboard/platform/tenants"
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Tenant
        </Link>
        <Link href={`/dashboard/platform/tenants/${id}/edit`}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Edit2 className="h-4 w-4" />
          Edit Tenant
        </Link>
      </div>

      {/* Header */}
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl text-xl font-bold text-white shrink-0"
            style={{ backgroundColor: settings?.brand_color ?? "#2563EB" }}>
            {company.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900">{company.name}</h1>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${PLAN_BADGE[company.subscription_plan] ?? "bg-gray-100"}`}>
                {PLAN_LABEL[company.subscription_plan] ?? company.subscription_plan}
              </span>
              {company.is_active ? (
                <span className="flex items-center gap-1 text-xs text-green-600">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Aktif
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-red-500">
                  <XCircle className="h-3.5 w-3.5" /> Tidak Aktif
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
              <span className="font-mono text-xs">{company.slug}</span>
              {company.domain && (
                <>
                  <span>·</span>
                  <span className="flex items-center gap-1">
                    <Globe className="h-3.5 w-3.5" />
                    {company.domain}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { icon: <Users className="h-4 w-4 text-blue-500" />, label: "User", count: userCount },
          { icon: <Package className="h-4 w-4 text-green-500" />, label: "Produk", count: productCount },
          { icon: <Building2 className="h-4 w-4 text-purple-500" />, label: "Pelanggan", count: customerCount },
          { icon: <ShoppingCart className="h-4 w-4 text-orange-500" />, label: "Orders", count: orderCount },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-2">{s.icon}<span className="text-xs text-gray-500">{s.label}</span></div>
            <p className="text-xl font-bold text-gray-900">{s.count.toLocaleString("id-ID")}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Onboarding Checklist */}
        <OnboardingChecklist items={checklistItems} />

        {/* Create First User */}
        {userCount === 0 && (
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Users className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-900">Buat User Pertama (Owner)</h2>
            </div>
            <FirstUserForm companyId={id} />
          </div>
        )}

        {/* Kelola User Tenant -- Gate 3E-D2-A-R1: super_admin bisa reset
            password user existing (owner|admin|sales) di sini. Role
            super_admin TIDAK PERNAH ditampilkan dengan kontrol reset
            (baik karena tidak seharusnya muncul dalam daftar tenant-scoped
            ini, maupun sebagai pertahanan berlapis bila suatu saat terjadi). */}
        {userCount > 0 && (
          <div className="rounded-xl border bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Users className="h-4 w-4 text-blue-500" />
              <h2 className="text-sm font-semibold text-gray-900">Kelola User Tenant</h2>
            </div>
            <div className="space-y-3">
              {tenantUsers.map((row) => {
                const roleNames = (row.user_roles ?? [])
                  .map((ur) => ur.roles?.name)
                  .filter((name): name is string => Boolean(name));
                const isSuperAdmin = roleNames.includes("super_admin");
                return (
                  <div key={row.id} className="rounded-lg border border-gray-100 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">{row.full_name}</p>
                        <p className="truncate text-xs text-gray-500">{row.email}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {roleNames.map((name) => (
                            <span key={name} className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                              {ROLE_LABEL[name] ?? name}
                            </span>
                          ))}
                          {row.is_active ? (
                            <span className="text-[11px] text-green-600">Aktif</span>
                          ) : (
                            <span className="text-[11px] text-red-500">Tidak Aktif</span>
                          )}
                        </div>
                      </div>
                      {!isSuperAdmin && row.is_active && (
                        <div className="shrink-0">
                          <ResetTenantUserPasswordButton
                            targetUserId={row.id}
                            fullName={row.full_name}
                            email={row.email}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Settings summary */}
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <FileText className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-900">Konfigurasi</h2>
          </div>
          <div className="space-y-2 text-sm">
            {[
              { label: "Warna Brand",   value: settings?.brand_color },
              { label: "Zona Waktu",    value: settings?.timezone },
              { label: "Mata Uang",     value: settings?.currency },
              { label: "Bahasa",        value: settings?.language === "id" ? "Bahasa Indonesia" : settings?.language },
            ].map((row) => (
              <div key={row.label} className="flex justify-between border-b border-gray-50 pb-2">
                <span className="text-gray-500">{row.label}</span>
                <span className="font-medium text-gray-900">{row.value ?? "—"}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-400">
            <span>Dibuat: {formatDateTime(company.created_at)}</span>
            <span>·</span>
            <span className="font-mono">ID: {company.id}</span>
          </div>
        </div>
      </div>

      {/* Import Templates link */}
      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 p-5 flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-700">Template Import Data</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {importCount > 0 ? `${importCount} template konfigurasi` : "Belum ada template import dikonfigurasi"}
          </p>
        </div>
        <Link href="/dashboard/settings/import"
          className="rounded-lg bg-white border border-gray-200 px-4 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50">
          Kelola Import →
        </Link>
      </div>
    </div>
  );
}
