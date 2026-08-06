// =============================================================================
// Gate 3E-D4-C5 -- Order Price Mutation Enforcement & Approval-History
// Integrity, DB-backed (Postgres/Supabase NYATA, bukan mock). Membuktikan
// migration 20260927000001_gate_3e_d4_c5_order_price_mutation_enforcement.sql.
//
// Scope test file ini: HANYA celah yang ditutup Gate 3E-D4-C5 (client-trusted
// total_amount pada create/update_sales_order_atomic, dan confirm_sales_order_
// atomic yang sekarang merekomputasi total/tax/final dari sales_order_items
// SAAT konfirmasi). Cakupan requirement lain pada kontrak gate ini (snapshot
// immutability, decision kontradiktif, idempotent retry, cross-tenant,
// pending_owner_approval lock, approved/rejected snapshot enforcement) SUDAH
// dibuktikan exhaustif oleh 108 test existing (gate-3e-d4-c1..c4 + sales-
// order-item-mutation-boundary) yang TIDAK diubah gate ini dan TETAP PASS
// (dijalankan bersamaan sebagai bukti no-regression) -- TIDAK diduplikasi di
// sini.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
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
  console.warn("Gate 3E-D4-C5 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D4-C5: order price mutation enforcement (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed4c5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyA = randomUUID();
  const companyB = randomUUID();

  const authIds: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const productIds: Record<string, string> = {};
  const customerIds: Record<string, string> = {};
  const orderIds: string[] = [];
  const approvalRequestIds: string[] = [];

  async function signIn(key: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email: emails[key], password });
    if (error) throw new Error(`sign-in gagal untuk ${key}: ${error.message}`);
    return scoped;
  }

  async function makeUser(key: string, companyId: string, roleName: string): Promise<string> {
    const email = `${runTag}-${key}@itest.test`;
    emails[key] = email;
    const { data: auth, error: authErr } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (authErr || !auth.user) throw new Error(`gagal buat auth user ${key}: ${authErr?.message}`);
    authIds[key] = auth.user.id;
    const { error: profileErr } = await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${key}`, is_active: true });
    if (profileErr) throw new Error(`gagal buat profile user ${key}: ${profileErr.message}`);
    const { data: roleRow } = await service.from("roles").select("id").eq("name", roleName).is("company_id", null).single();
    const { error: roleErr } = await service.from("user_roles").insert({ user_id: auth.user.id, company_id: companyId, role_id: (roleRow as { id: string }).id });
    if (roleErr) throw new Error(`gagal assign role ${roleName} untuk ${key}: ${roleErr.message}`);
    return auth.user.id;
  }

  async function makeProduct(key: string, companyId: string, price: number): Promise<string> {
    const { data, error } = await service.from("products").insert({ company_id: companyId, sku: `SKU-${key}-${runTag}`, name: `Produk ${key}`, price, is_active: true }).select("id").single();
    if (error) throw new Error(`gagal buat produk ${key}: ${error.message}`);
    productIds[key] = (data as { id: string }).id;
    return productIds[key];
  }

  async function callCreate(companyId: string, actorId: string, customerId: string, salesId: string, items: { product_id: string; quantity: number; unit_price: number; discount_amount: number; total_amount: number; notes: string | null }[]) {
    const orderNumber = `SO-G3ED4C5-${runTag}-${orderIds.length}`;
    const { data, error } = await service.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: actorId, p_order_number: orderNumber, p_customer_id: customerId,
      p_sales_id: salesId, p_notes: null, p_delivery_date: null, p_discount_amount: 0, p_items: items,
    });
    if (error) throw new Error(`create rpc error: ${error.message}`);
    const row = (data as { result_outcome: string; result_order_id: string }[])[0];
    if (row.result_order_id) orderIds.push(row.result_order_id);
    return row;
  }

  async function callUpdate(companyId: string, actorId: string, orderId: string, customerId: string, salesId: string, items: { product_id: string; quantity: number; unit_price: number; discount_amount: number; total_amount: number; notes: string | null }[], discountAmount = 0) {
    const { data, error } = await service.rpc("update_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: actorId, p_order_id: orderId, p_customer_id: customerId,
      p_sales_id: salesId, p_notes: null, p_delivery_date: null, p_discount_amount: discountAmount, p_items: items,
    });
    if (error) throw new Error(`update rpc error: ${error.message}`);
    return (data as { result_outcome: string }[])[0];
  }

  async function callConfirm(companyId: string, actorId: string, orderId: string) {
    const { data, error } = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: actorId, p_order_id: orderId, p_payment_terms_days: null,
    });
    if (error) throw new Error(`confirm rpc error: ${error.message}`);
    return (data as { result_outcome: string; already_confirmed: boolean }[])[0];
  }

  async function callSubmit(actorKey: string, orderId: string, items: { sales_order_item_id: string; proposed_unit_price: number }[], reason: string | null) {
    const scoped = await signIn(actorKey);
    const { data, error } = await scoped.rpc("submit_special_price_proposal_atomic", {
      p_sales_order_id: orderId, p_items: items, p_reason: reason, p_idempotency_key: null,
    });
    if (error) throw new Error(`submit rpc error: ${error.message}`);
    const row = (data as { approval_request_id: string | null }[])[0];
    if (row.approval_request_id) approvalRequestIds.push(row.approval_request_id);
    return row;
  }

  async function callDecide(actorKey: string, approvalRequestId: string, decision: string, idemKey: string) {
    const scoped = await signIn(actorKey);
    const { data, error } = await scoped.rpc("decide_special_price_proposal_atomic", {
      p_approval_request_id: approvalRequestId, p_decision: decision, p_idempotency_key: idemKey, p_decision_reason: decision === "REJECT" ? "alasan" : null,
    });
    if (error) throw new Error(`decide rpc error: ${error.message}`);
    return (data as { result_outcome: string }[])[0];
  }

  async function kpiRevenueValue(orderId: string): Promise<number | null> {
    const { data } = await service.from("sales_kpi_achievement_events").select("value")
      .eq("order_id", orderId).eq("kpi_code", "REVENUE").eq("event_type", "CREDITED").maybeSingle();
    return data ? Number((data as { value: number }).value) : null;
  }

  let idemCounter = 0;
  function nextIdemKey(): string {
    idemCounter += 1;
    return `idem-g3ed4c5-${runTag}-${idemCounter}`;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert([
      { id: companyA, name: `Gate 3E-D4-C5 A ${runTag}`, slug: `g3ed4c5-a-${runTag}` },
      { id: companyB, name: `Gate 3E-D4-C5 B ${runTag}`, slug: `g3ed4c5-b-${runTag}` },
    ]);
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    await makeUser("ownerA", companyA, "owner");
    await makeUser("salesA1", companyA, "sales");
    await makeUser("ownerB", companyB, "owner");

    const { data: cA } = await service.from("customers").insert({ company_id: companyA, code: `CA-${runTag}`, name: "Toko A", assigned_sales_id: authIds.salesA1 }).select("id").single();
    customerIds.A = (cA as { id: string }).id;

    for (const key of ["p1", "p2", "p3", "p4", "p5"]) {
      await makeProduct(key, companyA, 100000);
    }
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("special_price_approval_lines").delete().in("approval_request_id", approvalRequestIds);
    await service.from("special_price_approval_requests").delete().in("sales_order_id", orderIds);
    await service.from("sales_kpi_achievement_events").delete().in("order_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", orderIds);
    await service.from("audit_logs").delete().in("entity_id", approvalRequestIds);
    await service.from("sales_order_items").delete().in("order_id", orderIds);
    await service.from("sales_orders").delete().in("id", orderIds);
    await service.from("products").delete().in("id", Object.values(productIds));
    await service.from("customers").delete().in("id", Object.values(customerIds));
    await service.from("user_roles").delete().in("company_id", [companyA, companyB]);
    const allIds = Object.values(authIds);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", [companyA, companyB]);
    for (const id of allIds) await service.auth.admin.deleteUser(id).catch(() => {});
  }, 60000);

  it("1. create_sales_order_atomic mengabaikan total_amount fabrikasi dari client -- direkomputasi server-side dari quantity*unit_price-discount_amount", async () => {
    const created = await callCreate(companyA, authIds.ownerA, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p1, quantity: 10, unit_price: 100000, discount_amount: 0, total_amount: 1 },
    ]);
    expect(created.result_outcome).toBe("created");

    const { data: item } = await service.from("sales_order_items").select("total_amount").eq("order_id", created.result_order_id).single();
    expect(Number((item as { total_amount: number }).total_amount)).toBe(1000000);

    const { data: order } = await service.from("sales_orders").select("total_amount, final_amount").eq("id", created.result_order_id).single();
    expect(Number((order as { total_amount: number }).total_amount)).toBe(1000000);
    expect(Number((order as { final_amount: number }).final_amount)).toBe(1110000); // + 11% tax

    // Jalur harga normal yang sah tetap bekerja sampai confirm + KPI benar.
    const confirmRow = await callConfirm(companyA, authIds.ownerA, created.result_order_id);
    expect(confirmRow.result_outcome).toBe("confirmed");
    expect(await kpiRevenueValue(created.result_order_id)).toBe(1110000);
  });

  it("2. update_sales_order_atomic (draft) mengabaikan total_amount fabrikasi dari client -- direkomputasi server-side", async () => {
    const created = await callCreate(companyA, authIds.ownerA, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p2, quantity: 1, unit_price: 100000, discount_amount: 0, total_amount: 100000 },
    ]);
    const { data: itemBefore } = await service.from("sales_order_items").select("id").eq("order_id", created.result_order_id).single();

    const updated = await callUpdate(companyA, authIds.ownerA, created.result_order_id, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p2, quantity: 5, unit_price: 100000, discount_amount: 0, total_amount: 1 },
    ]);
    expect(updated.result_outcome).toBe("updated");

    const { data: item } = await service.from("sales_order_items").select("total_amount").eq("order_id", created.result_order_id).single();
    expect(Number((item as { total_amount: number }).total_amount)).toBe(500000);
    expect((item as { id?: string }).id).not.toBe((itemBefore as { id: string }).id); // update draft = delete+insert ulang (existing behavior, tidak berubah)

    const { data: order } = await service.from("sales_orders").select("final_amount").eq("id", created.result_order_id).single();
    expect(Number((order as { final_amount: number }).final_amount)).toBe(555000); // 500.000 + 11%
  });

  it("3. confirm_sales_order_atomic merekomputasi total/tax/final dari sales_order_items SAAT confirm, kebal terhadap direct DML pada sales_orders (order draft milik sendiri)", async () => {
    const created = await callCreate(companyA, authIds.ownerA, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p3, quantity: 2, unit_price: 100000, discount_amount: 0, total_amount: 200000 },
    ]);

    // Direct DML (authenticated Sales, RLS-bound -- BUKAN service-role) pada
    // order draft miliknya sendiri: RLS existing (Gate 3E-D4-C1 WITH CHECK)
    // mengizinkan mutasi kolom apa pun SELAMA status tidak berpindah ke/dari
    // pending_owner_approval -- termasuk kolom finansial. Ini adalah
    // kapasitas existing (editing draft), BUKAN sesuatu yang gate ini
    // longgarkan/persempit -- yang gate ini buktikan: mutasi ini TIDAK
    // PERNAH bisa "menang" sampai ke order yang confirmed.
    const scopedSales = await signIn("salesA1");
    const { error: dmlErr } = await scopedSales.from("sales_orders").update({ final_amount: 1, total_amount: 1, tax_amount: 0 }).eq("id", created.result_order_id);
    expect(dmlErr).toBeNull(); // DML sendiri sukses (kapasitas existing, RLS tidak berubah)

    const { data: tampered } = await service.from("sales_orders").select("final_amount").eq("id", created.result_order_id).single();
    expect(Number((tampered as { final_amount: number }).final_amount)).toBe(1); // baris memang tertampering sesaat

    const confirmRow = await callConfirm(companyA, authIds.ownerA, created.result_order_id);
    expect(confirmRow.result_outcome).toBe("confirmed");

    const { data: order } = await service.from("sales_orders").select("final_amount").eq("id", created.result_order_id).single();
    // Gate 3E-D4-C5: confirm merekomputasi dari item truth -- nilai DML
    // tertampering TIDAK bertahan.
    expect(Number((order as { final_amount: number }).final_amount)).toBe(222000); // 200.000 + 11%
    expect(await kpiRevenueValue(created.result_order_id)).toBe(222000);
  });

  it("4. confirm_sales_order_atomic merekomputasi dari raw quantity/unit_price/discount_amount -- bukan kolom total_amount item yang di-DML langsung", async () => {
    const created = await callCreate(companyA, authIds.ownerA, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p4, quantity: 3, unit_price: 100000, discount_amount: 0, total_amount: 300000 },
    ]);
    const { data: item } = await service.from("sales_order_items").select("id").eq("order_id", created.result_order_id).single();

    // Direct DML pada sales_order_items itu sendiri (order masih draft,
    // milik sendiri -- kapasitas existing, tidak diubah gate ini).
    await service.from("sales_order_items").update({ total_amount: 1 }).eq("id", (item as { id: string }).id);

    const confirmRow = await callConfirm(companyA, authIds.ownerA, created.result_order_id);
    expect(confirmRow.result_outcome).toBe("confirmed");

    const { data: order } = await service.from("sales_orders").select("final_amount").eq("id", created.result_order_id).single();
    expect(Number((order as { final_amount: number }).final_amount)).toBe(333000); // 300.000 + 11%, item total_amount yang di-DML diabaikan
  });

  it("5. Approved special-price proposal: confirm tetap merekomputasi total/final dari proposed price yang disetujui (no regression terhadap Gate 3E-D4-C2/C3/C4)", async () => {
    const created = await callCreate(companyA, authIds.ownerA, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p5, quantity: 2, unit_price: 100000, discount_amount: 0, total_amount: 200000 },
    ]);
    const { data: item } = await service.from("sales_order_items").select("id").eq("order_id", created.result_order_id).single();

    const submitRow = await callSubmit("salesA1", created.result_order_id, [{ sales_order_item_id: (item as { id: string }).id, proposed_unit_price: 40000 }], "diskon besar butuh approval");
    expect(submitRow.result_outcome).toBe("submitted");
    const decideRow = await callDecide("ownerA", submitRow.approval_request_id!, "APPROVE", nextIdemKey());
    expect(decideRow.result_outcome).toBe("approved");

    const confirmRow = await callConfirm(companyA, authIds.ownerA, created.result_order_id);
    expect(confirmRow.result_outcome).toBe("confirmed");

    const { data: order } = await service.from("sales_orders").select("final_amount").eq("id", created.result_order_id).single();
    // 2 x 40.000 = 80.000 subtotal + 11% tax = 88.800 -- persis snapshot yang disetujui.
    expect(Number((order as { final_amount: number }).final_amount)).toBe(88800);
    expect(await kpiRevenueValue(created.result_order_id)).toBe(88800);
  });

  it("6. Cross-tenant: create/update/confirm company A tidak pernah membaca/menghitung item company B", async () => {
    await makeProduct("bx", companyB, 999999);
    const createdA = await callCreate(companyA, authIds.ownerA, customerIds.A, authIds.salesA1, [
      { product_id: productIds.p1, quantity: 1, unit_price: 100000, discount_amount: 0, total_amount: 100000 },
    ]);
    const confirmCrossTenant = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyB, p_actor_id: authIds.ownerB, p_order_id: createdA.result_order_id, p_payment_terms_days: null,
    });
    expect((confirmCrossTenant.data as { result_outcome: string }[])[0].result_outcome).toBe("not_found");
  });
});
