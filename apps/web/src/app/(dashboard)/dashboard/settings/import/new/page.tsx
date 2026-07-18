import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createImportTemplateAction } from "@/lib/settings/import-actions";
import { ImportTemplateForm } from "@/components/settings/import-template-form";
import { LegacyImportDeprecationBanner } from "@/components/settings/legacy-import-deprecation-banner";
import { ChevronLeft } from "lucide-react";

export const metadata = { title: "Buat Template Import — AODP" };

export default async function NewImportTemplatePage() {
  const user = await getAuthUser();

  const hasAccess = user.roles.includes("super_admin") || user.roles.includes("owner") ||
    user.roles.includes("manager") || user.roles.includes("admin") ||
    user.permissions.includes("settings.manage");

  if (!hasAccess) redirect("/dashboard/settings/import");

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <LegacyImportDeprecationBanner />
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-5">
        <Link href="/dashboard/settings/import" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Import Template
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Buat Template Import Baru</h1>
        <p className="text-sm text-gray-500 mt-1">
          Petakan kolom file Excel/CSV ke field sistem untuk import data yang lebih mudah.
        </p>
      </div>

      <ImportTemplateForm
        action={createImportTemplateAction}
        submitLabel="Simpan Template"
        cancelHref="/dashboard/settings/import"
      />
    </div>
  );
}
