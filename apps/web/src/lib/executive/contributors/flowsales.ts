import { createClient } from "@/lib/supabase/server";
import { calcAchievementPct, calcGap } from "@/lib/sales-reports/summary";
import type {
  ExecutiveContributor,
  ModuleContribution,
  HealthComponent,
  ExecutiveKpi,
  ExecutiveInsight,
  ExecutiveAction,
} from "../types";

// =============================================================================
// Contributor: FlowSales AI
// Sumber data: sales_reports (target vs pencapaian) + sales_orders (momentum)
// + users role sales (disiplin lapor).
// =============================================================================

function formatIDR(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `Rp${(n / 1_000_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000_000) return `Rp${(n / 1_000_000).toFixed(1)}jt`;
  if (Math.abs(n) >= 1_000) return `Rp${(n / 1_000).toFixed(0)}rb`;
  return `Rp${n.toLocaleString("id-ID")}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface ReportRow {
  salesperson_id: string;
  report_date: string;
  target_oa: number;
  achieved_oa: number;
  target_revenue: number;
  achieved_revenue: number;
  remaining_working_days: number;
  salesperson: { full_name: string } | null;
}

export const flowsalesContributor: ExecutiveContributor = {
  module: "flowsales",
  moduleLabel: "FlowSales AI",

  async contribute({ companyId }): Promise<ModuleContribution> {
    const supabase = await createClient();

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const day7 = new Date(now.getTime() - 7 * 86400_000);
    const day14 = new Date(now.getTime() - 14 * 86400_000);
    const todayIso = isoDate(now);

    // ── Governed KPI REVENUE (sales_kpi_*) -- SATU-SATUNYA source of truth
    // untuk tile achieved_revenue_month/gap_revenue (Gate 3E-D0-F3). TIDAK
    // lagi dari sales_reports.target_revenue/achieved_revenue (self-report
    // aktivitas, bukan KPI Dashboard Owner -- lihat lock decision #2/#6).
    const activePeriodRes = await supabase
      .from("sales_kpi_periods")
      .select("id, start_date, end_date")
      .eq("company_id", companyId)
      .eq("status", "ACTIVE")
      .maybeSingle();
    const activePeriod = activePeriodRes.data as
      | { id: string; start_date: string; end_date: string }
      | null;

    let governedRevenueTarget = 0;
    let governedRevenueAchieved = 0;
    let hasGovernedRevenueTarget = false;
    if (activePeriod) {
      const definitionRes = await supabase
        .from("sales_kpi_definitions")
        .select("id")
        .eq("company_id", companyId)
        .eq("code", "REVENUE")
        .is("superseded_at", null)
        .maybeSingle();
      const revenueDefinitionId = (definitionRes.data as { id: string } | null)?.id ?? null;

      if (revenueDefinitionId) {
        const [targetsRes, eventsRes] = await Promise.all([
          supabase
            .from("sales_kpi_targets")
            .select("target_value")
            .eq("company_id", companyId)
            .eq("period_id", activePeriod.id)
            .eq("kpi_definition_id", revenueDefinitionId)
            .eq("status", "ACTIVE"),
          supabase
            .from("sales_kpi_achievement_events")
            .select("event_type, value")
            .eq("company_id", companyId)
            .eq("kpi_code", "REVENUE")
            .gte("business_date", activePeriod.start_date)
            .lte("business_date", activePeriod.end_date),
        ]);
        const targetRows = (targetsRes.data ?? []) as { target_value: number }[];
        const eventRows = (eventsRes.data ?? []) as {
          event_type: string;
          value: number | string | null;
        }[];
        hasGovernedRevenueTarget = targetRows.length > 0;
        governedRevenueTarget = targetRows.reduce((s, r) => s + r.target_value, 0);
        governedRevenueAchieved = eventRows.reduce(
          (s, r) => s + (r.event_type === "CREDITED" ? 1 : -1) * Number(r.value ?? 0),
          0,
        );
      }
    }
    const revenueDataInsufficient = !activePeriod || !hasGovernedRevenueTarget;
    const gapRevenueGoverned = calcGap(governedRevenueTarget, governedRevenueAchieved);
    const pctRevenueGoverned =
      hasGovernedRevenueTarget && governedRevenueTarget > 0
        ? calcAchievementPct(governedRevenueTarget, governedRevenueAchieved)
        : null;

    const [reportsRes, ordersTodayRes, orders7Res, ordersPrev7Res, salesUsersRes] =
      await Promise.all([
        supabase
          .from("sales_reports")
          .select(
            "salesperson_id, report_date, target_oa, achieved_oa, target_revenue, achieved_revenue, remaining_working_days, salesperson:users!salesperson_id(full_name)"
          )
          .eq("company_id", companyId)
          .gte("report_date", isoDate(monthStart)),
        supabase
          .from("sales_orders")
          .select("final_amount")
          .eq("company_id", companyId)
          .neq("status", "cancelled")
          .gte("created_at", `${todayIso}T00:00:00`),
        supabase
          .from("sales_orders")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .neq("status", "cancelled")
          .gte("created_at", day7.toISOString()),
        supabase
          .from("sales_orders")
          .select("id", { count: "exact", head: true })
          .eq("company_id", companyId)
          .neq("status", "cancelled")
          .gte("created_at", day14.toISOString())
          .lt("created_at", day7.toISOString()),
        supabase
          .from("users")
          .select("id, full_name, user_roles!user_id(role:roles(name))")
          .eq("company_id", companyId)
          .eq("is_active", true),
      ]);

    const reports = (reportsRes.data ?? []) as unknown as ReportRow[];
    const revenueToday = (ordersTodayRes.data ?? []).reduce(
      (s, o) => s + ((o as { final_amount: number }).final_amount ?? 0),
      0
    );
    const orders7 = orders7Res.count ?? 0;
    const ordersPrev7 = ordersPrev7Res.count ?? 0;

    const salesUsers = (
      (salesUsersRes.data ?? []) as unknown as {
        id: string;
        full_name: string;
        user_roles: { role: { name: string } | null }[];
      }[]
    ).filter((u) => u.user_roles?.some((ur) => ur.role?.name === "sales"));

    // ── Agregat bulan berjalan dari laporan harian (OA saja -- Revenue
    //    memakai governedRevenueTarget/Achieved di atas, Gate Owner BI-A) ──
    const targetOa = reports.reduce((s, r) => s + r.target_oa, 0);
    const achievedOa = reports.reduce((s, r) => s + r.achieved_oa, 0);
    const pctOa = calcAchievementPct(targetOa, achievedOa);

    // Sisa hari kerja: ambil dari laporan terbaru yang mengisinya
    const latestRemaining =
      [...reports].sort((a, b) => b.report_date.localeCompare(a.report_date))[0]
        ?.remaining_working_days ?? 0;

    // ── Disiplin lapor: sales yang mengirim laporan hari ini ──
    const reportedTodayIds = new Set(
      reports.filter((r) => r.report_date === todayIso).map((r) => r.salesperson_id)
    );
    const notReportedToday = salesUsers.filter((u) => !reportedTodayIds.has(u.id));

    // ── Health components ──
    const health: HealthComponent[] = [];

    // Pencapaian Omzet -- governed KPI REVENUE (sales_kpi_*), bukan lagi
    // pctRevenue self-report (Gate Owner BI-A). Digerbangi keberadaan target
    // governed (pctRevenueGoverned !== null), bukan reports.length, supaya
    // health score tetap benar walau belum ada laporan harian bulan ini.
    if (pctRevenueGoverned !== null) {
      health.push({
        key: "sales_achievement",
        label: "Pencapaian Omzet",
        score: Math.min(100, pctRevenueGoverned),
        weight: 3,
        reason: `Omzet tercapai ${formatIDR(governedRevenueAchieved)} dari target ${formatIDR(governedRevenueTarget)} (${pctRevenueGoverned}%)`,
        trend: pctRevenueGoverned >= 100 ? "up" : pctRevenueGoverned >= 70 ? "neutral" : "down",
      });
    }

    if (reports.length > 0) {
      health.push({
        key: "oa_achievement",
        label: "Pencapaian OA",
        score: Math.min(100, pctOa),
        weight: 2,
        reason: `OA tercapai ${achievedOa} dari target ${targetOa} outlet (${pctOa}%)`,
        trend: pctOa >= 100 ? "up" : pctOa >= 70 ? "neutral" : "down",
      });
    }

    if (salesUsers.length > 0) {
      const disciplinePct = Math.round(
        (reportedTodayIds.size / salesUsers.length) * 100
      );
      health.push({
        key: "reporting_discipline",
        label: "Disiplin Lapor",
        score: disciplinePct,
        weight: 1,
        reason: `${reportedTodayIds.size} dari ${salesUsers.length} sales sudah lapor hari ini`,
        trend: disciplinePct >= 80 ? "up" : disciplinePct >= 50 ? "neutral" : "down",
      });
    }

    const momentumScore =
      ordersPrev7 === 0
        ? orders7 > 0
          ? 80
          : 50
        : Math.min(100, Math.round((orders7 / ordersPrev7) * 70));
    health.push({
      key: "order_momentum",
      label: "Momentum Order",
      score: momentumScore,
      weight: 2,
      reason: `${orders7} order 7 hari terakhir vs ${ordersPrev7} order 7 hari sebelumnya`,
      trend: orders7 > ordersPrev7 ? "up" : orders7 < ordersPrev7 ? "down" : "neutral",
    });

    // ── KPI ──
    const kpis: ExecutiveKpi[] = [
      {
        key: "revenue_today",
        label: "Omzet Order Hari Ini",
        value: formatIDR(revenueToday),
        subValue: revenueToday > 0 ? "dari sales order masuk" : "belum ada order hari ini",
        accent: "green",
        trend: revenueToday > 0 ? "up" : "neutral",
        trendLabel: revenueToday > 0 ? "order masuk hari ini" : "pantau perkembangan",
      },
      {
        key: "achieved_revenue_month",
        label: "Omzet Order Periode KPI Aktif",
        value: revenueDataInsufficient ? "Data belum cukup" : formatIDR(governedRevenueAchieved),
        subValue: !activePeriod
          ? "belum ada periode KPI aktif"
          : !hasGovernedRevenueTarget
            ? "target Revenue belum ditetapkan di KPI Setup"
            : `target ${formatIDR(governedRevenueTarget)}`,
        accent: revenueDataInsufficient ? "amber" : "blue",
        trend:
          pctRevenueGoverned === null
            ? "neutral"
            : pctRevenueGoverned >= 100
              ? "up"
              : pctRevenueGoverned >= 70
                ? "neutral"
                : "down",
        trendLabel: pctRevenueGoverned !== null ? `${pctRevenueGoverned}% dari target` : "data belum cukup",
      },
      {
        key: "gap_revenue",
        label: "Gap Omzet",
        value: revenueDataInsufficient
          ? "Target belum ditetapkan"
          : gapRevenueGoverned > 0
            ? formatIDR(gapRevenueGoverned)
            : "Tercapai",
        subValue: !activePeriod
          ? "aktifkan periode KPI untuk memantau gap omzet"
          : !hasGovernedRevenueTarget
            ? "tetapkan target Revenue per Sales di KPI Setup"
            : gapRevenueGoverned > 0
              ? `dari target ${formatIDR(governedRevenueTarget)} (periode berjalan)`
              : "target Revenue periode ini terpenuhi",
        accent: revenueDataInsufficient ? "amber" : gapRevenueGoverned > 0 ? "amber" : "green",
        trend: revenueDataInsufficient ? "neutral" : gapRevenueGoverned > 0 ? "down" : "up",
        trendLabel: revenueDataInsufficient
          ? "data belum cukup"
          : gapRevenueGoverned > 0
            ? "kejar target"
            : "pertahankan",
      },
      {
        key: "oa_month",
        label: "OA Bulan Ini",
        value: `${achievedOa}/${targetOa}`,
        subValue: "outlet aktif tercapai vs target",
        accent: pctOa >= 100 ? "green" : pctOa >= 70 ? "indigo" : "amber",
        trend: pctOa >= 100 ? "up" : "neutral",
        trendLabel: `${pctOa}% pencapaian OA`,
      },
      {
        key: "sales_reported_today",
        label: "Sales Lapor Hari Ini",
        value: `${reportedTodayIds.size}/${salesUsers.length}`,
        subValue:
          notReportedToday.length > 0
            ? `belum: ${notReportedToday.map((u) => u.full_name).slice(0, 3).join(", ")}${notReportedToday.length > 3 ? ", …" : ""}`
            : "semua sales sudah lapor",
        accent: notReportedToday.length === 0 ? "green" : "amber",
        trend: notReportedToday.length === 0 ? "up" : "down",
        trendLabel:
          notReportedToday.length === 0 ? "disiplin penuh" : `${notReportedToday.length} belum lapor`,
      },
      {
        key: "orders_7d",
        label: "Order 7 Hari Terakhir",
        value: orders7.toLocaleString("id-ID"),
        subValue: `vs ${ordersPrev7.toLocaleString("id-ID")} pada 7 hari sebelumnya`,
        accent: orders7 >= ordersPrev7 ? "indigo" : "red",
        trend: orders7 > ordersPrev7 ? "up" : orders7 < ordersPrev7 ? "down" : "neutral",
        trendLabel:
          ordersPrev7 > 0
            ? `${orders7 >= ordersPrev7 ? "+" : ""}${Math.round(((orders7 - ordersPrev7) / ordersPrev7) * 100)}% vs minggu lalu`
            : "belum ada pembanding",
      },
    ];

    // ── Insights & Actions ──
    const insights: ExecutiveInsight[] = [];
    const actions: ExecutiveAction[] = [];

    if (reports.length === 0) {
      insights.push({
        module: "flowsales",
        severity: "warning",
        title: "Belum ada laporan sales bulan ini",
        narrative:
          "Belum ada laporan harian sales yang masuk bulan ini, sehingga pencapaian target belum bisa dipantau.",
      });
      actions.push({
        module: "flowsales",
        priority: "HIGH",
        action: "Minta sales mulai mengisi laporan harian",
        rationale: "Tanpa laporan, target dan gap tidak terpantau",
        href: "/dashboard/reports",
      });
    }

    // Gap/pencapaian omzet -- governed KPI REVENUE (Gate Owner BI-A), bukan
    // lagi pctRevenue/gapRevenue self-report. Digerbangi keberadaan target
    // governed, independen dari reports.length di atas.
    if (pctRevenueGoverned !== null) {
      if (gapRevenueGoverned > 0 && pctRevenueGoverned < 70) {
        insights.push({
          module: "flowsales",
          severity: "critical",
          title: `Pencapaian omzet baru ${pctRevenueGoverned}%`,
          narrative: `Gap omzet ${formatIDR(gapRevenueGoverned)} terhadap target periode KPI aktif${latestRemaining > 0 ? `; dengan sisa ${latestRemaining} hari kerja dibutuhkan ±${formatIDR(Math.ceil(gapRevenueGoverned / latestRemaining))} per hari` : ""}.`,
        });
        actions.push({
          module: "flowsales",
          priority: "URGENT",
          action: "Review pencapaian sales & susun rencana kejar target",
          rationale: `Pencapaian ${pctRevenueGoverned}%, gap ${formatIDR(gapRevenueGoverned)}`,
          href: "/dashboard/reports",
        });
      } else if (gapRevenueGoverned > 0) {
        insights.push({
          module: "flowsales",
          severity: "info",
          title: `Pencapaian omzet ${pctRevenueGoverned}% — on track`,
          narrative: `Sisa gap ${formatIDR(gapRevenueGoverned)}${latestRemaining > 0 ? ` dengan sisa ${latestRemaining} hari kerja` : ""}; ritme saat ini masih memadai.`,
        });
      } else {
        insights.push({
          module: "flowsales",
          severity: "info",
          title: "Target omzet periode KPI aktif tercapai",
          narrative: `Omzet tercapai ${formatIDR(governedRevenueAchieved)} melampaui target ${formatIDR(governedRevenueTarget)}.`,
        });
      }
    }

    if (salesUsers.length > 0 && notReportedToday.length > 0) {
      insights.push({
        module: "flowsales",
        severity: notReportedToday.length === salesUsers.length ? "warning" : "info",
        title: `${notReportedToday.length} sales belum lapor hari ini`,
        narrative: `Yang belum: ${notReportedToday.map((u) => u.full_name).slice(0, 5).join(", ")}${notReportedToday.length > 5 ? ", …" : ""}.`,
      });
      actions.push({
        module: "flowsales",
        priority: "MEDIUM",
        action: `Tagih laporan harian ${notReportedToday.length} sales`,
        rationale: "Data hari ini belum lengkap untuk pantauan",
        href: "/dashboard/reports",
      });
    }

    if (ordersPrev7 > 0 && orders7 < ordersPrev7 * 0.6) {
      insights.push({
        module: "flowsales",
        severity: "warning",
        title: "Momentum order melambat",
        narrative: `Order 7 hari terakhir (${orders7}) turun lebih dari 40% dibanding 7 hari sebelumnya (${ordersPrev7}).`,
      });
      actions.push({
        module: "flowsales",
        priority: "HIGH",
        action: "Cek penyebab penurunan order mingguan",
        rationale: `${orders7} vs ${ordersPrev7} order minggu-ke-minggu`,
        href: "/dashboard/orders",
      });
    }

    return {
      module: "flowsales",
      moduleLabel: "FlowSales AI",
      active: true,
      health,
      kpis,
      insights,
      actions,
    };
  },
};
