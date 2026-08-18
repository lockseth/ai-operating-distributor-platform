import { getAuthUser } from "@/lib/auth/get-user";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { ChartCard } from "@/components/ui/chart-card";
import { EmptyState } from "@/components/ui/empty-state";
import { DataTable } from "@/components/ui/data-table";
import {
  Zap, CheckCircle2, XCircle, Clock, SkipForward,
  Webhook, Play, Settings,
} from "lucide-react";

export const metadata = { title: "Automation — AODP" };

interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  is_active: boolean;
  priority: number;
  run_count: number;
  last_run_at: string | null;
  actions: Array<{ type: string; event?: string; note?: string }>;
}

interface AutomationLog {
  id: string;
  rule_name: string | null;
  trigger_type: string;
  status: string;
  duration_ms: number | null;
  executed_at: string;
}

interface N8nWebhook {
  id: string;
  name: string;
  event_type: string;
  webhook_url: string;
  is_active: boolean;
  call_count: number;
  last_called_at: string | null;
}

const TRIGGER_LABELS: Record<string, string> = {
  customer_dormant: "Reseller Dormant",
  churn_risk: "Churn Risk",
  repeat_order_due: "Repeat Order Due",
  large_order: "Order Besar",
  new_order: "Order Baru",
  low_stock: "Stok Rendah",
  payment_overdue: "Pembayaran Jatuh Tempo",
  new_customer: "Reseller Baru",
  scheduled_daily: "Jadwal Harian",
  scheduled_weekly: "Jadwal Mingguan",
  manual: "Manual",
  special_price_proposal_submitted: "Pengajuan Harga Khusus",
};

