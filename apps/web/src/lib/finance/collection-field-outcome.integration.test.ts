// =============================================================================
// DB-backed integration test -- Catat Hasil Kunjungan Penagihan (sisi
// sales/driver, non-pembayaran), migration 20261022000001.
//
// Membuktikan otorisasi dua-tier record_collection_activity() sungguhan ke
// Postgres: actor field-tier (permission collection.record.field, role
// sales/driver) HANYA boleh outcome non-pembayaran -- claimed_paid_partial/
// claimed_paid_full DITOLAK di level RPC (defense-in-depth, bukan cuma
// dibatasi UI/app layer). Actor full-tier (collection.record, finance-tier)
// TETAP bisa outcome apa pun seperti sebelum perubahan ini (regresi
// backward-compat -- CREATE OR REPLACE tidak boleh merusak jalur existing).
//
// Skip graceful kalau kredensial Supabase lokal tidak tersedia / URL bukan
// loopback -- pola sama collection-promise-foundation.integration.test.ts
// (Gate 2C), termasuk reuse fixture invoice via issue_invoice_atomic nyata.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
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

interface InvoiceFixture {
  invoiceId: string;
}

describeIfDb("Catat Hasil Kunjungan Penagihan Integration -- otorisasi dua-tier record_collection_activity (Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const createdCompanyIds = [companyId];
  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];

  let salesUser: { userId: string };
  let ownerUser: { userId: string };

  async function createActor(tag: string, roleName: string) {
    const email = `${tag}@itest.test`;
    const password = randomUUID();
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${tag}: ${error?.message}`);
    const userId = data.user.id;
    createdUserIds.push(userId);
    await supabase.from("users").insert({ id: userId, company_id: companyId, email, full_name: `Actor ${tag}`, is_active: true });
    const { data: role, error: roleErr } = await supabase.from("roles").select("id").is("company_id", null).eq("name", roleName).single();
    if (roleErr || !role) throw new Error(`role ${roleName} tidak ditemukan: ${roleErr?.message}`);
    await supabase.from("user_roles").insert({ user_id: userId, role_id: (role as { id: string }).id, company_id: companyId });
    return { userId };
  }

  async function createInvoice(tag: string, actorId: string): Promise<InvoiceFixture> {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id").single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${tag}`, customer_id: customerId, status: "delivered" })
      .select("id").single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: companyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id").single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const quantity = 10;
    const unitPrice = 1000;
    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity, unit_price: unitPrice, discount_amount: 0, total_amount: quantity * unitPrice })
      .select("id").single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    const orderItemId = (item as { id: string }).id;

    const { error: diErr } = await supabase.from("delivery_items").insert({
      delivery_id: deliveryId, sales_order_item_id: orderItemId,
      ordered_quantity: quantity, dispatched_quantity: quantity, received_quantity: quantity,
    });
    if (diErr) throw new Error(`gagal buat delivery item: ${diErr.message}`);

    const { data: issueData, error: issueErr } = await supabase.rpc("issue_invoice_atomic", {
      p_company_id: companyId, p_actor_id: actorId, p_order_id: orderId,
    });
    if (issueErr) throw new Error(`issue_invoice_atomic gagal: ${issueErr.message}`);
    const row = (issueData as Array<{ out_invoice_id: string }>)[0];
    return { invoiceId: row.out_invoice_id };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    await supabase.from("companies").insert({
      id: companyId, name: `ITest CollectionField ${runTag}`, slug: `itest-cf-${runTag}`,
      document_number_prefix: "ICF", legal_address: "Jl. Uji Coba No. 1, Jakarta", contact_email: `${runTag}@itest.test`, contact_phone: "021-5550003",
    });
    salesUser = await createActor(`${runTag}-sales`, "sales");
    ownerUser = await createActor(`${runTag}-owner`, "owner");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("collection_activities").delete().in("company_id", createdCompanyIds);
    await supabase.from("receivable_ledger").delete().in("company_id", createdCompanyIds);
    await supabase.from("invoice_lines").delete().in("company_id", createdCompanyIds);
    await supabase.from("invoices").delete().in("company_id", createdCompanyIds);
    await supabase.from("issued_documents").delete().in("company_id", createdCompanyIds);
    await supabase.from("delivery_items").delete().in("delivery_id", createdDeliveryIds);
    await supabase.from("deliveries").delete().in("id", createdDeliveryIds);
    await supabase.from("sales_order_items").delete().in("order_id", createdOrderIds);
    await supabase.from("sales_orders").delete().in("id", createdOrderIds);
    await supabase.from("customers").delete().in("id", createdCustomerIds);
    await supabase.from("document_number_counters").delete().in("company_id", createdCompanyIds);
    await supabase.from("user_roles").delete().in("user_id", createdUserIds);
    await supabase.from("users").delete().in("id", createdUserIds);
    for (const id of createdUserIds) await supabase.auth.admin.deleteUser(id);
    await supabase.from("companies").delete().in("id", createdCompanyIds);
  }, 60000);

  it("1. Actor field-tier (sales) -> outcome not_paid_yet sukses, collector_id = actor", async () => {
    const inv = await createInvoice(`${runTag}-1`, ownerUser.userId);
    const { data, error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: salesUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "visit", p_activity_type: "outcome", p_outcome: "not_paid_yet",
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_activity_id: string }>)[0];
    expect(row.out_activity_id).toBeTruthy();

    const { data: activityRow } = await supabase.from("collection_activities").select("collector_id").eq("id", row.out_activity_id).single();
    expect((activityRow as { collector_id: string }).collector_id).toBe(salesUser.userId);
  });

  it("2. Actor field-tier (sales) -> outcome claimed_paid_full DITOLAK (INVALID_OUTCOME_FIELD_TIER), tidak ada baris tercatat", async () => {
    const inv = await createInvoice(`${runTag}-2`, ownerUser.userId);
    const { data, error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: salesUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "visit", p_activity_type: "outcome", p_outcome: "claimed_paid_full", p_reported_amount: 5000,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVALID_OUTCOME_FIELD_TIER");

    const { data: rows } = await supabase.from("collection_activities").select("id").eq("invoice_id", inv.invoiceId);
    expect(rows ?? []).toHaveLength(0);
  });

  it("3. Actor field-tier (sales) -> outcome promised_to_pay (reserved) TETAP ditolak seperti sebelumnya (regresi)", async () => {
    const inv = await createInvoice(`${runTag}-3`, ownerUser.userId);
    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: salesUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "visit", p_activity_type: "outcome", p_outcome: "promised_to_pay",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVALID_OUTCOME_RESERVED");
  });

  it("4. Actor full-tier (owner, collection.record penuh) -> outcome claimed_paid_full TETAP sukses (backward-compat)", async () => {
    const inv = await createInvoice(`${runTag}-4`, ownerUser.userId);
    const { data, error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: ownerUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "visit", p_activity_type: "outcome", p_outcome: "claimed_paid_full", p_reported_amount: 5000,
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_outcome: string }>)[0];
    expect(row.out_outcome).toBe("claimed_paid_full");
  });

  it("5. Actor tanpa permission apa pun -> FORBIDDEN (tidak berubah)", async () => {
    const inv = await createInvoice(`${runTag}-5`, ownerUser.userId);
    const { data: noRoleUser, error: createErr } = await supabase.auth.admin.createUser({ email: `${runTag}-norole@itest.test`, password: randomUUID(), email_confirm: true });
    if (createErr || !noRoleUser.user) throw new Error("gagal buat actor tanpa role");
    createdUserIds.push(noRoleUser.user.id);
    await supabase.from("users").insert({ id: noRoleUser.user.id, company_id: companyId, email: `${runTag}-norole@itest.test`, full_name: "No Role", is_active: true });

    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: noRoleUser.user.id, p_invoice_id: inv.invoiceId,
      p_channel: "visit", p_activity_type: "outcome", p_outcome: "not_paid_yet",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });
});
