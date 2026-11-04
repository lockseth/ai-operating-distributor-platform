import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { getAdminClient } from "@/lib/supabase/admin";
import { CLASS_MANAGER_ROLES } from "@/lib/customers/classification";
import { PageHeader } from "@/components/ui/page-header";
import { CustomerClassManager, type ClassRow } from "@/components/customers/customer-class-manager";

export const metadata = { title: "Klasifikasi Pelanggan — AODP" };

export default async function CustomerClassesPage() {
  const user = await getAuthUser();
  if (!hasRole(user.roles, CLASS_MANAGER_ROLES)) redirect("/dashboard/customers");

  const admin = getAdminClient();
  const [{ data: classes }, { data: usage }] = await Promise.all([
    admin.from("customer_classes")
      .select("id, name, default_payment_terms_days, approval_threshold_amount, is_active")
      .eq("company_id", user.company_id).order("name"),
    admin.from("customers").select("class_id").eq("company_id", user.company_id).not("class_id", "is", null),
  ]);
  const counts = new Map<string, number>();
  for (const u of (usage ?? []) as { class_id: string }[]) counts.set(u.class_id, (counts.get(u.class_id) ?? 0) + 1);

  const rows: ClassRow[] = ((classes ?? []) as {
    id: string; name: string; default_payment_terms_days: number | null; approval_threshold_amount: number | null; is_active: boolean;
  }[]).map((c) => ({
    id: c.id, name: c.name, defaultPaymentTermsDays: c.default_payment_terms_days,
    approvalThresholdAmount: c.approval_threshold_amount, isActive: c.is_active, customerCount: counts.get(c.id) ?? 0,
  }));

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-3xl">
      <Link href="/dashboard/customers" className="text-sm text-blue-600">← Kembali ke Pelanggan</Link>
      <PageHeader title="Klasifikasi Pelanggan" subtitle="Tempo bayar mengikuti klasifikasi; sales tidak bisa mengubahnya di order" />
      <CustomerClassManager rows={rows} />
    </div>
  );
}
