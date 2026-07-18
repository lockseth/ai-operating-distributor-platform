// =============================================================================
// Agenda Hari Ini -- daftar toko dalam akses salesman (assignment langsung
// ATAU area coverage), ditandai sudah/belum dikunjungi hari ini. Query murni
// (join customers + salesman_coverage_areas + sales_calls) -- TIDAK ada
// tabel baru, TIDAK mengubah aturan Call/EC. "assigned_sales_id" menang atas
// "area" kalau toko memenuhi keduanya (mencegah duplikat entry).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface AgendaStore {
  customerId: string;
  name: string;
  area: string | null;
  address: string | null;
  assignmentBasis: "ASSIGNED" | "AREA";
  visitedToday: boolean;
}

export interface AgendaRepository {
  listTodayStores(
    companyId: string,
    salesmanId: string,
    businessDate: string,
  ): Promise<AgendaStore[]>;
}

export class SupabaseAgendaRepository implements AgendaRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listTodayStores(
    companyId: string,
    salesmanId: string,
    businessDate: string,
  ): Promise<AgendaStore[]> {
    const { data: assignedRows } = await this.client
      .from("customers")
      .select("id, name, area, address")
      .eq("company_id", companyId)
      .eq("assigned_sales_id", salesmanId)
      .eq("is_active", true);

    const { data: coverageRows } = await this.client
      .from("salesman_coverage_areas")
      .select("area")
      .eq("company_id", companyId)
      .eq("user_id", salesmanId);
    const areas = ((coverageRows ?? []) as { area: string }[]).map((row) => row.area);

    const byId = new Map<string, { name: string; area: string | null; address: string | null; basis: "ASSIGNED" | "AREA" }>();
    for (const row of (assignedRows ?? []) as { id: string; name: string; area: string | null; address: string | null }[]) {
      byId.set(row.id, { name: row.name, area: row.area, address: row.address, basis: "ASSIGNED" });
    }

    if (areas.length > 0) {
      const { data: areaRows } = await this.client
        .from("customers")
        .select("id, name, area, address")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .in("area", areas);
      for (const row of (areaRows ?? []) as { id: string; name: string; area: string | null; address: string | null }[]) {
        if (byId.has(row.id)) continue;
        byId.set(row.id, { name: row.name, area: row.area, address: row.address, basis: "AREA" });
      }
    }

    if (byId.size === 0) return [];

    const { data: callRows } = await this.client
      .from("sales_calls")
      .select("customer_id")
      .eq("company_id", companyId)
      .eq("salesperson_id", salesmanId)
      .eq("call_date", businessDate)
      .eq("status", "VALID")
      .in("customer_id", Array.from(byId.keys()));
    const visitedIds = new Set(((callRows ?? []) as { customer_id: string }[]).map((row) => row.customer_id));

    return Array.from(byId.entries()).map(([customerId, info]) => ({
      customerId,
      name: info.name,
      area: info.area,
      address: info.address,
      assignmentBasis: info.basis,
      visitedToday: visitedIds.has(customerId),
    }));
  }
}

interface CustomerSeed {
  companyId: string;
  name: string;
  area: string | null;
  address: string | null;
  assignedSalesId: string | null;
  active: boolean;
}

export class InMemoryAgendaRepository implements AgendaRepository {
  private readonly customers = new Map<string, CustomerSeed>();
  private readonly coverageAreas: { companyId: string; salesmanId: string; area: string }[] = [];
  private readonly visitedToday: { companyId: string; salesmanId: string; customerId: string; businessDate: string }[] = [];

  seedCustomer(
    customerId: string,
    companyId: string,
    opts: { name: string; area?: string | null; address?: string | null; assignedSalesId?: string | null; active?: boolean },
  ): void {
    this.customers.set(customerId, {
      companyId,
      name: opts.name,
      area: opts.area ?? null,
      address: opts.address ?? null,
      assignedSalesId: opts.assignedSalesId ?? null,
      active: opts.active ?? true,
    });
  }

  seedCoverageArea(companyId: string, salesmanId: string, area: string): void {
    this.coverageAreas.push({ companyId, salesmanId, area });
  }

  seedVisitedToday(companyId: string, salesmanId: string, customerId: string, businessDate: string): void {
    this.visitedToday.push({ companyId, salesmanId, customerId, businessDate });
  }

  async listTodayStores(
    companyId: string,
    salesmanId: string,
    businessDate: string,
  ): Promise<AgendaStore[]> {
    const areas = this.coverageAreas
      .filter((row) => row.companyId === companyId && row.salesmanId === salesmanId)
      .map((row) => row.area);

    const byId = new Map<string, { basis: "ASSIGNED" | "AREA" }>();
    for (const [id, customer] of this.customers.entries()) {
      if (customer.companyId !== companyId || !customer.active) continue;
      if (customer.assignedSalesId === salesmanId) {
        byId.set(id, { basis: "ASSIGNED" });
      } else if (customer.area && areas.includes(customer.area)) {
        byId.set(id, { basis: "AREA" });
      }
    }

    const visitedIds = new Set(
      this.visitedToday
        .filter(
          (row) =>
            row.companyId === companyId && row.salesmanId === salesmanId && row.businessDate === businessDate,
        )
        .map((row) => row.customerId),
    );

    return Array.from(byId.entries()).map(([customerId, info]) => {
      const customer = this.customers.get(customerId)!;
      return {
        customerId,
        name: customer.name,
        area: customer.area,
        address: customer.address,
        assignmentBasis: info.basis,
        visitedToday: visitedIds.has(customerId),
      };
    });
  }
}
