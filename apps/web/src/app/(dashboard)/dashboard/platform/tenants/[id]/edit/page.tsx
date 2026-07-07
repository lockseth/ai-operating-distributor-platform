import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { getAuthUser } from "@/lib/auth/get-user";
import { updateCompanyAction } from "@/lib/platform/tenant-actions";
import { CompanyForm } from "@/components/platform/company-form";
import { ChevronLeft } from "lucide-react";
import type { CompanyFormData } from "@/lib/platform/tenant-actions";

export const metadata = { title: "Edit Tenant — AODP" };

export default async function EditTenantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user   = await getAuthUser();
  if (!user.roles.includes("super_admin")) redirect("/dashboard");

  const supabase = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data } = await supabase
    .from("companies")
    .select("id, name, slug, domain, subscription_plan, settings")
    .eq("id", id)
    .single();

  if (!data) notFound();

  const company = data as unknown as {
    id: string; name: string; slug: string; domain: string | null;
    subscription_plan: string; settings: Record<string, string>;
  };

  const initialData: CompanyFormData = {
    name:              company.name,
    slug:              company.slug,
    domain:            company.domain,
    subscription_plan: company.subscription_plan as CompanyFormData["subscription_plan"],
    settings: {
      brand_color: company.settings?.brand_color ?? "#2563EB",
      timezone:    company.settings?.timezone    ?? "Asia/Jakarta",
      currency:    company.settings?.currency    ?? "IDR",
      language:    company.settings?.language    ?? "id",
    },
  };

  const boundAction = updateCompanyAction.bind(null, id);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href={`/dashboard/platform/tenants/${id}`} className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Detail Tenant
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Edit Tenant</h1>
        <p className="text-sm text-gray-500 mt-1">
          Mengedit: <span className="font-medium text-gray-700">{company.name}</span>
          <span className="ml-2 font-mono text-gray-400 text-xs">{company.slug}</span>
        </p>
      </div>

      <CompanyForm
        initialData={initialData}
        action={boundAction}
        submitLabel="Simpan Perubahan"
        cancelHref={`/dashboard/platform/tenants/${id}`}
      />
    </div>
  );
}
