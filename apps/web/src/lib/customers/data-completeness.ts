// =============================================================================
// Kelengkapan data toko (foto depan toko, titik GPS) -- keduanya OPSIONAL saat
// pendaftaran (keputusan Pak Waluyo, migration 20261004000001_gate_store_
// photo_gps_web.sql). Toko CASH tidak diribetkan sama sekali -- PR ini HANYA
// berlaku untuk toko KREDIT (keputusan Pak Waluyo, klarifikasi lanjutan):
// wajar diminta lengkap karena distributor menanggung risiko piutang di
// toko itu.
//
// "Kredit" bukan atribut tetap di customers -- tidak ada kolom seperti
// payment_type/credit_limit di skema. Yang ada adalah sales_orders.
// payment_terms_days (diisi manual per order lewat form "Termin Pembayaran/
// Tempo"). Definisi dipakai di sini (dikonfirmasi Pak Waluyo): toko dianggap
// KREDIT kalau MINIMAL SATU order-nya (kapan pun, status apa pun) pernah
// diisi payment_terms_days -- sekali dikasih tempo, toko itu kredit
// seterusnya, tidak "reset" ke cash walau order berikutnya cash/COD.
//
// Dipakai Executive Intelligence (dashboard Owner) DAN Morning Brief (Daily
// Brief ke sales) -- SATU sumber query untuk kedua konsumen supaya definisi
// "toko kredit belum lengkap" tidak drift antara keduanya.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CustomerDataGapCounts {
  missingPhoto: number;
  missingGps: number;
}

export interface SalesDataGapSummary extends CustomerDataGapCounts {
  salesId: string;
  salesName: string;
}

export interface CustomerDataGapRepository {
  getGapCountsForSalesperson(companyId: string, salespersonId: string): Promise<CustomerDataGapCounts>;
  getGapCountsBySalesperson(companyId: string): Promise<SalesDataGapSummary[]>;
  getTotalIncompleteCount(companyId: string): Promise<number>;
  getTotalCreditCount(companyId: string): Promise<number>;
  /** Toko yang minimal satu order-nya pernah diisi payment_terms_days -- dipakai halaman Pelanggan untuk filter `data_gap` (scope sama seperti PR di dashboard). */
  getCreditCustomerIds(companyId: string): Promise<string[]>;
}

interface CustomerGapRow {
  id: string;
  assigned_sales_id: string | null;
  storefront_photo_url: string | null;
  latitude: number | null;
  longitude: number | null;
  users: { full_name: string } | { full_name: string }[] | null;
}

function resolveSalesName(users: CustomerGapRow["users"]): string {
  if (!users) return "-";
  return Array.isArray(users) ? (users[0]?.full_name ?? "-") : users.full_name;
}

export class SupabaseCustomerDataGapRepository implements CustomerDataGapRepository {
  constructor(private readonly client: SupabaseClient) {}

  /** Toko yang MINIMAL SATU order-nya pernah diisi payment_terms_days (kredit). */
  async getCreditCustomerIds(companyId: string): Promise<string[]> {
    const { data } = await this.client
      .from("sales_orders")
      .select("customer_id")
      .eq("company_id", companyId)
      .not("payment_terms_days", "is", null);

    const ids = (data ?? []) as { customer_id: string }[];
    return [...new Set(ids.map((r) => r.customer_id))];
  }

  async getGapCountsForSalesperson(companyId: string, salespersonId: string): Promise<CustomerDataGapCounts> {
    const creditIds = await this.getCreditCustomerIds(companyId);
    if (creditIds.length === 0) return { missingPhoto: 0, missingGps: 0 };

    const { data } = await this.client
      .from("customers")
      .select("storefront_photo_url, latitude, longitude")
      .eq("company_id", companyId)
      .eq("assigned_sales_id", salespersonId)
      .eq("is_active", true)
      .in("id", creditIds);

    const rows = (data ?? []) as { storefront_photo_url: string | null; latitude: number | null; longitude: number | null }[];
    let missingPhoto = 0;
    let missingGps = 0;
    for (const row of rows) {
      if (!row.storefront_photo_url) missingPhoto += 1;
      if (row.latitude === null || row.longitude === null) missingGps += 1;
    }
    return { missingPhoto, missingGps };
  }

  async getGapCountsBySalesperson(companyId: string): Promise<SalesDataGapSummary[]> {
    const creditIds = await this.getCreditCustomerIds(companyId);
    if (creditIds.length === 0) return [];

    const { data } = await this.client
      .from("customers")
      .select("id, assigned_sales_id, storefront_photo_url, latitude, longitude, users!assigned_sales_id(full_name)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", creditIds);

    const rows = (data ?? []) as unknown as CustomerGapRow[];
    const bySales = new Map<string, SalesDataGapSummary>();

    for (const row of rows) {
      if (!row.assigned_sales_id) continue;
      const missingPhoto = !row.storefront_photo_url;
      const missingGps = row.latitude === null || row.longitude === null;
      if (!missingPhoto && !missingGps) continue;

      const existing = bySales.get(row.assigned_sales_id) ?? {
        salesId: row.assigned_sales_id,
        salesName: resolveSalesName(row.users),
        missingPhoto: 0,
        missingGps: 0,
      };
      if (missingPhoto) existing.missingPhoto += 1;
      if (missingGps) existing.missingGps += 1;
      bySales.set(row.assigned_sales_id, existing);
    }

    return [...bySales.values()].sort(
      (a, b) => b.missingPhoto + b.missingGps - (a.missingPhoto + a.missingGps),
    );
  }

  async getTotalIncompleteCount(companyId: string): Promise<number> {
    const creditIds = await this.getCreditCustomerIds(companyId);
    if (creditIds.length === 0) return 0;

    const { count } = await this.client
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", creditIds)
      .or("storefront_photo_url.is.null,latitude.is.null,longitude.is.null");
    return count ?? 0;
  }

  async getTotalCreditCount(companyId: string): Promise<number> {
    const creditIds = await this.getCreditCustomerIds(companyId);
    if (creditIds.length === 0) return 0;

    const { count } = await this.client
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", creditIds);
    return count ?? 0;
  }
}