const STATUS_STYLES: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
  success: { label: "Berhasil", icon: <CheckCircle2 className="h-3.5 w-3.5" />, cls: "bg-green-100 text-green-700" },
  failed:  { label: "Gagal",    icon: <XCircle className="h-3.5 w-3.5" />,       cls: "bg-red-100 text-red-700" },
  skipped: { label: "Dilewati", icon: <SkipForward className="h-3.5 w-3.5" />,   cls: "bg-gray-100 text-gray-600" },
  pending: { label: "Menunggu", icon: <Clock className="h-3.5 w-3.5" />,          cls: "bg-blue-100 text-blue-700" },
  running: { label: "Berjalan", icon: <Play className="h-3.5 w-3.5" />,           cls: "bg-purple-100 text-purple-700" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES["skipped"]!;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.icon} {s.label}
    </span>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default async function AutomationPage() {
  const user = await getAuthUser();

  if (
    !user.roles.includes("owner") &&
    !user.roles.includes("manager") &&
    !user.roles.includes("admin") &&
    !user.roles.includes("super_admin")
  ) {
    redirect("/dashboard");
  }

  const supabase = await createClient();
  const [rulesResult, logsResult, webhooksResult] = await Promise.all([
    supabase
      .from("automation_rules")
      .select("id, name, description, trigger_type, is_active, priority, run_count, last_run_at, actions")
      .eq("company_id", user.company_id)
      .order("priority", { ascending: false }),

    supabase
      .from("automation_logs")
      .select("id, rule_name, trigger_type, status, duration_ms, executed_at")
      .eq("company_id", user.company_id)
      .order("executed_at", { ascending: false })
      .limit(50),

    supabase
      .from("n8n_webhooks")
      .select("id, name, event_type, webhook_url, is_active, call_count, last_called_at")
      .eq("company_id", user.company_id)
      .order("created_at", { ascending: false }),
  ]);

  const rules = (rulesResult.data ?? []) as unknown as AutomationRule[];
  const logs = (logsResult.data ?? []) as unknown as AutomationLog[];
  const webhooks = (webhooksResult.data ?? []) as unknown as N8nWebhook[];

  const activeRules = rules.filter((r) => r.is_active).length;
  const totalRuns = rules.reduce((s, r) => s + r.run_count, 0);
  const successLogs = logs.filter((l) => l.status === "success").length;

  const ruleColumns = [
    {
      key: "name",
      label: "Nama Rule",
      render: (r: AutomationRule) => (
        <div>
          <p className="font-medium text-gray-900">{r.name}</p>
          <p className="text-xs text-gray-400">{r.description?.slice(0, 80) ?? ""}</p>
        </div>
      ),
    },
    {
      key: "trigger",
      label: "Trigger",
      render: (r: AutomationRule) => (
        <span className="inline-flex rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
          {TRIGGER_LABELS[r.trigger_type] ?? r.trigger_type}
        </span>
      ),
    },
    {
      key: "actions",
      label: "Aksi",
      render: (r: AutomationRule) => (
        <div className="flex flex-wrap gap-1">
          {r.actions.map((a, i) => (
            <span key={i} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
              {a.type === "call_n8n" ? "→ n8n" : a.type === "log" ? "📝 Log" : a.type}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (r: AutomationRule) => (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${r.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
          {r.is_active ? "Aktif" : "Nonaktif"}
        </span>
      ),
    },
    {
      key: "runs",
      label: "Dijalankan",
      align: "right" as const,
      render: (r: AutomationRule) => (
        <div className="text-right">
          <p className="font-semibold text-gray-900">{r.run_count}×</p>
          <p className="text-xs text-gray-400">{formatDate(r.last_run_at).split(",")[0] ?? "—"}</p>
        </div>
      ),
    },
  ];

  const logColumns = [
    {
      key: "rule",
      label: "Rule",
      render: (l: AutomationLog) => (
        <span className="font-medium text-gray-900 text-sm">{l.rule_name ?? "—"}</span>
      ),
    },
    {
      key: "trigger",
      label: "Trigger",
      render: (l: AutomationLog) => (
        <span className="text-xs text-gray-500">{TRIGGER_LABELS[l.trigger_type] ?? l.trigger_type}</span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (l: AutomationLog) => <StatusPill status={l.status} />,
    },
    {
      key: "duration",
      label: "Durasi",
      align: "right" as const,
      render: (l: AutomationLog) => (
        <span className="text-xs text-gray-400">{l.duration_ms ? `${l.duration_ms}ms` : "—"}</span>
      ),
    },
    {
      key: "time",
      label: "Waktu",
      align: "right" as const,
      render: (l: AutomationLog) => (
        <span className="text-xs text-gray-400">{formatDate(l.executed_at)}</span>
      ),
    },
  ];

  const webhookColumns = [
    {
      key: "name",
      label: "Nama Webhook",
      render: (w: N8nWebhook) => (
        <div>
          <p className="font-medium text-gray-900">{w.name}</p>
          <p className="text-xs text-gray-400 font-mono">{w.webhook_url.slice(0, 50)}…</p>
        </div>
      ),
    },
    {
      key: "event",
      label: "Event Type",
      render: (w: N8nWebhook) => (
        <span className="text-xs rounded bg-blue-50 text-blue-700 px-1.5 py-0.5">
          {TRIGGER_LABELS[w.event_type] ?? w.event_type}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (w: N8nWebhook) => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${w.is_active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>
          {w.is_active ? "Aktif" : "Nonaktif"}
        </span>
      ),
    },
    {
      key: "calls",
      label: "Dipanggil",
      align: "right" as const,
      render: (w: N8nWebhook) => (
        <div className="text-right">
          <p className="font-semibold text-gray-900">{w.call_count}×</p>
          <p className="text-xs text-gray-400">{formatDate(w.last_called_at).split(",")[0] ?? "—"}</p>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Automation Engine"
        subtitle="Otomatisasi berbasis event — terintegrasi dengan n8n & WhatsApp"
      >
        <div className="flex items-center gap-2 rounded-full bg-purple-50 border border-purple-200 px-3 py-1.5">
          <Zap className="h-4 w-4 text-purple-600" />
          <span className="text-xs font-medium text-purple-700">n8n Powered</span>
        </div>
      </PageHeader>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="h-4 w-4 text-purple-500" />
            <span className="text-xs text-gray-500">Rule Aktif</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{activeRules}</p>
          <p className="text-xs text-gray-400 mt-1">dari {rules.length} rule terdaftar</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <Play className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-gray-500">Total Eksekusi</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{totalRuns}</p>
          <p className="text-xs text-gray-400 mt-1">dari semua rule</p>
        </div>
        <div className="rounded-xl border bg-white p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span className="text-xs text-gray-500">Berhasil (50 terakhir)</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{successLogs}</p>
          <p className="text-xs text-gray-400 mt-1">dari {logs.length} log tercatat</p>
        </div>
      </div>

      {/* Setup Guide */}
      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
        <div className="flex items-start gap-3">
          <Webhook className="h-5 w-5 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-blue-900 mb-1">Cara Menghubungkan n8n</p>
            <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
              <li>Buat workflow baru di n8n dengan node <strong>Webhook</strong> sebagai trigger</li>
              <li>Salin URL webhook dari n8n (format: <code className="bg-blue-100 rounded px-1 text-xs">https://n8n.domain.com/webhook/xxx</code>)</li>
              <li>Daftarkan URL di menu <strong>Pengaturan → Automation → Tambah Webhook</strong></li>
              <li>AODP akan otomatis mengirim event ke n8n sesuai rule yang aktif</li>
              <li>Di n8n, sambungkan ke node WhatsApp, Email, Slack, atau lainnya</li>
            </ol>
            <p className="text-xs text-blue-600 mt-2">
              Inbound webhook (n8n → AODP): <code className="bg-blue-100 rounded px-1">POST /api/webhooks/n8n</code>
            </p>
          </div>
        </div>
      </div>

      {/* Automation Rules */}
      <ChartCard
        title="Automation Rules"
        description="Daftar aturan otomatisasi yang aktif di perusahaan ini"
        badge={`${activeRules} aktif`}
        action={
          <span className="flex items-center gap-1 text-xs text-gray-400">
            <Settings className="h-3.5 w-3.5" /> Kelola rule di Pengaturan
          </span>
        }
      >
        {rules.length === 0 ? (
          <EmptyState
            icon={<Zap className="h-8 w-8 text-gray-300" />}
            title="Belum ada automation rule"
            description="Buat rule pertama di menu Pengaturan > Automation"
          />
        ) : (
          <DataTable<AutomationRule>
            columns={ruleColumns}
            data={rules}
            keyExtractor={(r) => r.id}
            emptyTitle="Tidak ada rule"
            compact
          />
        )}
      </ChartCard>

      {/* n8n Webhooks */}
      <ChartCard
        title="n8n Webhooks Terdaftar"
        description="URL webhook yang digunakan untuk mengirim event ke n8n"
        badge={`${webhooks.length} webhook`}
      >
        {webhooks.length === 0 ? (
          <EmptyState
            icon={<Webhook className="h-8 w-8 text-gray-300" />}
            title="Belum ada webhook terdaftar"
            description="Daftarkan URL webhook n8n di Pengaturan > Automation untuk mulai integrasi"
          />
        ) : (
          <DataTable<N8nWebhook>
            columns={webhookColumns}
            data={webhooks}
            keyExtractor={(w) => w.id}
            emptyTitle="Tidak ada webhook"
            compact
          />
        )}
      </ChartCard>

      {/* Execution Logs */}
      <ChartCard
        title="Log Eksekusi"
        description="50 eksekusi terakhir dari semua automation rules"
        badge={`${logs.length} log`}
      >
        {logs.length === 0 ? (
          <EmptyState
            icon={<Clock className="h-8 w-8 text-gray-300" />}
            title="Belum ada log eksekusi"
            description="Log akan muncul setelah automation rules pertama kali dijalankan"
          />
        ) : (
          <DataTable<AutomationLog>
            columns={logColumns}
            data={logs}
            keyExtractor={(l) => l.id}
            emptyTitle="Tidak ada log"
            compact
          />
        )}
      </ChartCard>
    </div>
  );
}
