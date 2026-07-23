// =============================================================================
// Payment Terms -- closure check (Founder, 2026-07-23), melengkapi migration
// 20260812000003/20260812000004. Membuktikan lewat Postgres lokal + repository
// PRODUKSI (bukan fixture mentah):
//   1. payment_terms_days ditulis lewat SalesOrderTelegramRepository.
//      confirmOrder() -- fungsi konfirmasi order PRODUKSI yang sama dipakai
//      workflow.ts (Telegram flow) -- bukan UPDATE SQL langsung di test.
//   2. Setelah confirmed, UPDATE langsung mengubah payment_terms_days ditolak
//      trigger DB (PAYMENT_TERMS_DAYS_IMMUTABLE).
//   3. Nilai tersimpan di issued_documents.snapshot (immutable) untuk PO
//      MAUPUN Invoice, dibaca ulang dari DB, dan keduanya identik (berasal
//      dari order yang sama).
//   4. Order historis (confirmed TANPA payment_terms_days) tetap ditolak
//      PAYMENT_TERMS_INCOMPLETE saat issuance PO/Invoice.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { SupabaseSalesOrderRepository } from "@/lib/sales-orders/repository";
import { SupabaseDeliveryRepository } from "@/lib/delivery/repository";
import { SupabaseDocumentIssuanceRepository } from "./issuance-repository";
import { ConfirmedOrderReader, DeliveryVerificationReader } from "./repository-adapter";
import { issuePurchaseOrderDocument, issueInvoiceDocument } from "./issuance";

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

