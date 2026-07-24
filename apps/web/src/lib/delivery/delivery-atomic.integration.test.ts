// =============================================================================
// DB-backed integration test -- Delivery lifecycle atomic audit RPCs (Gate
// 1D-B, K4). Membuktikan create/dispatch/finalize_delivery_atomic (migration
// 20260823000001) benar terhadap Postgres nyata: kasus kritis wajib gate ini
// (order 300 dus, kirim 300, terima 150 -- audit membuktikan quantity sent,
// received, selisih, siapa konfirmasi, referensi bukti), permission
// enforcement, no-op tidak menulis audit, dan quantity-exceeds-outstanding
// tidak menulis apa pun (rollback penuh).
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola identik
// dengan orders/actions.integration.test.ts.
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

describeIfDb("Delivery lifecycle atomic RPCs (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-delivery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  let ownerAuthId = "";
  let driverAuthId = "";
  let outsiderAuthId = ""; // active user, no delivery.manage, bukan assigned driver
  let customerId = "";
  let productId = "";
  let orderId = "";
  let orderItemId = "";
  let deliveryId = "";

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const { data: driverRole } = await supabase.from("roles").select("id").eq("name", "driver").single();
    const ownerRoleId = (ownerRole as { id: string }).id;
    const driverRoleId = (driverRole as { id: string }).id;

    const { data: ownerAuth } = await supabase.auth.admin.createUser({ email: `${runTag}-owner@verify.test`, password: randomUUID(), email_confirm: true });
    ownerAuthId = ownerAuth!.user!.id;
    const { data: driverAuth } = await supabase.auth.admin.createUser({ email: `${runTag}-driver@verify.test`, password: randomUUID(), email_confirm: true });
    driverAuthId = driverAuth!.user!.id;
    const { data: outsiderAuth } = await supabase.auth.admin.createUser({ email: `${runTag}-outsider@verify.test`, password: randomUUID(), email_confirm: true });
    outsiderAuthId = outsiderAuth!.user!.id;

    await supabase.from("companies").insert({ id: companyId, name: `Verify Delivery Co ${runTag}`, slug: `verify-delivery-${runTag}` });
    await supabase.from("users").insert([
      { id: ownerAuthId, company_id: companyId, email: `${runTag}-owner@verify.test`, full_name: "Owner Verify", is_active: true },
      { id: driverAuthId, company_id: companyId, email: `${runTag}-driver@verify.test`, full_name: "Driver Verify", is_active: true },
      { id: outsiderAuthId, company_id: companyId, email: `${runTag}-outsider@verify.test`, full_name: "Outsider Verify", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAuthId, company_id: companyId, role_id: ownerRoleId },
      { user_id: driverAuthId, company_id: companyId, role_id: driverRoleId },
    ]);

    const { data: customer } = await supabase.from("customers").insert({ company_id: companyId, code: `CUST-${runTag}`, name: "Toko Verify Delivery" }).select("id").single();
    customerId = (customer as { id: string }).id;
    const { data: product } = await supabase.from("products").insert({ company_id: companyId, sku: `SKU-${runTag}`, name: "Cat Mawar", price: 100000 }).select("id").single();
    productId = (product as { id: string }).id;

    const { data: order } = await supabase.from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}`, customer_id: customerId, status: "confirmed" })
      .select("id").single();
    orderId = (order as { id: string }).id;
    const { data: orderItem } = await supabase.from("sales_order_items")
      .insert({ order_id: orderId, product_id: productId, quantity: 300, unit_price: 100000, total_amount: 30000000 })
      .select("id").single();
    orderItemId = (orderItem as { id: string }).id;
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("delivery_exceptions").delete().eq("company_id", companyId);
    await supabase.from("delivery_recipients").delete().eq("company_id", companyId);
    await supabase.from("delivery_items").delete().in("delivery_id",
      (await supabase.from("deliveries").select("id").eq("company_id", companyId)).data?.map((r: { id: string }) => r.id) ?? []);
    await supabase.from("deliveries").delete().eq("company_id", companyId);
    await supabase.from("sales_order_items").delete().eq("order_id", orderId);
    await supabase.from("sales_orders").delete().eq("company_id", companyId);
    await supabase.from("customers").delete().eq("id", customerId);
    await supabase.from("products").delete().eq("id", productId);
    await supabase.from("user_roles").delete().eq("company_id", companyId);
    await supabase.from("users").delete().in("id", [ownerAuthId, driverAuthId, outsiderAuthId]);
    await supabase.from("companies").delete().eq("id", companyId);
    if (ownerAuthId) await supabase.auth.admin.deleteUser(ownerAuthId);
    if (driverAuthId) await supabase.auth.admin.deleteUser(driverAuthId);
    if (outsiderAuthId) await supabase.auth.admin.deleteUser(outsiderAuthId);
  }, 30000);

  it("create_delivery_atomic: actor tanpa delivery.manage ditolak (forbidden)", async () => {
    const { data } = await supabase.rpc("create_delivery_atomic", {
      p_company_id: companyId, p_actor_id: outsiderAuthId, p_sales_order_id: orderId,
      p_idempotency_key: null, p_driver_id: driverAuthId,
      p_items: [{ sales_order_item_id: orderItemId, ordered_quantity: 300 }],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("create_delivery_atomic: sukses -- delivery 'planned', driver ter-assign, audit_logs 'delivery.create'", async () => {
    const { data } = await supabase.rpc("create_delivery_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_sales_order_id: orderId,
      p_idempotency_key: `itest:${runTag}`, p_driver_id: driverAuthId,
      p_items: [{ sales_order_item_id: orderItemId, ordered_quantity: 300 }],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("created");
    deliveryId = (data ?? [])[0]?.result_delivery_id;
    expect(deliveryId).toBeTruthy();

    const { data: deliveryRow } = await supabase.from("deliveries").select("status, assigned_driver_id").eq("id", deliveryId).single();
    expect((deliveryRow as { status: string }).status).toBe("planned");
    expect((deliveryRow as { assigned_driver_id: string }).assigned_driver_id).toBe(driverAuthId);

    const { data: auditRow } = await supabase.from("audit_logs")
      .select("event_category, module, source, outcome").eq("entity_id", deliveryId).eq("action", "delivery.create").single();
    const audit = auditRow as { event_category: string; module: string; source: string; outcome: string };
    expect(audit.event_category).toBe("audit");
    expect(audit.module).toBe("delivery");
    expect(audit.outcome).toBe("success");
  });

  it("dispatch_delivery_atomic: actor bukan driver yang ditugaskan dan bukan delivery.manage ditolak", async () => {
    const { data } = await supabase.rpc("dispatch_delivery_atomic", {
      p_company_id: companyId, p_actor_id: outsiderAuthId, p_delivery_id: deliveryId,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("dispatch_delivery_atomic: driver yang ditugaskan sukses dispatch, audit tertulis", async () => {
    const { data } = await supabase.rpc("dispatch_delivery_atomic", {
      p_company_id: companyId, p_actor_id: driverAuthId, p_delivery_id: deliveryId,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("dispatched");

    const { data: itemsRow } = await supabase.from("delivery_items").select("dispatched_quantity").eq("delivery_id", deliveryId).single();
    expect(Number((itemsRow as { dispatched_quantity: number }).dispatched_quantity)).toBe(300);
  });

  it("dispatch_delivery_atomic: retry (sudah dispatched) -- no-op, tidak ada audit baru", async () => {
    const { count: before } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", deliveryId).eq("action", "delivery.dispatch");
    const { data } = await supabase.rpc("dispatch_delivery_atomic", {
      p_company_id: companyId, p_actor_id: driverAuthId, p_delivery_id: deliveryId,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("unchanged");
    const { count: after } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", deliveryId).eq("action", "delivery.dispatch");
    expect(after ?? 0).toBe(before ?? 0);
  });

  it("finalize_delivery_atomic: KASUS KRITIS -- 300 dikirim, 150 diterima, audit membuktikan quantity sent/received/selisih/penerima", async () => {
    const { data: itemRow } = await supabase.from("delivery_items").select("id").eq("delivery_id", deliveryId).single();
    const deliveryItemId = (itemRow as { id: string }).id;

    const { data } = await supabase.rpc("finalize_delivery_atomic", {
      p_company_id: companyId, p_actor_id: driverAuthId, p_delivery_id: deliveryId,
      p_final_status: "partially_received",
      p_item_outcomes: [{ delivery_item_id: deliveryItemId, received_quantity: 150, rejected_quantity: 0, returned_quantity: 0, unresolved_quantity: 150 }],
      p_reason_code: "CUSTOMER_PARTIAL_ACCEPTANCE", p_reason_note: null, p_severity: "high",
      p_recipient_name: "Pak Waluyo", p_is_expected_pic: true,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("finalized");

    const { data: deliveryRow } = await supabase.from("deliveries").select("status").eq("id", deliveryId).single();
    expect((deliveryRow as { status: string }).status).toBe("partially_received");

    const { data: itemsRow } = await supabase.from("delivery_items")
      .select("dispatched_quantity, received_quantity, unresolved_quantity").eq("id", deliveryItemId).single();
    const items = itemsRow as { dispatched_quantity: number; received_quantity: number; unresolved_quantity: number };
    expect(Number(items.dispatched_quantity)).toBe(300);
    expect(Number(items.received_quantity)).toBe(150);
    expect(Number(items.unresolved_quantity)).toBe(150);

    const { data: recipientRow } = await supabase.from("delivery_recipients").select("recipient_name").eq("delivery_id", deliveryId).single();
    expect((recipientRow as { recipient_name: string }).recipient_name).toBe("Pak Waluyo");

    const { data: auditRow } = await supabase.from("audit_logs")
      .select("new_data, actor_type, event_category, module, source, outcome")
      .eq("entity_id", deliveryId).eq("action", "delivery.receipt_confirmed").single();
    const audit = auditRow as {
      new_data: { status: string; quantities: { dispatched_quantity: number; received_quantity: number; shortage: number }[]; receiver_name: string };
      actor_type: string; event_category: string; module: string; source: string; outcome: string;
    };
    expect(audit.new_data.status).toBe("partially_received");
    expect(audit.new_data.receiver_name).toBe("Pak Waluyo");
    expect(Number(audit.new_data.quantities[0]!.dispatched_quantity)).toBe(300);
    expect(Number(audit.new_data.quantities[0]!.received_quantity)).toBe(150);
    expect(Number(audit.new_data.quantities[0]!.shortage)).toBe(150);
    expect(audit.actor_type).toBe("driver");
    expect(audit.event_category).toBe("audit");
    expect(audit.module).toBe("delivery");
    expect(audit.outcome).toBe("success");
  });

  it("finalize_delivery_atomic: idempotent -- retry pada delivery yang sudah terminal, no-op, tidak ada audit ganda", async () => {
    const { count: before } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", deliveryId).eq("action", "delivery.receipt_confirmed");
    const { data } = await supabase.rpc("finalize_delivery_atomic", {
      p_company_id: companyId, p_actor_id: driverAuthId, p_delivery_id: deliveryId,
      p_final_status: "fully_received", p_item_outcomes: [],
      p_reason_code: null, p_reason_note: null, p_severity: null,
      p_recipient_name: null, p_is_expected_pic: null,
    });
    expect((data ?? [])[0]?.result_outcome).toBe("already_finalized");
    const { count: after } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", deliveryId).eq("action", "delivery.receipt_confirmed");
    expect(after ?? 0).toBe(before ?? 0);

    // Status TIDAK berubah jadi fully_received -- idempotent no-op sungguhan.
    const { data: deliveryRow } = await supabase.from("deliveries").select("status").eq("id", deliveryId).single();
    expect((deliveryRow as { status: string }).status).toBe("partially_received");
  });

  it("finalize_delivery_atomic: quantity melebihi outstanding ditolak, TIDAK ada mutasi/audit apa pun (rollback penuh)", async () => {
    // Delivery baru (attempt ke-2) untuk order yang sama, outstanding tersisa 150.
    const { data: attempt2 } = await supabase.rpc("create_delivery_atomic", {
      p_company_id: companyId, p_actor_id: ownerAuthId, p_sales_order_id: orderId,
      p_idempotency_key: `itest:${runTag}:attempt2`, p_driver_id: driverAuthId,
      p_items: [{ sales_order_item_id: orderItemId, ordered_quantity: 150 }],
    });
    const delivery2Id = (attempt2 ?? [])[0]?.result_delivery_id;
    await supabase.rpc("dispatch_delivery_atomic", { p_company_id: companyId, p_actor_id: driverAuthId, p_delivery_id: delivery2Id });

    const { data: item2Row } = await supabase.from("delivery_items").select("id").eq("delivery_id", delivery2Id).single();
    const deliveryItem2Id = (item2Row as { id: string }).id;

    const { count: before } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", delivery2Id);
    const { data, error } = await supabase.rpc("finalize_delivery_atomic", {
      p_company_id: companyId, p_actor_id: driverAuthId, p_delivery_id: delivery2Id,
      p_final_status: "fully_received",
      // outstanding sesungguhnya cuma 150 (300 ordered - 150 sudah diterima attempt 1) --
      // 151 harus ditolak (QUANTITY_EXCEEDS_OUTSTANDING), bukan silent clamp.
      p_item_outcomes: [{ delivery_item_id: deliveryItem2Id, received_quantity: 151, rejected_quantity: 0, returned_quantity: 0, unresolved_quantity: 0 }],
      p_reason_code: null, p_reason_note: null, p_severity: null,
      p_recipient_name: null, p_is_expected_pic: null,
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("QUANTITY_EXCEEDS_OUTSTANDING");

    // Status delivery2 TIDAK berubah, tidak ada audit ditulis untuk kegagalan ini.
    const { data: delivery2Row } = await supabase.from("deliveries").select("status").eq("id", delivery2Id).single();
    expect((delivery2Row as { status: string }).status).toBe("dispatched");
    const { count: after } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", delivery2Id);
    expect(after ?? 0).toBe(before ?? 0);
  });
});
