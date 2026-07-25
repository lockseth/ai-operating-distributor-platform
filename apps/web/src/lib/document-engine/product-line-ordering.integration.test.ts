// =============================================================================
// Regression: urutan baris produk (sales_order_items/delivery_items) pada
// dokumen HARUS deterministik lewat kolom line_no (migration
// 20260903000001_document_line_order_determinism.sql), BUKAN kebetulan
// mengikuti urutan fisik/scan Postgres.
//
// Akar masalah yang diperbaiki: getConfirmedOrder/getDelivery
// (lib/delivery/repository.ts) meng-embed sales_order_items/delivery_items
// TANPA ORDER BY eksplisit -- Postgres TIDAK menjamin urutan baris tanpa
// ORDER BY, dan kedua tabel itu tidak punya kolom apa pun (created_at/
// line_number) yang menangkap urutan insert asli sebelum fix ini (id UUID
// acak). Pada tabel kecil/fresh, seq scan KEBETULAN mengembalikan urutan
// insert, sehingga bug ini lolos di test kecil/terisolasi tapi berisiko
// muncul begitu planner memilih index scan (ada idx_order_items_order_id)
// atau begitu sebuah baris di-UPDATE (tuple lama jadi dead, versi baru
// ditulis di lokasi fisik lain -- MVCC Postgres).
//
// Mekanisme nondeterminisme ini sudah dikonfirmasi manual lewat psql langsung
// (bukan asumsi): pada tabel dengan tekanan volume nyata (puluhan ribu baris
// dari order lain, meniru DB yang sudah lama dipakai), meng-UPDATE satu baris
// memindahkan tuple fisiknya ke halaman jauh di ujung tabel, dan seq
// scan/bitmap heap scan TANPA ORDER BY mengembalikan baris itu di posisi
// TERAKHIR alih-alih posisi aslinya -- persis skenario yang dijaga migration
// line_no + ORDER BY line_no. Pada tabel kecil/segar seperti fixture test ini,
// UPDATE tunggal tidak selalu cukup memindahkan tuple (HOT update bisa
// menulis ulang tuple di halaman yang sama bila ruang kosong masih ada) --
// jadi test di bawah ini menjaga KONTRAK yang benar (urutan insert bertahan
// termasuk setelah salah satu baris dimutasi), bukan mereproduksi tekanan
// volume produksi itu sendiri (terlalu berat untuk test cepat).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { SupabaseDeliveryRepository } from "@/lib/delivery/repository";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

const env = readDotEnvLocal();
const describeIfDb = env && isLoopbackSupabaseUrl(env.url) ? describe : describe.skip;

// Sengaja BUKAN urutan alfabetis/nama -- membuktikan urutan yang dikembalikan
// bukan kebetulan cocok dengan sort by name/sku, melainkan urutan insert asli.
const LINES = ["Item Echo", "Item Charlie", "Item Alpha", "Item Delta", "Item Bravo"];

describeIfDb("Urutan baris produk deterministik (line_no) -- bertahan setelah baris di-UPDATE", () => {
  let supabase: SupabaseClient;
  let deliveryRepo: SupabaseDeliveryRepository;
  const runTag = `lineorder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let salesAuthId = "";
  let customerId = "";
  let orderId = "";
  let orderItemIds: string[] = [];
  let deliveryId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    deliveryRepo = new SupabaseDeliveryRepository(supabase);

    await supabase.from("companies").insert({
      id: companyId,
      name: `Line Order Regression ${runTag}`,
      slug: `lineorder-${runTag}`,
      legal_address: "Jl. Line Order No. 1",
      contact_email: "lineorder@demo.test",
      contact_phone: "021-5550000",
      document_number_prefix: "LOR",
    });

    const { data: salesAuth } = await supabase.auth.admin.createUser({ email: `${runTag}-sales@demo.test`, password: randomUUID(), email_confirm: true });
    salesAuthId = salesAuth!.user!.id;
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@demo.test`, full_name: "Sales Line Order", is_active: true });
    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    await supabase.from("user_roles").insert({ user_id: salesAuthId, company_id: companyId, role_id: (ownerRole as { id: string }).id });

    const { data: customer } = await supabase.from("customers").insert({ company_id: companyId, name: "Toko Line Order", code: `CUST-${runTag}` }).select("id").single();
    customerId = (customer as { id: string }).id;

    const { data: order } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId, sales_id: salesAuthId, status: "confirmed", payment_terms_days: 14 })
      .select("id")
      .single();
    orderId = (order as { id: string }).id;

    orderItemIds = [];
    for (const name of LINES) {
      const { data: item, error } = await supabase
        .from("sales_order_items")
        .insert({ order_id: orderId, product_name_raw: name, quantity: 1, unit: "pcs", unit_price: 10000, discount_amount: 0, total_amount: 10000 })
        .select("id")
        .single();
      if (error) throw new Error(`gagal buat sales_order_item (${name}): ${error.message}`);
      orderItemIds.push((item as { id: string }).id);
    }
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    if (deliveryId) await supabase.from("delivery_items").delete().eq("delivery_id", deliveryId);
    await supabase.from("deliveries").delete().eq("company_id", companyId);
    await supabase.from("sales_order_items").delete().eq("order_id", orderId);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("company_id", companyId);
    await supabase.from("users").delete().eq("company_id", companyId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    await supabase.from("companies").delete().eq("id", companyId);
  }, 30000);

  it("1. getConfirmedOrder mengembalikan lines sesuai urutan insert asli, TIDAK berubah setelah salah satu baris di-UPDATE", async () => {
    const before = await deliveryRepo.getConfirmedOrder(orderId, companyId);
    expect(before?.items.map((i) => i.productName)).toEqual(LINES);

    // UPDATE baris KETIGA (bukan pertama/terakhir) -- Postgres MVCC menulis
    // tuple versi baru di lokasi fisik lain, memutus asumsi "urutan fisik ==
    // urutan insert" kalau query tidak benar-benar ORDER BY line_no.
    const { error: updateErr } = await supabase
      .from("sales_order_items")
      .update({ discount_amount: 500 })
      .eq("id", orderItemIds[2]!);
    if (updateErr) throw new Error(`gagal update sales_order_item: ${updateErr.message}`);

    const after = await deliveryRepo.getConfirmedOrder(orderId, companyId);
    expect(after?.items.map((i) => i.productName)).toEqual(LINES);
    expect(after?.items[2]!.discountAmount).toBe(500);
  });

  it("2. getDelivery mengembalikan lines sesuai urutan insert asli, TIDAK berubah setelah salah satu baris di-UPDATE", async () => {
    const created = await deliveryRepo.createDelivery({
      companyId,
      actorId: salesAuthId,
      salesOrderId: orderId,
      idempotencyKey: null,
      driverId: salesAuthId,
      items: LINES.map((name, i) => ({ salesOrderItemId: orderItemIds[i]!, productName: name, unit: "pcs", unitPrice: 10000, orderedQuantity: 1 })),
    });
    deliveryId = created.id;
    expect(created.items.map((i) => i.productName)).toEqual(LINES);

    const before = await deliveryRepo.getDelivery(deliveryId);
    expect(before?.items.map((i) => i.productName)).toEqual(LINES);

    // UPDATE baris KETIGA delivery_items -- sama seperti di atas, memaksa
    // tuple berpindah fisik supaya urutan hasil query benar-benar diuji.
    await deliveryRepo.updateItemOutcome(before!.items[2]!.id, { receivedQuantity: 0, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 });

    const after = await deliveryRepo.getDelivery(deliveryId);
    expect(after?.items.map((i) => i.productName)).toEqual(LINES);
  });
});
