import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createCompanyAction } from "@/lib/platform/tenant-actions";
import { CompanyForm } from "@/components/platform/company-form";
import { ChevronLeft } from "lucide-react";

export const metadata = { title: "Tambah Tenant — AODP" };

export default async function NewTenantPage() {
  const user = await getAuthUser();
  if (!user.roles.includes("super_admin")) redirect("/dashboard");

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href="/dashboard/platform/tenants" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Tenant
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Tambah Tenant Baru</h1>
        <p className="text-sm text-gray-500 mt-1">Daftarkan perusahaan baru ke AI Operating Distributor Platform</p>
      </div>

      <CompanyForm
        action={createCompanyAction}
        submitLabel="Buat Tenant"
        cancelHref="/dashboard/platform/tenants"
      />
    </div>
  );
}
