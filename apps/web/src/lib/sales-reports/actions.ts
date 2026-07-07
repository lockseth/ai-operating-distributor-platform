"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import { logAuditEvent } from "@/lib/actions/audit";
import { buildAiSummaryPlaceholder } from "./summary";

export interface SalesReportItemInput {
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string;
  value: number;
}

export interface SalesReportFormData {
  report_date: string;
  salesperson_id: string;
  area: string | null;
  target_oa: number;
  achieved_oa: number;
  target_revenue: number;
  achieved_revenue: number;
  remaining_working_days: number;
  discount_amount: number;
  notes: string | null;
  items: SalesReportItemInput[];
}

const MANAGE_ROLES = ["owner", "manager", "admin", "super_admin"];

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

  const totalValue = data.items.reduce((s, i) => s + i.value, 0);
  const discount   = Math.min(Math.max(0, data.discount_amount ?? 0), totalValue);
  const grandTotal = totalValue - discount;

  const supabase = await createClient();

  const { data: report, error: reportError } = await supabase
    .from("sales_reports")
    .insert({
      company_id:             user.company_id,
      salesperson_id:         salespersonId,
      report_date:            data.report_date,
      area:                   data.area?.trim() || null,
      target_oa:              data.target_oa ?? 0,
      achieved_oa:            data.achieved_oa ?? 0,
      target_revenue:         data.target_revenue ?? 0,
      achieved_revenue:       data.achieved_revenue ?? 0,
      remaining_working_days: data.remaining_working_days ?? 0,
      discount_amount:        discount,
      total_value:            totalValue,
      grand_total:            grandTotal,
      notes:                  data.notes?.trim() || null,
      ai_summary:             buildAiSummaryPlaceholder(data),
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

  const validItems = data.items.filter((i) => i.product_name.trim() && i.quantity > 0);
  if (validItems.length > 0) {
    const { error: itemsError } = await supabase.from("sales_report_items").insert(
      validItems.map((item) => ({
        sales_report_id:       report.id,
        product_id:            item.product_id || null,
        product_name_snapshot: item.product_name.trim(),
        quantity:              item.quantity,
        unit:                  item.unit || "pcs",
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
      achieved_revenue: data.achieved_revenue,
      grand_total:      grandTotal,
    },
  }).catch(() => {});

  revalidatePath("/dashboard/reports");
  redirect(`/dashboard/reports/${report.id}`);
}
