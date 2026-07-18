// =============================================================================
// Pengiriman Hari Ini -- daftar delivery yang menjadi tanggung jawab salesman
// (salesman merangkap pengirim, assigned_driver_id = salesman sendiri),
// difilter ke status NON-TERMINAL saja (isTerminalStatus dari lib/delivery/
// types.ts, TIDAK diduplikasi). Query murni -- TIDAK ada tabel baru, TIDAK
// mengubah lib/delivery/*.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { isTerminalStatus, type DeliveryStatus } from "@/lib/delivery/types";

export interface TodayDelivery {
  deliveryId: string;
  salesOrderId: string;
  orderNumber: string;
  customerName: string | null;
  status: DeliveryStatus;
}

export interface TodayDeliveryRepository {
  listTodayDeliveries(companyId: string, salesmanId: string): Promise<TodayDelivery[]>;
  /** SEMUA status (terminal + non-terminal) -- dipakai End-of-Day Summary untuk hitung selesai/pending. */
  listAllAssignedDeliveries(companyId: string, salesmanId: string): Promise<TodayDelivery[]>;
}

export class SupabaseTodayDeliveryRepository implements TodayDeliveryRepository {
  constructor(private readonly client: SupabaseClient) {}

  private async listAssigned(companyId: string, salesmanId: string): Promise<TodayDelivery[]> {
    const { data } = await this.client
      .from("deliveries")
      .select(
        "id, sales_order_id, status, sales_order:sales_orders!sales_order_id(order_number, customer_name_raw, customer:customers!customer_id(name))",
      )
      .eq("company_id", companyId)
      .eq("assigned_driver_id", salesmanId);

    const rows = (data ?? []) as unknown as {
      id: string;
      sales_order_id: string;
      status: DeliveryStatus;
      sales_order: { order_number: string; customer_name_raw: string | null; customer: { name: string } | null } | null;
    }[];

    return rows.map((row) => ({
      deliveryId: row.id,
      salesOrderId: row.sales_order_id,
      orderNumber: row.sales_order?.order_number ?? "-",
      customerName: row.sales_order?.customer?.name ?? row.sales_order?.customer_name_raw ?? null,
      status: row.status,
    }));
  }

  async listTodayDeliveries(companyId: string, salesmanId: string): Promise<TodayDelivery[]> {
    const all = await this.listAssigned(companyId, salesmanId);
    return all.filter((row) => !isTerminalStatus(row.status));
  }

  async listAllAssignedDeliveries(companyId: string, salesmanId: string): Promise<TodayDelivery[]> {
    return this.listAssigned(companyId, salesmanId);
  }
}

interface DeliverySeed {
  companyId: string;
  salesOrderId: string;
  assignedDriverId: string | null;
  status: DeliveryStatus;
  orderNumber: string;
  customerName: string | null;
}

export class InMemoryTodayDeliveryRepository implements TodayDeliveryRepository {
  private readonly deliveries = new Map<string, DeliverySeed>();
  private sequence = 0;

  seedDelivery(input: {
    companyId: string;
    salesOrderId: string;
    assignedDriverId: string | null;
    status: DeliveryStatus;
    orderNumber: string;
    customerName?: string | null;
    id?: string;
  }): string {
    this.sequence += 1;
    const id = input.id ?? `delivery-${this.sequence}`;
    this.deliveries.set(id, {
      companyId: input.companyId,
      salesOrderId: input.salesOrderId,
      assignedDriverId: input.assignedDriverId,
      status: input.status,
      orderNumber: input.orderNumber,
      customerName: input.customerName ?? null,
    });
    return id;
  }

  async listTodayDeliveries(companyId: string, salesmanId: string): Promise<TodayDelivery[]> {
    const all = await this.listAllAssignedDeliveries(companyId, salesmanId);
    return all.filter((d) => !isTerminalStatus(d.status));
  }

  async listAllAssignedDeliveries(companyId: string, salesmanId: string): Promise<TodayDelivery[]> {
    return Array.from(this.deliveries.entries())
      .filter(([, d]) => d.companyId === companyId && d.assignedDriverId === salesmanId)
      .map(([id, d]) => ({
        deliveryId: id,
        salesOrderId: d.salesOrderId,
        orderNumber: d.orderNumber,
        customerName: d.customerName,
        status: d.status,
      }));
  }
}
