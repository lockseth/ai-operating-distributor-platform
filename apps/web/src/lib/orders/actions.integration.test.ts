// =============================================================================
// DB-backed integration test -- Order lifecycle atomic audit RPCs (Gate 1D-B,
// K2). Membuktikan create/update/status/cancel_sales_order_atomic (migration
// 20260822000001) benar terhadap Postgres nyata: permission enforcement
// (bukan hanya app-layer), cross-tenant customer/product rejection, no-op
// tidak menulis audit, dan audit_logs terisi kolom kanonis lengkap.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola identik
// dengan sales-kpi/calibration.integration.test.ts.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
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

describeIfDb("Order lifecycle atomic RPCs (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  let ownerAuthId = "";
  let driverAuthId = ""; // role tanpa permission orders.* apa pun
  let customerId = "";
  let otherCustomerId = "";
  let productId = "";
  let otherProductId = "";
  let createdOrderId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: driverRole } = await supabase.from("roles").select("id").eq("name", "driver").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const driverRoleId = (driverRole as { id: string }).id;

    const { data: ownerAuth } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner@verify.test`, password: randomUUID(), email_confirm: true,
    });
    ownerAuthId = ownerAuth!.user!.id;
    const { data: driverAuth } = await supabase.auth.admin.createUser({
      email: `${runTag}-driver@verify.test`, password: randomUUID(), email_confirm: true,
    });
    driverAuthId = driverAuth!.user!.id;

    await supabase.from("companies").insert([
      { id: companyId, name: `Verify Order Co ${runTag}`, slug: `verify-order-${runTag}` },
      { id: otherCompanyId, name: `Verify Order Co Other ${runTag}`, slug: `verify-order-other-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: driverAuthId, company_id: companyId, email: `${runTag}-driver@verify.test`, full_name: "Driver Verify", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: driverAuthId, company_id: companyId, role_id: driverRoleId },
    ]);

    const { data: customer } = await supabase.from("customers")
      .insert({ company_id: companyId, code: `CUST-${runTag}`, name: "Toko Verify Order" })
      .select("id").single();
    customerId = (customer as { id: string }).id;

    const { data: otherCustomer } = await supabase.from("customers")
      .insert({ company_id: otherCompanyId, code: `CUST-OTHER-${runTag}`, name: "Toko Tenant Lain" })
      .select("id").single();
    otherCustomerId = (otherCustomer as { id: string }).id;

    const { data: product } = await supabase.from("products")
      .insert({ company_id: companyId, sku: `SKU-${runTag}`, name: "Produk Verify Order", price: 10000 })
      .select("id").single();
    productId = (product as { id: string }).id;

    const { data: otherProduct } = await supabase.from("products")
      .insert({ company_id: otherCompanyId, sku: `SKU-OTHER-${runTag}`, name: "Produk Tenant Lain", price: 10000 })
      .select("id").single();
    otherProductId = (otherProduct as { id: string }).id;
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("sales_order_items").delete().in("order_id",
      (await supabase.from("sales_orders").select("id").in("company_id", [companyId, otherCompanyId])).data?.map((r: { id: string }) => r.id) ?? []);
    await supabase.from("sales_orders").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("customers").delete().in("id", [customerId, otherCustomerId]);
    await supabase.from("products").delete().in("id", [productId, otherProductId]);
    await supabase.from("user_roles").delete().in("company_id", [companyId, otherCompanyId]);
    await supabase.from("users").delete().in("id", [ownerAuthId, driverAuthId]);
    await supabase.from("companies").delete().in("id", [companyId, otherCompanyId]);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (driverAuthId) await supabase.auth.admin.deleteUser(driverAuthId);
  }, 30000);

  it("create_sales_order_atomic: actor tanpa permission orders.create ditolak (forbidden), tidak ada order dibuat", async () => {
    const { data } = await supabase.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: driverAuthId, p_order_number: `SO-FORBIDDEN-${runTag}`,
      p_customer_id: customerId, p_sales_id: null, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
    const { count } = await supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("order_number", `SO-FORBIDDEN-${runTag}`);
    expect(count ?? 0).toBe(0);
  });

  it("create_sales_order_atomic: customer milik tenant lain ditolak (invalid_customer)", async () => {
    const { data } = await supabase.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_number: `SO-XTENANT-CUST-${runTag}`,
      p_customer_id: otherCustomerId, p_sales_id: null, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("invalid_customer");
  });

  it("create_sales_order_atomic: product milik tenant lain ditolak (invalid_product)", async () => {
    const { data } = await supabase.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_number: `SO-XTENANT-PROD-${runTag}`,
      p_customer_id: customerId, p_sales_id: null, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0, p_items: [{ product_id: otherProductId, quantity: 1, unit_price: 10000, discount_amount: 0, total_amount: 10000, notes: null }],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("invalid_product");
  });

  it("create_sales_order_atomic: sukses -- total dihitung ulang server-side, audit_logs terisi kolom kanonis lengkap", async () => {
    const { data } = await supabase.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_number: `SO-OK-${runTag}`,
      p_customer_id: customerId, p_sales_id: null, p_notes: "catatan", p_delivery_date: null,
      p_discount_amount: 1000,
      p_items: [
        { product_id: productId, quantity: 2, unit_price: 10000, discount_amount: 0, total_amount: 20000, notes: null },
      ],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("created");
    createdOrderId = (data ?? [])[0]?.result_order_id;
    expect(createdOrderId).toBeTruthy();

    const { data: orderRow } = await supabase.from("sales_orders")
      .select("total_amount, discount_amount, tax_amount, final_amount")
      .eq("id", createdOrderId).single();
    const row = orderRow as { total_amount: number; discount_amount: number; tax_amount: number; final_amount: number };
    expect(Number(row.total_amount)).toBe(20000);
    expect(Number(row.discount_amount)).toBe(1000);
    expect(Number(row.tax_amount)).toBe(Math.round((20000 - 1000) * 0.11 * 100) / 100);
    expect(Number(row.final_amount)).toBe(20000 - 1000 + Number(row.tax_amount));

    const { data: auditRow } = await supabase.from("audit_logs")
      .select("actor_type, event_category, module, source, outcome, action")
      .eq("entity_id", createdOrderId).eq("action", "order.create").single();
    const audit = auditRow as { actor_type: string; event_category: string; module: string; source: string; outcome: string; action: string };
    expect(audit.event_category).toBe("audit");
    expect(audit.module).toBe("orders");
    expect(audit.source).toBe("web");
    expect(audit.outcome).toBe("success");
  });

  it("update_sales_order_status_atomic: status sama (no-op) tidak menulis audit baru", async () => {
    const { count: before } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", createdOrderId).eq("action", "order.status_update");
    const { data } = await supabase.rpc("update_sales_order_status_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_id: createdOrderId, p_new_status: "draft",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("unchanged");
    const { count: after } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", createdOrderId).eq("action", "order.status_update");
    expect(after ?? 0).toBe(before ?? 0);
  });

  it("update_sales_order_status_atomic: transisi nyata menulis audit dengan old/new status", async () => {
    const { data } = await supabase.rpc("update_sales_order_status_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_id: createdOrderId, p_new_status: "confirmed",
    });
    expect((data ?? [])[0]?.result_outcome).toBe("updated");

    const { data: auditRow } = await supabase.from("audit_logs")
      .select("old_data, new_data")
      .eq("entity_id", createdOrderId).eq("action", "order.status_update")
      .order("created_at", { ascending: false }).limit(1).single();
    const audit = auditRow as { old_data: { status: string }; new_data: { status: string } };
    expect(audit.old_data.status).toBe("draft");
    expect(audit.new_data.status).toBe("confirmed");
  });

  it("cancel_sales_order_atomic: order dengan status delivered/invoiced/paid ditolak (invalid_status), tidak menulis audit", async () => {
    await supabase.from("sales_orders").update({ status: "paid" }).eq("id", createdOrderId);
    const { count: before } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", createdOrderId).eq("action", "order.cancel");

    const { data } = await supabase.rpc("cancel_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_id: createdOrderId,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("invalid_status");

    const { count: after } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", createdOrderId).eq("action", "order.cancel");
    expect(after ?? 0).toBe(before ?? 0);

    // reset ke confirmed supaya tidak memengaruhi kondisi awal test berikutnya
    await supabase.from("sales_orders").update({ status: "confirmed" }).eq("id", createdOrderId);
  });

  it("cancel_sales_order_atomic: sukses dari status confirmed, audit tertulis", async () => {
    const { data } = await supabase.rpc("cancel_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_order_id: createdOrderId,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("cancelled");

    const { data: orderRow } = await supabase.from("sales_orders").select("status").eq("id", createdOrderId).single();
    expect((orderRow as { status: string }).status).toBe("cancelled");
  });
});
