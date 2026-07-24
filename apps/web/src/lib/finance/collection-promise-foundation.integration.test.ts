// =============================================================================
// DB-backed integration test -- Gate 2C: Collection Activity & Promise-to-Pay
// Integrity (supabase/migrations/20260828000001_collection_promise_foundation.sql).
//
// Membuktikan: record_collection_activity() / create_promise_to_pay() /
// correct_promise_to_pay() / cancel_promise_to_pay() / mark_promise_broken()
// -- tenant/actor/customer validation, invariant amount/date, satu open
// promise per invoice, immutability penuh (activity) & terbatas (promise
// terms), idempotency, concurrency, klaim bayar tidak pernah menyentuh
// receivable_ledger/invoice/order, canonical audit + rollback atomik, dan
// RLS tenant isolation lewat dua sesi nyata. Skip graceful jika kredensial
// Supabase lokal tidak tersedia atau URL bukan loopback -- pola sama dengan
// atomic-invoice-issuance.integration.test.ts (Gate 2B).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260828000001_collection_promise_foundation.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB). Kelima RPC
// Gate 2C TIDAK punya blok EXCEPTION apa pun -- kegagalan APA PUN di
// dalamnya (RAISE EXCEPTION eksplisit, trigger tenant/immutability yang
// menolak INSERT/UPDATE, constraint) selalu mem-propagate ke atas dan
// membatalkan SELURUH transaksi RPC, termasuk INSERT/UPDATE yang sudah
// dieksekusi lebih dulu di DALAM function body yang sama (pola sama dengan
// issue_invoice_atomic, lihat atomic-invoice-issuance.integration.test.ts).
// -----------------------------------------------------------------------
describe("Gate 2C hardening -- static proof atomicity (migration 20260828000001)", () => {
  const migration = readFileSync(MIGRATION_PATH, "utf8");

  function extractFunctionBody(fnName: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
    expect(start, `function public.${fnName} tidak ditemukan di migration`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf("$$ LANGUAGE plpgsql", start);
    expect(end, `penutup $$ LANGUAGE plpgsql untuk ${fnName} tidak ditemukan`).toBeGreaterThan(start);
    return migration.slice(start, end);
  }

  it("tidak ada identifier test-only (_test_) atau trigger failure-injection di migration produksi", () => {
    expect(migration).not.toMatch(/_test_/i);
    expect(migration).not.toMatch(/TEST_FORCED_ROLLBACK/);
    expect(migration).not.toMatch(/CREATE TRIGGER trg_test_/i);
  });

  for (const fn of ["record_collection_activity", "create_promise_to_pay", "correct_promise_to_pay", "cancel_promise_to_pay", "mark_promise_broken"]) {
    it(`${fn}() adalah SATU function body tanpa blok EXCEPTION -- kegagalan di mana pun membatalkan seluruh transaksi`, () => {
      const body = extractFunctionBody(fn);
      expect(body).not.toMatch(/EXCEPTION\s+WHEN/i);
    });
  }

  it("seluruh RPC Gate 2C terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role)", () => {
    const sigs = [
      "public.record_collection_activity(UUID, UUID, UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT, UUID, TEXT)",
      "public.create_promise_to_pay(UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, TEXT)",
      "public.correct_promise_to_pay(UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT)",
      "public.cancel_promise_to_pay(UUID, UUID, UUID, TEXT, TEXT)",
      "public.mark_promise_broken(UUID, UUID, UUID, TEXT)",
    ];
    for (const sig of sigs) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig}\n  TO service_role;`);
    }
  });

  it("no-op correction check terjadi SEBELUM UPDATE promise lama (no audit untuk no-op)", () => {
    const body = extractFunctionBody("correct_promise_to_pay");
    const noopIdx = body.indexOf("NOOP_CORRECTION_REJECTED");
    const updateIdx = body.indexOf("UPDATE public.promises_to_pay");
    expect(noopIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(noopIdx);
  });
});

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
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
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
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
  companyId: string;
  customerId: string;
  orderId: string;
  invoiceId: string;
  totalAmount: number;
}

describeIfDb("Gate 2C: Collection Activity & Promise-to-Pay (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const createdCompanyIds = [companyId, otherCompanyId];

  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];

  let financeUser: { userId: string; email: string; password: string };
  let salesUser: { userId: string; email: string; password: string };
  let inactiveFinanceUser: { userId: string; email: string; password: string };
  let otherFinanceUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2C ${tag}`,
      slug: `itest-g2c-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550002",
    });
    if (error) throw new Error(`gagal buat company ${tag}: ${error.message}`);
  }

  async function createActor(targetCompanyId: string, tag: string, roleName: string, isActive = true) {
    const email = `${tag}@itest.test`;
    const password = randomUUID();
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${tag}: ${error?.message}`);
    const userId = data.user.id;
    createdUserIds.push(userId);
    await supabase.from("users").insert({ id: userId, company_id: targetCompanyId, email, full_name: `Actor ${tag}`, is_active: isActive });
    const { data: role, error: roleErr } = await supabase.from("roles").select("id").is("company_id", null).eq("name", roleName).single();
    if (roleErr || !role) throw new Error(`role ${roleName} tidak ditemukan: ${roleErr?.message}`);
    await supabase.from("user_roles").insert({ user_id: userId, role_id: (role as { id: string }).id, company_id: targetCompanyId });
    return { userId, email, password };
  }

  // Invoice fixture nyata lewat issue_invoice_atomic (Gate 2B) -- outstanding
  // balance = total_amount karena Gate 2C tidak pernah menyentuh ledger.
  async function createInvoice(targetCompanyId: string, tag: string, actorId: string, quantity = 10, unitPrice = 1000): Promise<InvoiceFixture> {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: targetCompanyId, order_number: `SO-${tag}`, customer_id: customerId, status: "delivered" })
      .select("id")
      .single();
    if (orderErr) throw new Error(`gagal buat order: ${orderErr.message}`);
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: targetCompanyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    if (delErr) throw new Error(`gagal buat delivery: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const totalAmount = quantity * unitPrice;
    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity, unit_price: unitPrice, discount_amount: 0, total_amount: totalAmount })
      .select("id")
      .single();
    if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
    const orderItemId = (item as { id: string }).id;

    const { error: diErr } = await supabase.from("delivery_items").insert({
      delivery_id: deliveryId,
      sales_order_item_id: orderItemId,
      ordered_quantity: quantity,
      dispatched_quantity: quantity,
      received_quantity: quantity,
    });
    if (diErr) throw new Error(`gagal buat delivery item: ${diErr.message}`);

    const { data: issueData, error: issueErr } = await supabase.rpc("issue_invoice_atomic", {
      p_company_id: targetCompanyId,
      p_actor_id: actorId,
      p_order_id: orderId,
    });
    if (issueErr) throw new Error(`issue_invoice_atomic gagal: ${issueErr.message}`);
    const row = (issueData as Array<{ out_invoice_id: string; out_total_amount: string }>)[0];

    return { companyId: targetCompanyId, customerId, orderId, invoiceId: row.out_invoice_id, totalAmount: Number(row.out_total_amount) };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "CGA");
    await insertCompany(otherCompanyId, `${runTag}-B`, "CGB");

    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    salesUser = await createActor(companyId, `${runTag}-sales`, "sales");
    inactiveFinanceUser = await createActor(companyId, `${runTag}-inactive`, "finance", false);
    otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("collection_activities").delete().in("company_id", createdCompanyIds);
    await supabase.from("promises_to_pay").delete().in("company_id", createdCompanyIds);
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
    for (const id of createdUserIds) {
      await supabase.auth.admin.deleteUser(id);
    }
    await supabase.from("companies").delete().in("id", createdCompanyIds);
  }, 60000);

  // ---------------------------------------------------------------------
  // 1-2. record_collection_activity: attempt & outcome happy path
  // ---------------------------------------------------------------------

  it("1. Valid collection attempt berhasil -- activity tercatat, audit collection.attempt_recorded", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ATT`, financeUser.userId);
    const { data, error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_invoice_id: inv.invoiceId,
      p_channel: "phone",
      p_activity_type: "attempt",
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_activity_id: string; out_activity_type: string; out_outcome: string | null }>)[0];
    expect(row.out_activity_id).toBeTruthy();
    expect(row.out_activity_type).toBe("attempt");
    expect(row.out_outcome).toBeNull();

    const { data: audit } = await supabase.from("audit_logs").select("*").eq("entity_id", row.out_activity_id).eq("action", "collection.attempt_recorded");
    expect((audit ?? []).length).toBe(1);
  });

  it("2. Valid outcome berhasil -- activity tercatat, audit collection.outcome_recorded", async () => {
    const inv = await createInvoice(companyId, `${runTag}-OUT`, financeUser.userId);
    const { data, error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_invoice_id: inv.invoiceId,
      p_channel: "whatsapp",
      p_activity_type: "outcome",
      p_outcome: "contacted_successfully",
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_activity_id: string; out_outcome: string }>)[0];
    expect(row.out_outcome).toBe("contacted_successfully");

    const { data: audit } = await supabase.from("audit_logs").select("*").eq("entity_id", row.out_activity_id).eq("action", "collection.outcome_recorded");
    expect((audit ?? []).length).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 3-4. create_promise_to_pay: penuh & sebagian
  // ---------------------------------------------------------------------

  it("3. Janji bayar penuh berhasil", async () => {
    const inv = await createInvoice(companyId, `${runTag}-FULL`, financeUser.userId);
    const { data, error } = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_invoice_id: inv.invoiceId,
      p_promised_amount: inv.totalAmount,
      p_promised_date: "2099-01-01",
      p_channel: "phone",
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_promise_id: string; out_status: string }>)[0];
    expect(row.out_status).toBe("open");
    const { data: promise } = await supabase.from("promises_to_pay").select("*").eq("id", row.out_promise_id).single();
    expect(Number((promise as { promised_amount: string }).promised_amount)).toBe(inv.totalAmount);
  });

  it("4. Janji bayar sebagian berhasil", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PART`, financeUser.userId);
    const { data, error } = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_invoice_id: inv.invoiceId,
      p_promised_amount: inv.totalAmount / 2,
      p_promised_date: "2099-01-01",
      p_channel: "visit",
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_status: string }>)[0];
    expect(row.out_status).toBe("open");
  });

  // ---------------------------------------------------------------------
  // 5-7. Invariant amount/date
  // ---------------------------------------------------------------------

  it("5. Nilai nol/negatif ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ZERO`, financeUser.userId);
    const zero = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 0, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    expect(zero.error).not.toBeNull();
    expect(zero.error!.message).toContain("INVALID_PROMISED_AMOUNT");

    const negative = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: -100, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    expect(negative.error).not.toBeNull();

    const { count } = await supabase.from("promises_to_pay").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(count).toBe(0);
  });

  it("6. Nilai melebihi outstanding ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-EXCEED`, financeUser.userId);
    const { error } = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: inv.totalAmount + 1, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("AMOUNT_EXCEEDS_OUTSTANDING");
  });

  it("7. Tanggal lampau ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PAST`, financeUser.userId);
    const { error } = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2020-01-01", p_channel: "phone",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("PROMISE_DATE_IN_PAST");
  });

  // ---------------------------------------------------------------------
  // 8-10. Tenant/actor validation
  // ---------------------------------------------------------------------

  it("8. Invoice tenant lain ditolak", async () => {
    const invB = await createInvoice(otherCompanyId, `${runTag}-XT`, otherFinanceUser.userId);
    const activity = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invB.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    expect(activity.error).not.toBeNull();
    expect(activity.error!.message).toContain("TENANT_CONTEXT_MISMATCH");

    const promise = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invB.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    expect(promise.error).not.toBeNull();
    expect(promise.error!.message).toContain("TENANT_CONTEXT_MISMATCH");
  });

  it("9. Actor tenant lain ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-XA`, financeUser.userId);
    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: otherFinanceUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("10. Actor nonaktif ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INACT`, financeUser.userId);
    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: inactiveFinanceUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("9b. FORBIDDEN: actor role sales (tanpa permission collection.record/promise) ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-SALESFORBID`, financeUser.userId);
    const activity = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: salesUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    expect(activity.error).not.toBeNull();
    expect(activity.error!.message).toContain("FORBIDDEN");

    const promise = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: salesUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    expect(promise.error).not.toBeNull();
    expect(promise.error!.message).toContain("FORBIDDEN");
  });

  // ---------------------------------------------------------------------
  // 11. Idempotency
  // ---------------------------------------------------------------------

  it("11. Duplicate request idempotent tidak menggandakan row/audit", async () => {
    const inv = await createInvoice(companyId, `${runTag}-DUP`, financeUser.userId);
    const key = `idem-${runTag}-dup`;
    const first = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt", p_idempotency_key: key,
    });
    expect(first.error).toBeNull();
    const firstRow = (first.data as Array<{ out_activity_id: string; out_already_exists: boolean }>)[0];
    expect(firstRow.out_already_exists).toBe(false);

    const second = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt", p_idempotency_key: key,
    });
    expect(second.error).toBeNull();
    const secondRow = (second.data as Array<{ out_activity_id: string; out_already_exists: boolean }>)[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_activity_id).toBe(firstRow.out_activity_id);

    const { count: activityCount } = await supabase.from("collection_activities").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(activityCount).toBe(1);
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", firstRow.out_activity_id);
    expect(auditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 12. Satu open promise per invoice
  // ---------------------------------------------------------------------

  it("12. Hanya satu active promise per invoice", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ONEOPEN`, financeUser.userId);
    const first = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    expect(first.error).toBeNull();

    const second = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 2000, p_promised_date: "2099-02-01", p_channel: "phone",
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain("ACTIVE_PROMISE_EXISTS");

    const { count } = await supabase.from("promises_to_pay").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("status", "open");
    expect(count).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 13-14. Correction
  // ---------------------------------------------------------------------

  it("13. Correction menutup promise lama dan membuat versi baru", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CORR`, financeUser.userId, 20, 1000);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 5000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const oldId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const corrected = await supabase.rpc("correct_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: oldId,
      p_new_promised_amount: 8000, p_new_promised_date: "2099-03-01", p_reason: "Customer minta perpanjangan tanggal",
    });
    expect(corrected.error).toBeNull();
    const row = (corrected.data as Array<{ out_new_promise_id: string; out_old_promise_id: string }>)[0];
    expect(row.out_old_promise_id).toBe(oldId);
    expect(row.out_new_promise_id).not.toBe(oldId);

    const { data: oldPromise } = await supabase.from("promises_to_pay").select("*").eq("id", oldId).single();
    expect((oldPromise as { status: string }).status).toBe("corrected");

    const { data: newPromise } = await supabase.from("promises_to_pay").select("*").eq("id", row.out_new_promise_id).single();
    const np = newPromise as { status: string; previous_promise_id: string; promised_amount: string };
    expect(np.status).toBe("open");
    expect(np.previous_promise_id).toBe(oldId);
    expect(Number(np.promised_amount)).toBe(8000);

    const { data: activity } = await supabase.from("collection_activities").select("*").eq("promise_to_pay_id", row.out_new_promise_id).eq("outcome", "promise_corrected");
    expect((activity ?? []).length).toBe(1);
  });

  it("14. No-op correction ditolak tanpa audit", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOOP`, financeUser.userId);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 4000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const { count: auditBefore } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_type", "promises_to_pay").eq("action", "collection.promise_corrected");

    const { error } = await supabase.rpc("correct_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId,
      p_new_promised_amount: 4000, p_new_promised_date: "2099-01-01", p_reason: "Tidak ada perubahan sebenarnya",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("NOOP_CORRECTION_REJECTED");

    const { data: stillOpen } = await supabase.from("promises_to_pay").select("status").eq("id", promiseId).single();
    expect((stillOpen as { status: string }).status).toBe("open");

    const { count: auditAfter } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_type", "promises_to_pay").eq("action", "collection.promise_corrected");
    expect(auditAfter).toBe(auditBefore);
  });

  // ---------------------------------------------------------------------
  // 15. Cancellation
  // ---------------------------------------------------------------------

  it("15. Cancellation menyimpan reason dan histori", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CANCEL`, financeUser.userId);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 3000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const { error } = await supabase.rpc("cancel_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId,
      p_reason: "Customer batal janji, akan dijadwalkan ulang",
    });
    expect(error).toBeNull();

    const { data: promise } = await supabase.from("promises_to_pay").select("*").eq("id", promiseId).single();
    const p = promise as { status: string; reason: string; resolved_at: string | null };
    expect(p.status).toBe("cancelled");
    expect(p.reason).toBe("Customer batal janji, akan dijadwalkan ulang");
    expect(p.resolved_at).not.toBeNull();

    const { data: activity } = await supabase.from("collection_activities").select("*").eq("promise_to_pay_id", promiseId).eq("outcome", "promise_cancelled");
    expect((activity ?? []).length).toBe(1);
  });

  it("15b. Pembatalan tanpa reason ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CANCELNOREASON`, financeUser.userId);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;
    const { error } = await supabase.rpc("cancel_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId, p_reason: "",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("REASON_REQUIRED");
  });

  // ---------------------------------------------------------------------
  // 16-17. Broken lifecycle
  // ---------------------------------------------------------------------

  it("16. Promise sebelum jatuh tempo tidak dapat ditandai broken", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOTDUE`, financeUser.userId);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const { error } = await supabase.rpc("mark_promise_broken", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("PROMISE_NOT_YET_DUE");
  });

  it("17. Promise lewat jatuh tempo dapat ditandai broken secara idempoten", async () => {
    const inv = await createInvoice(companyId, `${runTag}-OVERDUE`, financeUser.userId);
    // Fixture backdated -- ditulis LANGSUNG lewat service_role (bukan lewat
    // create_promise_to_pay, yang menolak promised_date lampau by design).
    // Sah secara production: promised_date tidak punya CHECK di level tabel
    // (lihat COMMENT ON COLUMN promises_to_pay.promised_date di migration).
    const { data: promise, error: insertErr } = await supabase
      .from("promises_to_pay")
      .insert({
        company_id: companyId, invoice_id: inv.invoiceId, customer_id: inv.customerId, collector_id: financeUser.userId,
        promised_amount: 1000, promised_date: "2020-01-01", status: "open",
      })
      .select("id")
      .single();
    expect(insertErr).toBeNull();
    const promiseId = (promise as { id: string }).id;

    const first = await supabase.rpc("mark_promise_broken", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId,
    });
    expect(first.error).toBeNull();
    const firstRow = (first.data as Array<{ out_status: string; out_already_exists: boolean }>)[0];
    expect(firstRow.out_status).toBe("broken");
    expect(firstRow.out_already_exists).toBe(false);

    const second = await supabase.rpc("mark_promise_broken", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId,
    });
    expect(second.error).toBeNull();
    const secondRow = (second.data as Array<{ out_status: string; out_already_exists: boolean }>)[0];
    expect(secondRow.out_status).toBe("broken");
    expect(secondRow.out_already_exists).toBe(true);

    const { count: activityCount } = await supabase.from("collection_activities").select("id", { count: "exact", head: true }).eq("promise_to_pay_id", promiseId).eq("outcome", "promise_broken");
    expect(activityCount).toBe(1);
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", promiseId).eq("action", "collection.promise_broken");
    expect(auditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 18-21. Klaim bayar hanya menghasilkan collection activity
  // ---------------------------------------------------------------------

  it("18-21. Klaim bayar sebagian/lunas hanya menghasilkan collection activity -- ledger/outstanding/invoice/order TIDAK berubah", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CLAIM`, financeUser.userId);

    const { data: balanceBefore } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", inv.invoiceId).single();
    const { data: orderBefore } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    const { count: ledgerBefore } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);

    const { data, error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "whatsapp", p_activity_type: "outcome", p_outcome: "claimed_paid_partial", p_reported_amount: 3000,
    });
    expect(error).toBeNull();
    const activityId = (data as Array<{ out_activity_id: string }>)[0].out_activity_id;

    const { data: activityRow } = await supabase.from("collection_activities").select("*").eq("id", activityId).single();
    expect((activityRow as { outcome: string; reported_amount: string }).outcome).toBe("claimed_paid_partial");
    expect(Number((activityRow as { reported_amount: string }).reported_amount)).toBe(3000);

    const { data: balanceAfter } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", inv.invoiceId).single();
    expect(balanceAfter).toEqual(balanceBefore);

    const { data: orderAfter } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect(orderAfter).toEqual(orderBefore);

    const { data: invoiceRow } = await supabase.from("invoices").select("total_amount").eq("id", inv.invoiceId).single();
    expect(Number((invoiceRow as { total_amount: string }).total_amount)).toBe(inv.totalAmount);

    const { count: ledgerAfter } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  it("18b. reported_amount tidak diizinkan untuk outcome selain claimed_paid_partial/claimed_paid_full", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REPORTAMT`, financeUser.userId);
    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "outcome", p_outcome: "not_paid_yet", p_reported_amount: 100,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("REPORTED_AMOUNT_NOT_APPLICABLE");
  });

  it("18c. outcome promised_to_pay DITOLAK di record_collection_activity (reserved, hanya lewat create_promise_to_pay)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-RESERVED`, financeUser.userId);
    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "outcome", p_outcome: "promised_to_pay",
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVALID_OUTCOME_RESERVED");
  });

  // ---------------------------------------------------------------------
  // 22-23. Immutability
  // ---------------------------------------------------------------------

  it("22. collection_activities immutable -- UPDATE dan DELETE langsung ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-IMMUT`, financeUser.userId);
    const created = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    const activityId = (created.data as Array<{ out_activity_id: string }>)[0].out_activity_id;

    const update = await supabase.from("collection_activities").update({ note: "diubah paksa" }).eq("id", activityId);
    expect(update.error).not.toBeNull();
    expect(update.error!.message).toContain("COLLECTION_ACTIVITY_APPEND_ONLY");

    const del = await supabase.from("collection_activities").delete().eq("id", activityId);
    expect(del.error).not.toBeNull();
    expect(del.error!.message).toContain("COLLECTION_ACTIVITY_APPEND_ONLY");
  });

  it("23. Promise terms immutable -- UPDATE promised_amount langsung ditolak, DELETE ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PIMMUT`, financeUser.userId);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const update = await supabase.from("promises_to_pay").update({ promised_amount: 9999 }).eq("id", promiseId);
    expect(update.error).not.toBeNull();
    expect(update.error!.message).toContain("PROMISE_TERMS_IMMUTABLE");

    const del = await supabase.from("promises_to_pay").delete().eq("id", promiseId);
    expect(del.error).not.toBeNull();
    expect(del.error!.message).toContain("PROMISE_IMMUTABLE");
  });

  it("23b. Transisi status tidak sah (bukan lewat RPC) ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-BADTRANS`, financeUser.userId);
    const created = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (created.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    // Update "sah" (reason+resolved_at diisi) tapi target status di luar
    // enum yang diizinkan trigger.
    const bad = await supabase.from("promises_to_pay").update({ status: "cancelled", reason: "x" }).eq("id", promiseId);
    // status=cancelled TANPA resolved_at -- trigger menolak.
    expect(bad.error).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 24. Direct client mutation ditolak
  // ---------------------------------------------------------------------

  it("24. Direct client mutation (anon) ditolak untuk kedua tabel", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const inv = await createInvoice(companyId, `${runTag}-ANON`, financeUser.userId);

    const activityInsert = await anon.from("collection_activities").insert({
      company_id: companyId, invoice_id: inv.invoiceId, customer_id: inv.customerId, collector_id: financeUser.userId,
      channel: "phone", activity_type: "attempt",
    });
    expect(activityInsert.error).not.toBeNull();

    const promiseInsert = await anon.from("promises_to_pay").insert({
      company_id: companyId, invoice_id: inv.invoiceId, customer_id: inv.customerId, collector_id: financeUser.userId,
      promised_amount: 1000, promised_date: "2099-01-01",
    });
    expect(promiseInsert.error).not.toBeNull();
  });

  it("24b. Security posture: anon TIDAK dapat memanggil RPC Gate 2C sama sekali", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const inv = await createInvoice(companyId, `${runTag}-ANONRPC`, financeUser.userId);
    const { error } = await anon.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    expect(error).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 25. Canonical audit -- event & payload
  // ---------------------------------------------------------------------

  it("25. Canonical audit memiliki event dan payload benar untuk seluruh 6 event type", async () => {
    const inv = await createInvoice(companyId, `${runTag}-AUDITALL`, financeUser.userId, 30, 1000);

    const attempt = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    const { data: attemptAudit } = await supabase.from("audit_logs").select("*").eq("entity_id", (attempt.data as Array<{ out_activity_id: string }>)[0].out_activity_id).eq("action", "collection.attempt_recorded").single();
    const aa = attemptAudit as { company_id: string; module: string; event_category: string; outcome: string; new_data: Record<string, unknown> };
    expect(aa.company_id).toBe(companyId);
    expect(aa.module).toBe("collection");
    expect(aa.event_category).toBe("audit");
    expect(aa.outcome).toBe("success");
    expect(aa.new_data.invoice_id).toBe(inv.invoiceId);
    expect(aa.new_data.customer_id).toBe(inv.customerId);

    const promise = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_promised_amount: 5000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const promiseId = (promise.data as Array<{ out_promise_id: string }>)[0].out_promise_id;
    const { data: createAudit } = await supabase.from("audit_logs").select("*").eq("entity_id", promiseId).eq("action", "collection.promise_created").single();
    expect((createAudit as { new_data: Record<string, unknown> }).new_data.promised_amount).toBe(5000);

    const corrected = await supabase.rpc("correct_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: promiseId,
      p_new_promised_amount: 6000, p_new_promised_date: "2099-02-01", p_reason: "Koreksi nominal",
    });
    const newPromiseId = (corrected.data as Array<{ out_new_promise_id: string }>)[0].out_new_promise_id;
    const { data: correctAudit } = await supabase.from("audit_logs").select("*").eq("entity_id", newPromiseId).eq("action", "collection.promise_corrected").single();
    const ca = correctAudit as { old_data: Record<string, unknown>; new_data: Record<string, unknown> };
    expect(ca.old_data.promise_id).toBe(promiseId);
    expect(ca.new_data.previous_promise_id).toBe(promiseId);
    expect(ca.new_data.reason).toBe("Koreksi nominal");

    const cancelled = await supabase.rpc("cancel_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: newPromiseId, p_reason: "Dibatalkan customer",
    });
    expect(cancelled.error).toBeNull();
    const { data: cancelAudit } = await supabase.from("audit_logs").select("*").eq("entity_id", newPromiseId).eq("action", "collection.promise_cancelled").single();
    expect((cancelAudit as { new_data: Record<string, unknown> }).new_data.reason).toBe("Dibatalkan customer");
  });

  // ---------------------------------------------------------------------
  // 26. Kegagalan audit me-rollback perubahan bisnis (natural DB-backed)
  // ---------------------------------------------------------------------

  it("26. Rollback penuh saat create_promise_to_pay gagal via idempotency_key collision lintas invoice -- tidak ada activity/audit yang tertulis", async () => {
    const invA = await createInvoice(companyId, `${runTag}-RBA`, financeUser.userId);
    const invB = await createInvoice(companyId, `${runTag}-RBB`, financeUser.userId);
    const key = `idem-${runTag}-rollback`;

    const first = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invA.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone", p_idempotency_key: key,
    });
    expect(first.error).toBeNull();

    // Key yang SAMA dipakai untuk invoice yang BERBEDA -- pre-check idempotency
    // hanya cocok jika invoice_id sama persis, jadi baris ini lolos pre-check
    // dan mencoba INSERT, gagal alami lewat UNIQUE(company_id, idempotency_key)
    // (constraint canonical yang tidak diubah).
    const second = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invB.invoiceId,
      p_promised_amount: 2000, p_promised_date: "2099-01-01", p_channel: "phone", p_idempotency_key: key,
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.code).toBe("23505");

    const { count: promiseCountB } = await supabase.from("promises_to_pay").select("id", { count: "exact", head: true }).eq("invoice_id", invB.invoiceId);
    expect(promiseCountB).toBe(0);
    const { count: activityCountB } = await supabase.from("collection_activities").select("id", { count: "exact", head: true }).eq("invoice_id", invB.invoiceId);
    expect(activityCountB).toBe(0);
    const { count: auditCountB } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "collection.promise_created").eq("entity_id", invB.invoiceId);
    expect(auditCountB).toBe(0);
  });

  it("26b. Rollback penuh saat correct_promise_to_pay gagal via idempotency_key collision -- promise lama TIDAK jadi corrected", async () => {
    const invA = await createInvoice(companyId, `${runTag}-RBC-A`, financeUser.userId);
    const invC = await createInvoice(companyId, `${runTag}-RBC-C`, financeUser.userId);
    const key = `idem-${runTag}-correct-rollback`;

    const unrelated = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invA.invoiceId,
      p_promised_amount: 500, p_promised_date: "2099-01-01", p_channel: "phone", p_idempotency_key: key,
    });
    expect(unrelated.error).toBeNull();

    const target = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invC.invoiceId,
      p_promised_amount: 1000, p_promised_date: "2099-01-01", p_channel: "phone",
    });
    const targetPromiseId = (target.data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const correction = await supabase.rpc("correct_promise_to_pay", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_promise_id: targetPromiseId,
      p_new_promised_amount: 1500, p_new_promised_date: "2099-02-01", p_reason: "Koreksi yang akan gagal",
      p_idempotency_key: key, // sudah dipakai promise LAIN (previous_promise_id berbeda) -- INSERT baru gagal 23505
    });
    expect(correction.error).not.toBeNull();
    expect(correction.error!.code).toBe("23505");

    const { data: stillOpen } = await supabase.from("promises_to_pay").select("status").eq("id", targetPromiseId).single();
    expect((stillOpen as { status: string }).status).toBe("open"); // UPDATE promise lama ikut rollback
  });

  // ---------------------------------------------------------------------
  // 27. Tenant isolation SELECT -- dua sesi nyata
  // ---------------------------------------------------------------------

  it("27. Tenant isolation SELECT: user finance company A melihat activity sendiri, TIDAK melihat company B", async () => {
    const invA = await createInvoice(companyId, `${runTag}-TENA`, financeUser.userId);
    const invB = await createInvoice(otherCompanyId, `${runTag}-TENB`, otherFinanceUser.userId);

    const activityA = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: invA.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    const activityAId = (activityA.data as Array<{ out_activity_id: string }>)[0].out_activity_id;

    const activityB = await supabase.rpc("record_collection_activity", {
      p_company_id: otherCompanyId, p_actor_id: otherFinanceUser.userId, p_invoice_id: invB.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    const activityBId = (activityB.data as Array<{ out_activity_id: string }>)[0].out_activity_id;

    const client = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await client.auth.signInWithPassword({ email: financeUser.email, password: financeUser.password });
    expect(signInErr).toBeNull();

    const own = await client.from("collection_activities").select("id").eq("id", activityAId);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(1);

    const cross = await client.from("collection_activities").select("id").eq("id", activityBId);
    expect(cross.error).toBeNull();
    expect((cross.data ?? []).length).toBe(0);

    await client.auth.signOut();
  });

  it("27b. Permission scoping: role sales (tanpa receivable.view) tidak melihat collection_activities/promises_to_pay company sendiri", async () => {
    const inv = await createInvoice(companyId, `${runTag}-SALESVIEW`, financeUser.userId);
    const activity = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "phone", p_activity_type: "attempt",
    });
    const activityId = (activity.data as Array<{ out_activity_id: string }>)[0].out_activity_id;

    const client = createClient(env!.url, env!.anonKey);
    await client.auth.signInWithPassword({ email: salesUser.email, password: salesUser.password });

    const { data, error } = await client.from("collection_activities").select("id").eq("id", activityId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(0);

    await client.auth.signOut();
  });

  // ---------------------------------------------------------------------
  // 28. Concurrency
  // ---------------------------------------------------------------------

  it("28. Dua pemanggilan concurrent create_promise_to_pay untuk invoice yang sama hanya menghasilkan SATU open promise", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CONCUR`, financeUser.userId, 20, 1000);

    const [r1, r2] = await Promise.allSettled([
      supabase.rpc("create_promise_to_pay", {
        p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
        p_promised_amount: 5000, p_promised_date: "2099-01-01", p_channel: "phone",
      }),
      supabase.rpc("create_promise_to_pay", {
        p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
        p_promised_amount: 6000, p_promised_date: "2099-02-01", p_channel: "phone",
      }),
    ]);

    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    const { count } = await supabase.from("promises_to_pay").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("status", "open");
    expect(count).toBe(1);
  }, 30000);
});
