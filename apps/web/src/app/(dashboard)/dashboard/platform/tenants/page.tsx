import Link from "next/link";
import { redirect } from "next/navigation";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { PageHeader } from "@/components/ui/page-header";
import { Plus, Building2, CheckCircle2, XCircle } from "lucide-react";

export const metadata = { title: "Tenant Management — AODP" };

const PLAN_BADGE: Record<string, string> = {
  trial:        "bg-gray-100 text-gray-600",
  starter:      "bg-blue-100 text-blue-700",
  professional: "bg-purple-100 text-purple-700",
  enterprise:   "bg-amber-100 text-amber-700",
};

const PLAN_LABEL: Record<string, string> = {
  trial: "Trial", starter: "Starter", professional: "Pro", enterprise: "Enterprise",
};

interface Company {
  id: string;
  name: string;
  slug: string;
  subscription_plan: string;
  subscription_status: string;
  is_active: boolean;
  created_at: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export default async function TenantListPage() {
  const user = await getAuthUser();
  if (!user.roles.includes("super_admin")) redirect("/dashboard");

  const supabase = getAdminClient();

  const { data } = await supabase
    .from("companies")
    .select("id, name, slug, subscription_plan, subscription_status, is_active, created_at")
    .order("created_at", { ascending: false });

  const companies = (data ?? []) as Company[];

  return (
    <div className="p-6 space-y-5">
      <PageHeader title="Manajemen Tenant" subtitle="Daftar semua perusahaan yang terdaftar di platform">
        <Link href="/dashboard/platform/tenants/new"
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" />
          Tambah Tenant
        </Link>
      </PageHeader>

      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        {companies.length === 0 ? (
          <div className="p-12 text-center">
            <Building2 className="h-10 w-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Belum ada tenant terdaftar</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="px-5 py-3 text-left text-xs font-medium text-gray-500">Perusahaan</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Slug</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Plan</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Dibuat</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {companies.map((c) => (
                <tr key={c.id} className="group hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 text-blue-700 text-xs font-bold shrink-0">
                        {c.name.charAt(0)}
                      </div>
                      <span className="font-medium text-gray-900">{c.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-gray-500">{c.slug}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PLAN_BADGE[c.subscription_plan] ?? "bg-gray-100 text-gray-600"}`}>
                      {PLAN_LABEL[c.subscription_plan] ?? c.subscription_plan}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {c.is_active ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500 mx-auto" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400 mx-auto" />
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatDate(c.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/dashboard/platform/tenants/${c.id}`}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 opacity-0 group-hover:opacity-100 transition-opacity">
                      Detail →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
