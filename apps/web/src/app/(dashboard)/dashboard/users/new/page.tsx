import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getAuthUser } from "@/lib/auth/get-user";
import { AddTenantUserForm } from "@/components/users/add-tenant-user-form";

export const metadata = { title: "Tambah Pengguna — AODP" };

// Gate 3E-C-C2-B3 -- halaman ini adalah SATU-SATUNYA entry point pembuatan
// user tenant baru (admin | sales), owner-only -- sama persis dengan gating
// createTenantUserAction (isOwnerActor, tenant-users/actions.ts). Tidak ada
// MANAGE_ROLES/canManageSalesman di sini -- manager/admin/super_admin TIDAK
// pernah boleh membuka halaman ini, konsisten dengan kontrak backend yang
// menolak mereka di RPC provision_owner_created_tenant_user.
export default async function NewTenantUserPage() {
  const user = await getAuthUser();
  const isOwner = user.roles.includes("owner");

  if (!isOwner) redirect("/dashboard/users");

  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="mb-5 flex items-center gap-2 text-sm text-gray-500">
        <Link href="/dashboard/users" className="flex items-center gap-1 hover:text-gray-700">
          <ChevronLeft className="h-4 w-4" />
          Kembali ke Pengguna
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Tambah Pengguna</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pengguna baru (Admin atau Sales) akan tercatat pada {user.company.name} dengan
          password sementara. Wajib ganti password saat login pertama.
        </p>
      </div>

      <AddTenantUserForm />
    </div>
  );
}
