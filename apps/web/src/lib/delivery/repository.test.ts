// =============================================================================
// Repository & Persistence Closure Gate -- regression test untuk perluasan
// additive SupabaseDeliveryRepository.getConfirmedOrder (orderDate/customerId/
// salesmanId/salesmanName/discountAmount per baris). Fokus test ini: (1)
// mapping field baru benar, dan (2) defense-in-depth tenant-safety pada join
// users!sales_id -- salesman dari company lain TIDAK PERNAH bocor lewat
// dokumen walau (secara hipotetis) sales_id menunjuk user company lain.
//
// Fake Supabase client minimal (bukan integrasi cloud) -- hanya method yang
// dipakai getConfirmedOrder/getOutstandingQuantity yang diimplementasikan.
// =============================================================================

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseDeliveryRepository } from "./repository";

function fakeSupabaseForConfirmedOrder(row: unknown): SupabaseClient {
  return {
    from(table: string) {
      if (table === "sales_orders") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => ({ data: row }),
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table in fake: ${table}`);
    },
    rpc(fn: string) {
      if (fn === "get_outstanding_quantity") {
        // Bukan fokus test ini -- kembalikan quantity item asli tanpa pengurangan.
        return Promise.resolve({ data: 10, error: null });
      }
      throw new Error(`unexpected rpc in fake: ${fn}`);
    },
  } as unknown as SupabaseClient;
}

const BASE_ROW = {
  id: "order-A",
  company_id: "company-swa",
  order_number: "SO-0001",
  status: "confirmed",
  confirmed_at: "2026-08-11T00:00:00.000Z",
  customer_id: "cust-1",
  customer: { name: "Toko Sari" },
  customer_name_raw: null,
  sales_id: "sales-1",
  salesman: { full_name: "Budi Santoso", company_id: "company-swa" },
  payment_terms_days: 14,
  items: [
    {
      id: "soi-1",
      quantity: 10,
      unit: "dus",
      unit_price: 85000,
      discount_amount: 5000,
      product_name_raw: null,
      product: { name: "Indomie Goreng" },
    },
  ],
};

describe("SupabaseDeliveryRepository.getConfirmedOrder -- perluasan additive", () => {
  it("memetakan orderDate (confirmed_at), customerId, salesmanId/salesmanName, dan discountAmount per baris", async () => {
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(BASE_ROW));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");

    expect(order?.orderDate).toBe("2026-08-11T00:00:00.000Z");
    expect(order?.customerId).toBe("cust-1");
    expect(order?.salesmanId).toBe("sales-1");
    expect(order?.salesmanName).toBe("Budi Santoso");
    expect(order?.items[0].discountAmount).toBe(5000);
  });

  it("orderDate null (confirmed_at belum terisi, mis. historical import) -> tetap null, TIDAK fallback ke created_at", async () => {
    const row = { ...BASE_ROW, confirmed_at: null };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(row));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");
    expect(order?.orderDate).toBeNull();
  });

  it("sales_id null (order belum diberi salesman) -> salesmanId/salesmanName null, bukan string kosong", async () => {
    const row = { ...BASE_ROW, sales_id: null, salesman: null };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(row));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");
    expect(order?.salesmanId).toBeNull();
    expect(order?.salesmanName).toBeNull();
  });

  it("discount_amount 0 (memang tanpa diskon) dipetakan sebagai 0, bukan diperlakukan sebagai tidak tersedia", async () => {
    const row = { ...BASE_ROW, items: [{ ...BASE_ROW.items[0], discount_amount: 0 }] };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(row));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");
    expect(order?.items[0].discountAmount).toBe(0);
  });

  it("memetakan payment_terms_days apa adanya (present)", async () => {
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(BASE_ROW));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");
    expect(order?.paymentTermsDays).toBe(14);
  });

  it("payment_terms_days null (order historis/belum diisi) -> tetap null, TIDAK fallback ke 0", async () => {
    const row = { ...BASE_ROW, payment_terms_days: null };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(row));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");
    expect(order?.paymentTermsDays).toBeNull();
  });

  it("TENANT-SAFETY: join users!sales_id mengembalikan user company LAIN (hipotetis) -> salesmanId/salesmanName di-null-kan, TIDAK bocor", async () => {
    const row = { ...BASE_ROW, salesman: { full_name: "Orang Company Lain", company_id: "company-lain" } };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForConfirmedOrder(row));
    const order = await repo.getConfirmedOrder("order-A", "company-swa");
    expect(order?.salesmanId).toBeNull();
    expect(order?.salesmanName).toBeNull();
    expect(JSON.stringify(order)).not.toContain("Orang Company Lain");
  });
});

// ---------------------------------------------------------------------------
// getDelivery -- wiring products.sku/product_categories.name (jenis produk)
// ke DeliveryItemRecord, supaya Invoice (via DeliveryVerificationReader +
// computeInvoiceEligibility) bisa menampilkan Kode Barang/Jenis Produk asli,
// bukan "-".
// ---------------------------------------------------------------------------

function fakeSupabaseForGetDelivery(row: unknown): SupabaseClient {
  return {
    from(table: string) {
      if (table === "deliveries") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: row }),
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table in fake: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const DELIVERY_ROW = {
  id: "delivery-A",
  company_id: "company-swa",
  sales_order_id: "order-A",
  attempt_number: 1,
  assigned_driver_id: null,
  status: "verified",
  delivery_number: "SWAS-SJ-20260811-000001",
  delivery_date: "2026-08-11",
  items: [
    {
      id: "dli-1",
      sales_order_item_id: "soi-1",
      ordered_quantity: 10,
      dispatched_quantity: 10,
      received_quantity: 10,
      rejected_quantity: 0,
      returned_quantity: 0,
      unresolved_quantity: 0,
      sales_order_item: {
        unit_price: 85000,
        unit: "dus",
        product_name_raw: null,
        product: { name: "Indomie Goreng", sku: "SKU-1", category: { name: "Mie Instan" } },
      },
    },
  ],
  exceptions: [],
  evidence: [],
  recipient: [],
};

describe("SupabaseDeliveryRepository.getDelivery -- wiring products.sku/product_categories.name", () => {
  it("memetakan productCode (products.sku) dan productType (product_categories.name) dari join sales_order_item->product", async () => {
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForGetDelivery(DELIVERY_ROW));
    const delivery = await repo.getDelivery("delivery-A");
    expect(delivery?.items[0]?.productCode).toBe("SKU-1");
    expect(delivery?.items[0]?.productType).toBe("Mie Instan");
  });

  it("produk tanpa sku/kategori -> productCode/productType null, TIDAK dikarang", async () => {
    const row = {
      ...DELIVERY_ROW,
      items: [
        {
          ...DELIVERY_ROW.items[0],
          sales_order_item: {
            ...DELIVERY_ROW.items[0].sales_order_item,
            product: { name: "Indomie Goreng", sku: null, category: null },
          },
        },
      ],
    };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForGetDelivery(row));
    const delivery = await repo.getDelivery("delivery-A");
    expect(delivery?.items[0]?.productCode).toBeNull();
    expect(delivery?.items[0]?.productType).toBeNull();
  });

  it("item tanpa product_id (product null, hanya product_name_raw) -> productCode/productType null", async () => {
    const row = {
      ...DELIVERY_ROW,
      items: [
        {
          ...DELIVERY_ROW.items[0],
          sales_order_item: { unit_price: 85000, unit: "dus", product_name_raw: "Barang Manual", product: null },
        },
      ],
    };
    const repo = new SupabaseDeliveryRepository(fakeSupabaseForGetDelivery(row));
    const delivery = await repo.getDelivery("delivery-A");
    expect(delivery?.items[0]?.productName).toBe("Barang Manual");
    expect(delivery?.items[0]?.productCode).toBeNull();
    expect(delivery?.items[0]?.productType).toBeNull();
  });
});