describeIfDb("Payment Terms closure check -- production confirmOrder() + immutability + snapshot parity + historical rejection", () => {
  let supabase: SupabaseClient;
  let salesOrderRepo: SupabaseSalesOrderRepository;
  let deliveryRepo: SupabaseDeliveryRepository;
  let issuanceRepo: SupabaseDocumentIssuanceRepository;
  const runTag = `ptclosure-${Date.now().toString(36)}`;
  const companyId = randomUUID();
  let salesAuthId = "";
  let customerId = "";
  let orderIdWithTerms = "";
  let orderItemIdWithTerms = "";
  let orderIdHistorical = "";
  let deliveryId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    salesOrderRepo = new SupabaseSalesOrderRepository(supabase);
    deliveryRepo = new SupabaseDeliveryRepository(supabase);
    issuanceRepo = new SupabaseDocumentIssuanceRepository(supabase);

    await supabase.from("companies").insert({
      id: companyId,
      name: `Payment Terms Closure ${runTag}`,
      slug: `ptclosure-${runTag}`,
      legal_address: "Jl. Payment Terms Closure No. 1",
      contact_email: "ptclosure@demo.test",
      contact_phone: "021-5559999",
      document_number_prefix: "PTC",
    });

    const { data: salesAuth } = await supabase.auth.admin.createUser({ email: `${runTag}-sales@demo.test`, password: randomUUID(), email_confirm: true });
    salesAuthId = salesAuth!.user!.id;
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@demo.test`, full_name: "Sales PT Closure", is_active: true });

    const { data: customer } = await supabase.from("customers").insert({ company_id: companyId, name: "Toko PT Closure", code: `CUST-${runTag}` }).select("id").single();
    customerId = (customer as { id: string }).id;

    // Order A: akan dikonfirmasi lewat confirmOrder() PRODUKSI dengan payment_terms_days.
    const { data: orderA } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-A-${runTag}`, customer_id: customerId, sales_id: salesAuthId, status: "draft" })
      .select("id")
      .single();
    orderIdWithTerms = (orderA as { id: string }).id;
    const { data: itemA } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderIdWithTerms, product_name_raw: "Produk PT Closure", quantity: 5, unit: "pcs", unit_price: 20000, discount_amount: 0, total_amount: 100000 })
      .select("id")
      .single();
    orderItemIdWithTerms = (itemA as { id: string }).id;

    // Order B: "historis" -- dikonfirmasi TANPA payment_terms_days (simulasi order lama).
    const { data: orderB } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-B-${runTag}`, customer_id: customerId, sales_id: salesAuthId, status: "draft" })
      .select("id")
      .single();
    orderIdHistorical = (orderB as { id: string }).id;
    await supabase.from("sales_order_items").insert({
      order_id: orderIdHistorical, product_name_raw: "Produk PT Closure Historis", quantity: 3, unit: "pcs", unit_price: 15000, discount_amount: 0, total_amount: 45000,
    });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("issued_documents").delete().eq("company_id", companyId);
    if (deliveryId) {
      await supabase.from("delivery_items").delete().eq("delivery_id", deliveryId);
      await supabase.from("deliveries").delete().eq("id", deliveryId);
    }
    await supabase.from("sales_order_items").delete().in("order_id", [orderIdWithTerms, orderIdHistorical]);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("company_id", companyId);
    await supabase.from("document_number_counters").delete().eq("company_id", companyId);
    await supabase.from("users").delete().eq("company_id", companyId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    await supabase.from("companies").delete().eq("id", companyId);
  }, 30000);

  it("1. confirmOrder() PRODUKSI menulis payment_terms_days saat transisi draft->confirmed, dibaca ulang dari DB", async () => {
    const result = await salesOrderRepo.confirmOrder(orderIdWithTerms, { paymentTermsDays: 14 });
    expect(result.alreadyConfirmed).toBe(false);

    const { data: row } = await supabase.from("sales_orders").select("status, payment_terms_days").eq("id", orderIdWithTerms).single();
    expect((row as { status: string }).status).toBe("confirmed");
    expect((row as { payment_terms_days: number }).payment_terms_days).toBe(14);
  });

  it("2. Setelah confirmed, UPDATE langsung mengubah payment_terms_days ditolak trigger DB (PAYMENT_TERMS_DAYS_IMMUTABLE)", async () => {
    const { error } = await supabase.from("sales_orders").update({ payment_terms_days: 30 }).eq("id", orderIdWithTerms);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("PAYMENT_TERMS_DAYS_IMMUTABLE");

    const { data: row } = await supabase.from("sales_orders").select("payment_terms_days").eq("id", orderIdWithTerms).single();
    expect((row as { payment_terms_days: number }).payment_terms_days).toBe(14); // tidak berubah
  });

  it("2b. UPDATE field LAIN (bukan payment_terms_days) pada order confirmed TETAP diizinkan (trigger tidak overbroad)", async () => {
    const { error } = await supabase.from("sales_orders").update({ notes: "catatan internal" }).eq("id", orderIdWithTerms);
    expect(error).toBeNull();
  });

  it("3. PO snapshot (v1 dan v2/revisi) membaca payment_terms_days dari issued_documents (dibaca ulang dari DB, bukan in-process)", async () => {
    const orderReader = new ConfirmedOrderReader(deliveryRepo);
    const issuedPo = await issuePurchaseOrderDocument(
      { issuance: issuanceRepo, orderReader },
      { companyId, orderId: orderIdWithTerms, issuedBy: salesAuthId, delivererName: "Sales PT Closure" },
    );
    expect(issuedPo.snapshot.paymentTermsDays).toBe(14);

    const { data: poRow } = await supabase.from("issued_documents").select("snapshot").eq("id", issuedPo.record.id).single();
    expect((poRow as { snapshot: { paymentTermsDays: number } }).snapshot.paymentTermsDays).toBe(14);

    // Revisi PO (version 2) dari order yang SAMA -- tetap harus membawa payment_terms_days yang sama persis.
    const issuedPoV2 = await issuePurchaseOrderDocument(
      { issuance: issuanceRepo, orderReader },
      { companyId, orderId: orderIdWithTerms, issuedBy: salesAuthId, delivererName: "Sales PT Closure", supersedesDocumentId: issuedPo.record.id },
    );
    expect(issuedPoV2.record.version).toBe(2);
    const { data: poV2Row } = await supabase.from("issued_documents").select("snapshot").eq("id", issuedPoV2.record.id).single();
    expect((poV2Row as { snapshot: { paymentTermsDays: number } }).snapshot.paymentTermsDays).toBe(14);
    expect((poV2Row as { snapshot: { paymentTermsDays: number } }).snapshot.paymentTermsDays).toBe(
      (poRow as { snapshot: { paymentTermsDays: number } }).snapshot.paymentTermsDays,
    );
  });

  it("4. Invoice (order+delivery yang SAMA) membaca payment_terms_days IDENTIK dengan PO -- kedua tipe dokumen, satu order, satu nilai", async () => {
    const created = await deliveryRepo.createDelivery({
      companyId,
      salesOrderId: orderIdWithTerms,
      idempotencyKey: null,
      createdBy: salesAuthId,
      items: [{ salesOrderItemId: orderItemIdWithTerms, productName: "Produk PT Closure", unit: "pcs", unitPrice: 20000, orderedQuantity: 5 }],
    });
    deliveryId = created.id;

    const issuanceRepoLocal = new SupabaseDocumentIssuanceRepository(supabase);
    await issuanceRepoLocal.issueDeliveryNote(deliveryId);
    await deliveryRepo.recordDispatch(deliveryId);
    await deliveryRepo.recordArrival(deliveryId);
    await deliveryRepo.finalizeItemQuantities(deliveryId, [
      { deliveryItemId: created.items[0].id, receivedQuantity: 5, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 },
    ]);
    await deliveryRepo.finalizeDelivery(deliveryId, "fully_received");

    const orderReader = new ConfirmedOrderReader(deliveryRepo);
    const deliveryReader = new DeliveryVerificationReader(deliveryRepo);
    const issuedInvoice = await issueInvoiceDocument(
      { issuance: issuanceRepo, orderReader, deliveryReader },
      { companyId, orderId: orderIdWithTerms, deliveryId, issuedBy: salesAuthId, delivererName: "Sales PT Closure" },
    );
    expect(issuedInvoice.snapshot.paymentTermsDays).toBe(14);

    const { data: invRow } = await supabase.from("issued_documents").select("snapshot").eq("id", issuedInvoice.record.id).single();
    const invoiceSnapshotTerms = (invRow as { snapshot: { paymentTermsDays: number } }).snapshot.paymentTermsDays;
    expect(invoiceSnapshotTerms).toBe(14);

    const { data: poRows } = await supabase
      .from("issued_documents")
      .select("snapshot")
      .eq("company_id", companyId)
      .eq("document_type", "PURCHASE_ORDER")
      .eq("source_order_id", orderIdWithTerms);
    for (const poRow of poRows ?? []) {
      expect((poRow as { snapshot: { paymentTermsDays: number } }).snapshot.paymentTermsDays).toBe(invoiceSnapshotTerms);
    }
  });

  it("5. Order historis (confirmed TANPA payment_terms_days) -> issuance PO ditolak PAYMENT_TERMS_INCOMPLETE", async () => {
    const result = await salesOrderRepo.confirmOrder(orderIdHistorical); // TANPA options -- meniru order lama
    expect(result.alreadyConfirmed).toBe(false);

    const { data: row } = await supabase.from("sales_orders").select("payment_terms_days").eq("id", orderIdHistorical).single();
    expect((row as { payment_terms_days: number | null }).payment_terms_days).toBeNull();

    const orderReader = new ConfirmedOrderReader(deliveryRepo);
    await expect(
      issuePurchaseOrderDocument(
        { issuance: issuanceRepo, orderReader },
        { companyId, orderId: orderIdHistorical, issuedBy: salesAuthId, delivererName: "Sales PT Closure" },
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_TERMS_INCOMPLETE" });

    const { count } = await supabase.from("issued_documents").select("id", { count: "exact", head: true }).eq("source_order_id", orderIdHistorical);
    expect(count).toBe(0); // tidak ada row terbuang akibat percobaan issuance yang gagal
  });
});
