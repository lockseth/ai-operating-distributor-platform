import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { ImportWizard } from "@/components/imports/import-wizard";

export const metadata = { title: "Import Data — AODP" };

export default async function NewImportPage() {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.execute")) redirect("/dashboard/imports");

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <Link href="/dashboard/imports" className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ChevronLeft className="h-4 w-4" /> Kembali ke Import
      </Link>
      <div>
        <h1 className="text-xl font-bold text-gray-900">Import Data</h1>
        <p className="text-sm text-gray-500 mt-1">Migrasikan data lama atau masukkan data operasional secara massal.</p>
      </div>
      <ImportWizard />
    </div>
  );
}
