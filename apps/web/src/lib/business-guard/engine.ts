// =============================================================================
// Business Guard AI Engine
// Server-side: query riwayat special_price_approval_requests/lines (Gate
// 3E-D4-C1/C2/C3, LOCKED), lalu jalankan detectDiscountAnomaly per sales.
// Read-only -- tidak menyentuh RPC/tabel approval, murni SELECT.
// =============================================================================

import { createClient } from "@/lib/supabase/server";
import {
  detectDiscountAnomaly,
  type DiscountAnomalyResult,
  type SalesDiscountRequest,
} from "./features/discount-anomaly";

const LOOKBACK_DAYS = 180;

type RequestRow = {
  id: string;
  requested_by: string;
  requested_at: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
};

type LineRow = {
  approval_request_id: string;
  implied_discount_percentage: number | null;
};

type UserRoleRow = {
  user: { id: string; full_name: string } | null;
  role: { name: string } | null;
};

export async function generateDiscountAnomalyReport(
  companyId: string,
  now: Date = new Date()
): Promise<DiscountAnomalyResult[]> {
  const supabase = await createClient();
  const lookbackDate = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);

  const [requestsResult, userRolesResult] = await Promise.all([
    supabase
      .from("special_price_approval_requests")
      .select("id, requested_by, requested_at, status")
      .eq("company_id", companyId)
      .gte("requested_at", lookbackDate.toISOString())
      .order("requested_at", { ascending: true }),
    supabase
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", companyId),
  ]);

  const requests = (requestsResult.data ?? []) as unknown as RequestRow[];
  const salesUsers = ((userRolesResult.data ?? []) as unknown as (UserRoleRow & {
    user: { id: string; full_name: string; is_active: boolean } | null;
  })[])
    .filter((r) => r.role?.name === "sales" && r.user?.is_active)
    .map((r) => ({ id: r.user!.id, full_name: r.user!.full_name }));

  if (requests.length === 0) {
    return salesUsers.map((s) =>
      detectDiscountAnomaly(
        { sales_id: s.id, sales_name: s.full_name, requests: [] },
        { avg_requests_per_sales: 0, avg_discount_percentage: 0 },
        now
      )
    );
  }

  const requestIds = requests.map((r) => r.id);
  const { data: lineRows } = await supabase
    .from("special_price_approval_lines")
    .select("approval_request_id, implied_discount_percentage")
    .in("approval_request_id", requestIds);
  const lines = (lineRows ?? []) as unknown as LineRow[];

  // Diskon terdalam per pengajuan (MAX antar baris pada 1 approval_request_id)
  const maxDiscountByRequest = new Map<string, number>();
  lines.forEach((l) => {
    const value = l.implied_discount_percentage ?? 0;
    const current = maxDiscountByRequest.get(l.approval_request_id) ?? 0;
    if (value > current) maxDiscountByRequest.set(l.approval_request_id, value);
  });

  const userMap = new Map(salesUsers.map((s) => [s.id, s.full_name]));

  const bySales = new Map<string, SalesDiscountRequest[]>();
  requests.forEach((r) => {
    if (!bySales.has(r.requested_by)) bySales.set(r.requested_by, []);
    bySales.get(r.requested_by)!.push({
      status: r.status,
      requested_at: r.requested_at,
      max_discount_percentage: maxDiscountByRequest.get(r.id) ?? 0,
    });
  });

  // Pastikan sales aktif tanpa pengajuan sama sekali tetap muncul (risk NONE) --
  // sama seperti generateAllInsights mengembalikan seluruh customer, bukan
  // hanya yang punya order.
  salesUsers.forEach((s) => {
    if (!bySales.has(s.id)) bySales.set(s.id, []);
  });

  const totalRequests = requests.length;
  const salesCountWithActivity = bySales.size;
  const avgRequestsPerSales = salesCountWithActivity > 0 ? totalRequests / salesCountWithActivity : 0;
  const allDiscounts = requests.map((r) => maxDiscountByRequest.get(r.id) ?? 0);
  const avgDiscountPercentage =
    allDiscounts.length > 0 ? allDiscounts.reduce((s, v) => s + v, 0) / allDiscounts.length : 0;

  const peerBaseline = {
    avg_requests_per_sales: avgRequestsPerSales,
    avg_discount_percentage: avgDiscountPercentage,
  };

  const results: DiscountAnomalyResult[] = [];
  bySales.forEach((salesRequests, salesId) => {
    const salesName = userMap.get(salesId) ?? "Sales (tidak dikenal)";
    results.push(detectDiscountAnomaly({ sales_id: salesId, sales_name: salesName, requests: salesRequests }, peerBaseline, now));
  });

  return results.sort((a, b) => {
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
    return order[a.risk_level]! - order[b.risk_level]! || b.total_requests - a.total_requests;
  });
}
