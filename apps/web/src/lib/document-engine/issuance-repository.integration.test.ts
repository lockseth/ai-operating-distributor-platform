// =============================================================================
// DB-backed integration test -- Document Numbering Allocator (Target 2),
// Tenant Legal Identity (Target 3), Document Persistence & Versioning
// (Target 4). Membuktikan hal yang tidak bisa dibuktikan InMemory:
// concurrency Postgres sungguhan pada allocate_document_number (UPSERT
// row-lock), trigger immutability (deliveries.delivery_number/delivery_date,
// issued_documents.snapshot), dan tenant-validation trigger pada
// issued_documents. Skip graceful jika kredensial Supabase lokal tidak
// tersedia atau URL bukan loopback -- pola sama dengan
// imports/commit-invalid-status.integration.test.ts.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import { SupabaseDocumentIssuanceRepository } from "./issuance-repository";
import { DocumentSourceError } from "./errors";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
      : readDotEnvLocal();

  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("DB integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Document Numbering + Tenant Identity + Persistence (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  let repo: SupabaseDocumentIssuanceRepository;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let salesAuthId = "";
  let customerId = "";
  let orderId = "";
  let orderItemId = "";
  let deliveryId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    repo = new SupabaseDocumentIssuanceRepository(supabase);

    await supabase.from("companies").insert([
      { id: companyId, name: `ITest Co ${runTag}`, slug: `itest-doc-${runTag}` },
      { id: otherCompanyId, name: `ITest Co Other ${runTag}`, slug: `itest-doc-other-${runTag}` },
    ]);

    const { data: salesAuth, error: salesErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-sales@itest.test`,
      password: randomUUID(),
      email_confirm: true,
    });
    if (salesErr || !salesAuth.user) throw new Error(`gagal buat auth user: ${salesErr?.message}`);
    salesAuthId = salesAuth.user.id;
    await supabase.from("users").insert({ id: salesAuthId, company_id: companyId, email: `${runTag}-sales@itest.test`, full_name: "Sales ITest", is_active: true });

    const { data: customer, error: custErr } = await supabase.from("customers").insert({ company_id: companyId, name: "Toko ITest", code: `CUST-${runTag}` }).select("id").single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    customerId = (customer as { id: string }).id;

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId, sales_id: salesAuthId, status: "confirmed" })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    orderId = (order as { id: string }).id;

    const { data: orderItem, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: "Produk ITest", quantity: 10, unit: "pcs", unit_price: 1000, total_amount: 10000 })
      .select("id")
      .single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    orderItemId = (orderItem as { id: string }).id;

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: companyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    deliveryId = (delivery as { id: string }).id;
    await supabase.from("delivery_items").insert({ delivery_id: deliveryId, sales_order_item_id: orderItemId, ordered_quantity: 10 });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("issued_documents").delete().eq("company_id", companyId);
    await supabase.from("delivery_items").delete().eq("delivery_id", deliveryId);
    await supabase.from("deliveries").delete().eq("company_id", companyId);
    await supabase.from("sales_order_items").delete().eq("order_id", orderId);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("document_number_counters").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("users").delete().eq("company_id", companyId);
    if (salesAuthId) await supabase.auth.admin.deleteUser(salesAuthId);
    await supabase.from("companies").delete().in("id", [companyId, otherCompanyId]);
  }, 30000);

  it("1. Target 3: allocate_document_number menolak COMPANY_PROFILE_INCOMPLETE sebelum prefix diatur", async () => {
    await expect(repo.allocateDocumentNumber(companyId, "PURCHASE_ORDER", "2026-08-12")).rejects.toMatchObject({
      code: "COMPANY_PROFILE_INCOMPLETE",
    });
  });

  it("2. Target 3: melengkapi profil legal tenant (legal_address/contact_email/contact_phone/document_number_prefix)", async () => {
    const { error } = await supabase
      .from("companies")
      .update({ legal_address: "Jl. Integration Test No. 1", contact_email: "itest@example.test", contact_phone: "0800000000", document_number_prefix: "ITX" })
      .eq("id", companyId);
    expect(error).toBeNull();

    const profile = await repo.getCompanyProfile(companyId);
    expect(profile?.documentNumberPrefix).toBe("ITX");
  });

  it("3. Target 2/4: allocate_document_number CONCURRENCY -- 20 panggilan paralel menghasilkan 20 nomor unik berurutan, tidak ada duplikat/gap silent", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => repo.allocateDocumentNumber(companyId, "PURCHASE_ORDER", "2026-08-12")));
    const unique = new Set(results);
    expect(unique.size).toBe(20);
    const sequences = results.map((n) => Number(n.split("-").pop())).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(results.every((n) => /^ITX-PO-20260812-\d{6}$/.test(n))).toBe(true);
  });

  it("4. Target 2: issue_delivery_note mengalokasikan delivery_number/delivery_date pada delivery planned", async () => {
    const result = await repo.issueDeliveryNote(deliveryId);
    expect(result.deliveryNumber).toMatch(/^ITX-SJ-\d{8}-\d{6}$/);
    expect(result.deliveryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("5. Target 2: re-issue delivery yang sama ditolak (DELIVERY_ALREADY_ISSUED)", async () => {
    await expect(repo.issueDeliveryNote(deliveryId)).rejects.toMatchObject({ code: "DELIVERY_ALREADY_ISSUED" });
  });

  it("6. Target 2: immutability -- UPDATE langsung delivery_number/delivery_date ditolak trigger DB, bukan hanya di application layer", async () => {
    const { error } = await supabase.from("deliveries").update({ delivery_number: "HACKED" }).eq("id", deliveryId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("DELIVERY_NUMBER_IMMUTABLE");
  });

  it("7. Target 4: record_issued_document version 1 untuk PO, tenant tervalidasi lewat repository asli", async () => {
    const number = await repo.allocateDocumentNumber(companyId, "PURCHASE_ORDER", "2026-08-13");
    const record = await repo.recordIssuedDocument({
      companyId,
      documentType: "PURCHASE_ORDER",
      sourceOrderId: orderId,
      sourceDeliveryId: null,
      documentNumber: number,
      snapshot: { documentType: "PURCHASE_ORDER", documentNumber: number, grandTotal: 10000 },
      issuedBy: salesAuthId,
      supersedesDocumentId: null,
    });
    expect(record.version).toBe(1);
    expect(record.status).toBe("active");
  });

  it("8. Target 4: penerbitan kedua tanpa supersedesDocumentId untuk source yang sama ditolak (DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE)", async () => {
    const number = await repo.allocateDocumentNumber(companyId, "PURCHASE_ORDER", "2026-08-13");
    await expect(
      repo.recordIssuedDocument({
        companyId,
        documentType: "PURCHASE_ORDER",
        sourceOrderId: orderId,
        sourceDeliveryId: null,
        documentNumber: number,
        snapshot: { documentType: "PURCHASE_ORDER", documentNumber: number },
        issuedBy: salesAuthId,
        supersedesDocumentId: null,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE" });
  });

  it("9. Target 4: versioning -- supersede menghasilkan version 2, version 1 superseded, tepat satu versi aktif tersisa", async () => {
    const { data: activeBefore } = await supabase
      .from("issued_documents")
      .select("id")
      .eq("company_id", companyId)
      .eq("document_type", "PURCHASE_ORDER")
      .eq("status", "active")
      .single();
    const oldId = (activeBefore as { id: string }).id;

    const number = await repo.allocateDocumentNumber(companyId, "PURCHASE_ORDER", "2026-08-14");
    const v2 = await repo.recordIssuedDocument({
      companyId,
      documentType: "PURCHASE_ORDER",
      sourceOrderId: orderId,
      sourceDeliveryId: null,
      documentNumber: number,
      snapshot: { documentType: "PURCHASE_ORDER", documentNumber: number, grandTotal: 20000 },
      issuedBy: salesAuthId,
      supersedesDocumentId: oldId,
    });
    expect(v2.version).toBe(2);

    const { data: oldRow } = await supabase.from("issued_documents").select("status").eq("id", oldId).single();
    expect((oldRow as { status: string }).status).toBe("superseded");

    const { count } = await supabase
      .from("issued_documents")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("document_type", "PURCHASE_ORDER")
      .eq("status", "active");
    expect(count).toBe(1);
  });

  it("10. Target 4: immutability -- UPDATE langsung snapshot dokumen ditolak trigger DB", async () => {
    const { data: anyDoc } = await supabase.from("issued_documents").select("id").eq("company_id", companyId).limit(1).single();
    const { error } = await supabase.from("issued_documents").update({ snapshot: { hacked: true } }).eq("id", (anyDoc as { id: string }).id);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ISSUED_DOCUMENT_IMMUTABLE");
  });

  it("11. Target 4: tenant isolation -- source_order_id milik company lain ditolak TENANT_CONTEXT_MISMATCH", async () => {
    const { data: otherCustomer } = await supabase.from("customers").insert({ company_id: otherCompanyId, name: "Toko Lain", code: `CUST-OTHER-${runTag}` }).select("id").single();
    const { data: otherOrder } = await supabase
      .from("sales_orders")
      .insert({ company_id: otherCompanyId, order_number: `SO-OTHER-${runTag}`, customer_id: (otherCustomer as { id: string }).id, status: "confirmed" })
      .select("id")
      .single();

    await expect(
      repo.recordIssuedDocument({
        companyId,
        documentType: "PURCHASE_ORDER",
        sourceOrderId: (otherOrder as { id: string }).id,
        sourceDeliveryId: null,
        documentNumber: "ITX-PO-20260815-000001",
        snapshot: { documentType: "PURCHASE_ORDER" },
        issuedBy: null,
        supersedesDocumentId: null,
      }),
    ).rejects.toMatchObject({ code: "TENANT_CONTEXT_MISMATCH" });

    await supabase.from("sales_orders").delete().eq("id", (otherOrder as { id: string }).id);
    await supabase.from("customers").delete().eq("id", (otherCustomer as { id: string }).id);
  });

  it("12. error mapping: kegagalan RPC dipetakan ke DocumentSourceError bertipe (bukan Error generik)", async () => {
    try {
      await repo.issueDeliveryNote(deliveryId); // sudah issued dari test #4
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DocumentSourceError);
      expect((err as DocumentSourceError).code).toBe("DELIVERY_ALREADY_ISSUED");
    }
  });
});
