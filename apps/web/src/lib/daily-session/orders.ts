// =============================================================================
// Order confirmed hari ini -- untuk End-of-Day Summary. Sumber authoritative
// SEKARANG sales_orders.confirmed_at (kolom additive, diisi trigger DB
// trg_sales_orders_set_confirmed_at -- lihat migration
// 20260811000001_flowsales_daily_loop_closure.sql), BUKAN created_at::date
// lagi (limitation lama sudah ditutup).
//
// Kecocokan business date memakai businessDateJakarta() (helper timezone
// authoritative yang sudah ada, lib/n8n-automation/timezone.ts -- TIDAK
// diedit, hanya diimpor) sebagai satu-satunya sumber kebenaran "tanggal
// Jakarta dari timestamp". Query DB di bawah hanya melebarkan jendela +-1
// hari kalender UTC sebagai PRE-FILTER murni (bukan penentu kecocokan) --
// exact match tetap businessDateJakarta(confirmed_at) === businessDate,
// dihitung di app layer. Ini menghindari "offset manual" (+7 jam) yang
// dilarang untuk perhitungan authoritative.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { businessDateJakarta } from "@/lib/n8n-automation/timezone";

export interface TodayOrdersRepository {
  countConfirmedToday(companyId: string, salesmanId: string, businessDate: string): Promise<number>;
}

function addDaysIso(isoDate: string, deltaDays: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export class SupabaseTodayOrdersRepository implements TodayOrdersRepository {
  constructor(private readonly client: SupabaseClient) {}

  async countConfirmedToday(companyId: string, salesmanId: string, businessDate: string): Promise<number> {
    // Jendela pre-filter -1/+1 hari kalender UTC -- selalu mencakup seluruh
    // hari Jakarta manapun (Jakarta = UTC+7, tidak pernah keluar dari
    // [businessDate-1, businessDate+1) dalam representasi UTC). Bukan
    // penentu kecocokan akhir -- lihat filter exact match di bawah.
    const { data } = await this.client
      .from("sales_orders")
      .select("confirmed_at")
      .eq("company_id", companyId)
      .eq("sales_id", salesmanId)
      .eq("status", "confirmed")
      .not("confirmed_at", "is", null)
      .gte("confirmed_at", `${addDaysIso(businessDate, -1)}T00:00:00Z`)
      .lt("confirmed_at", `${addDaysIso(businessDate, 1)}T00:00:00Z`);

    const rows = (data ?? []) as { confirmed_at: string }[];
    return rows.filter((row) => businessDateJakarta(new Date(row.confirmed_at)) === businessDate).length;
  }
}

interface OrderSeed {
  companyId: string;
  salesmanId: string;
  status: string;
  /** ISO datetime (bukan tanggal) -- null kalau belum pernah confirmed ATAU historical (tidak dikarang). */
  confirmedAt: string | null;
}

export class InMemoryTodayOrdersRepository implements TodayOrdersRepository {
  private readonly orders: OrderSeed[] = [];

  /** confirmedAt: ISO datetime (mis. "2026-08-10T23:30:00Z"), atau null jika belum/tidak pernah confirmed. */
  seedOrder(companyId: string, salesmanId: string, status: string, confirmedAt: string | null): void {
    this.orders.push({ companyId, salesmanId, status, confirmedAt });
  }

  async countConfirmedToday(companyId: string, salesmanId: string, businessDate: string): Promise<number> {
    return this.orders.filter(
      (o) =>
        o.companyId === companyId &&
        o.salesmanId === salesmanId &&
        o.status === "confirmed" &&
        o.confirmedAt !== null &&
        businessDateJakarta(new Date(o.confirmedAt)) === businessDate,
    ).length;
  }
}
