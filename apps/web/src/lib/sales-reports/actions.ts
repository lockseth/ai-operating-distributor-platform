"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";
import { buildAiSummaryPlaceholder } from "./summary";
import {
  getDailyGovernedKpiSummary,
  getDailySoldItems,
  type DailyGovernedKpiSummary,
  type DailySoldItem,
} from "./queries";

export interface SalesReportFormData {
  report_date: string;
  salesperson_id: string;
  area: string | null;
  remaining_working_days: number;
  notes: string | null;
}

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];

/**
 * Gate P4.03 — dipanggil form (client) tiap report_date/salesperson_id
 * berubah, supaya panel "Ringkasan KPI Hari Ini" selalu menampilkan hari
 * yang benar. Read-only, tidak menulis apa pun.
 */
export async function getDailyReportPreviewAction(
  salespersonId: string,
  reportDate: string
): Promise<{ kpi: DailyGovernedKpiSummary; items: DailySoldItem[] }> {
  const user = await getAuthUser();
  const canReportForOthers = user.roles.some((r) => MANAGE_ROLES.includes(r));
  const effectiveSalespersonId = canReportForOthers ? salespersonId : user.id;
  if (!effectiveSalespersonId || !reportDate) {
    return { kpi: { call: 0, effectiveCall: 0, orderCount: 0, revenue: 0, noo: 0 }, items: [] };
  }

  const [kpi, items] = await Promise.all([
    getDailyGovernedKpiSummary(user.company_id, effectiveSalespersonId, reportDate),
    getDailySoldItems(user.company_id, effectiveSalespersonId, reportDate),
  ]);
  return { kpi, items };
}

export async function createSalesReportAction(data: SalesReportFormData): Promise<void> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "reports.create")) {
    throw new Error("Tidak punya akses untuk membuat laporan sales");
  }

  // Sales hanya boleh melapor atas nama dirinya sendiri
  const canReportForOthers = user.roles.some((r) => MANAGE_ROLES.includes(r));
  const salespersonId = canReportForOthers ? data.salesperson_id : user.id;
  if (!salespersonId) throw new Error("Salesperson harus dipilih");
  if (!data.report_date) throw new Error("Tanggal laporan harus diisi");

  // Gate P4.03: angka KPI TIDAK pernah dipercaya dari client -- dihitung
  // ulang di server dari ledger governed yang sama dengan dashboard Owner
  // (sales_kpi_achievement_events), supaya tidak ada 2 sumber kebenaran dan
  // tidak bisa dimanipulasi lewat payload form.
  const supabase = await createClient();
  const [kpi, soldItems] = await Promise.all([
    getDailyGovernedKpiSummary(user.company_id, salespersonId, data.report_date),
    getDailySoldItems(user.company_id, salespersonId, data.report_date),
  ]);

  const totalValue = soldItems.reduce((s, i) => s + i.value, 0);

  const { data: report, error: reportError } = await supabase
    .from("sales_reports")
    .insert({
      company_id:             user.company_id,
      salesperson_id:         salespersonId,
      report_date:            data.report_date,
      area:                   data.area?.trim() || null,
      // Tidak ada konsep "target harian" di governed KPI (target-nya
      // periode/bulanan) -- 0 = jujur "belum ada target", bukan dikarang.
      target_oa:              0,
      achieved_oa:            kpi.orderCount,
      target_revenue:         0,
      achieved_revenue:       kpi.revenue,
      remaining_working_days: data.remaining_working_days ?? 0,
      discount_amount:        0,
      total_value:            totalValue,
      grand_total:            totalValue,
      notes:                  data.notes?.trim() || null,
      ai_summary:             buildAiSummaryPlaceholder({
        call: kpi.call, effectiveCall: kpi.effectiveCall, orderCount: kpi.orderCount,
        revenue: kpi.revenue, noo: kpi.noo,
        remaining_working_days: data.remaining_working_days ?? 0,
        area: data.area,
      }),
      created_by:             user.id,
    })
    .select("id")
    .single();

  if (reportError) {
    if (reportError.code === "23505") {
      throw new Error("Laporan untuk sales dan tanggal tersebut sudah ada");
    }
    throw new Error(reportError.message);
  }

  if (soldItems.length > 0) {
    const { error: itemsError } = await supabase.from("sales_report_items").insert(
      soldItems.map((item) => ({
        sales_report_id:       report.id,
        product_id:            item.product_id,
        product_name_snapshot: item.product_name,
        quantity:              item.quantity,
        unit:                  item.unit,
        value:                 item.value,
      }))
    );
    if (itemsError) {
      await supabase.from("sales_reports").delete().eq("id", report.id);
      throw new Error(itemsError.message);
    }
  }

  await logAuditEvent({
    company_id:  user.company_id,
    user_id:     user.id,
    action:      "sales_report.create",
    entity_type: "sales_reports",
    entity_id:   report.id,
    new_data: {
      report_date:      data.report_date,
      salesperson_id:   salespersonId,
      achieved_revenue: kpi.revenue,
      grand_total:      totalValue,
    },
  }).catch(() => {});

  revalidatePath("/dashboard/reports");
  redirect(`/dashboard/reports/${report.id}`);
}
