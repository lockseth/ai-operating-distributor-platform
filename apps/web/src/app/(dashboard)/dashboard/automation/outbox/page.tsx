import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasRole } from "@/lib/auth/permissions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { AutomationJobList } from "@/components/automation/automation-job-list";
import { listAutomationJobsAction } from "@/lib/n8n-automation/actions";

export const metadata = { title: "Automation Outbox — AODP" };

export default async function AutomationOutboxPage() {
  const user = await getAuthUser();

  const canView = hasRole(user.roles, ["owner", "manager", "super_admin"]);
  if (!canView) redirect("/dashboard");

  const result = await listAutomationJobsAction();

  return (
    <div>
      <PageHeader
        title="Automation Outbox (n8n)"
        subtitle="Antrian notifikasi (Morning Brief, KPI Daily Summary) yang diproses n8n lewat internal API. n8n hanya orchestration/delivery -- seluruh isi pesan dihitung service AODP, bukan modul Automation Engine (rule-based) yang terpisah."
      />

      {!result.ok || !result.jobs || result.jobs.length === 0 ? (
        <EmptyState
          title="Belum ada automation job"
          description="Job akan muncul di sini setelah n8n memanggil endpoint generate Morning Brief/KPI Daily Summary."
        />
      ) : (
        <AutomationJobList initialJobs={result.jobs} />
      )}
    </div>
  );
}
