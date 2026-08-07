// =============================================================================
// Gate 3E-D3-B -- Telegram Draft `missing_fields` JSONB Fix, DB-backed
// (Postgres nyata via migration
// 20260920000001_gate_3e_d3_b_telegram_draft_missing_fields_jsonb_fix.sql).
//
// Root cause: p_missing_fields (TEXT[]) ditulis langsung ke
// sales_orders.missing_fields (jsonb) tanpa cast -> SQLSTATE 42804 untuk
// SEMUA pemanggil create_draft_sales_order_atomic / update_draft_sales_order_atomic
// yang lolos ownership check. Fix: to_jsonb(COALESCE(p_missing_fields, ARRAY[]::text[])).
//
// Membuktikan:
//   1. create/update draft dengan missing fields berhasil, tersimpan sebagai
//      JSONB array of string (bukan PG array literal, objek, atau string JSON).
//   2. empty array (dan NULL) tersimpan sebagai JSONB '[]'.
//   3. Kontrak Gate 3E-D3-A (auto-attribution, ownership, fail-closed) tetap
//      utuh: legitimate owner boleh lanjut, Sales lain/cross-tenant/actor
//      tanpa identitas valid ditolak, spoofed attribution diabaikan/ditolak.
//   4. Tidak ada regresi pada draft lengkap tanpa missing fields.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola identik
// dengan sales-auto-attribution.integration.test.ts.
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
  console.warn("Gate 3E-D3-B integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3E-D3-B: Telegram draft missing_fields JSONB fix (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3ed3b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const companyBId = randomUUID();

  const authIds: Record<string, string> = {};
  let customerMineId = "";

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    await service.from("companies").insert([
      { id: companyId, name: `Gate 3E-D3-B A ${runTag}`, slug: `gate-3e-d3-b-a-${runTag}` },
      { id: companyBId, name: `Gate 3E-D3-B B ${runTag}`, slug: `gate-3e-d3-b-b-${runTag}` },
    ]);

    const ACCOUNTS: Array<{ key: string; companyId: string; role: string }> = [
      { key: "sales1", companyId, role: "sales" },
      { key: "sales2", companyId, role: "sales" },
      { key: "salesB", companyId: companyBId, role: "sales" },
    ];
    for (const acc of ACCOUNTS) {
      const email = `${runTag}-${acc.key}@itest.test`;
      const { data: auth, error: authErr } = await service.auth.admin.createUser({ email, password: randomUUID(), email_confirm: true });
      if (authErr || !auth.user) throw new Error(`gagal buat auth user ${acc.key}: ${authErr?.message}`);
      authIds[acc.key] = auth.user.id;
      await service.from("users").insert({ id: auth.user.id, company_id: acc.companyId, email, full_name: `Itest ${acc.key}`, is_active: true });
      const { data: roleRow } = await service.from("roles").select("id").eq("name", acc.role).is("company_id", null).single();
      await service.from("user_roles").insert({ user_id: auth.user.id, company_id: acc.companyId, role_id: (roleRow as { id: string }).id });
    }

    const { data: cMine } = await service.from("customers")
      .insert({ company_id: companyId, code: `CM-${runTag}`, name: "Toko Milik Sales1", assigned_sales_id: authIds.sales1 })
      .select("id").single();
    customerMineId = (cMine as { id: string }).id;
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    for (const cid of [companyId, companyBId]) {
      await service.from("sales_order_items").delete().in("order_id",
        (await service.from("sales_orders").select("id").eq("company_id", cid)).data?.map((r: { id: string }) => r.id) ?? []);
      await service.from("sales_orders").delete().eq("company_id", cid);
      await service.from("customers").delete().eq("company_id", cid);
    }
    await service.from("user_roles").delete().in("company_id", [companyId, companyBId]);
    const allIds = Object.values(authIds).filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    for (const cid of [companyId, companyBId]) await service.from("companies").delete().eq("id", cid);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  it("1. create draft dengan beberapa missing fields -> berhasil, tersimpan sebagai JSONB array of string", async () => {
    const { data, error } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `GD3B-1-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.6,
      p_missing_fields: ["customer.name", "items[0].quantity", "deliveryNote"],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect(error).toBeNull();
    const outcome = (data ?? [])[0]?.result_outcome;
    expect(outcome).toBe("created");
    const orderId = (data ?? [])[0]?.result_order_id;

    const { data: row } = await service.from("sales_orders").select("missing_fields").eq("id", orderId).single();
    const stored = (row as { missing_fields: unknown }).missing_fields;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toEqual(["customer.name", "items[0].quantity", "deliveryNote"]);
    (stored as unknown[]).forEach((v) => expect(typeof v).toBe("string"));
  });

  it("2. empty array missing_fields pada create -> tersimpan sebagai JSONB [], bukan null/objek/string", async () => {
    const { data, error } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `GD3B-2-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 1.0,
      p_missing_fields: [],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect(error).toBeNull();
    expect((data ?? [])[0]?.result_outcome).toBe("created");
    const orderId = (data ?? [])[0]?.result_order_id;

    const { data: row } = await service.from("sales_orders").select("missing_fields").eq("id", orderId).single();
    const stored = (row as { missing_fields: unknown }).missing_fields;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toEqual([]);
  });

  it("3. update draft dengan beberapa missing fields -> berhasil, tersimpan sebagai JSONB array of string", async () => {
    const { data: created } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `GD3B-3-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 1.0, p_missing_fields: [],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    const orderId = (created ?? [])[0]?.result_order_id;

    const { data, error } = await service.rpc("update_draft_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: orderId,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.5,
      p_missing_fields: ["customer.ambiguous", "items[1].unit"],
      p_requires_discount_review: false, p_delivery_note: null,
      p_total_amount: 20000, p_discount_amount: 0, p_final_amount: 20000, p_items: [],
    });
    expect(error).toBeNull();
    expect((data ?? [])[0]?.result_outcome).toBe("updated");

    const { data: row } = await service.from("sales_orders").select("missing_fields").eq("id", orderId).single();
    const stored = (row as { missing_fields: unknown }).missing_fields;
    expect(stored).toEqual(["customer.ambiguous", "items[1].unit"]);
  });

  it("4. legitimate Sales pemilik draft dapat melanjutkan (create + update, Gate 3E-D3-A intact)", async () => {
    const { data: created, error: createErr } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `GD3B-4-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.6, p_missing_fields: ["customer.name"],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect(createErr).toBeNull();
    expect((created ?? [])[0]?.result_outcome).toBe("created");
    const orderId = (created ?? [])[0]?.result_order_id;

    const { data: updated, error: updateErr } = await service.rpc("update_draft_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales1, p_order_id: orderId,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 1.0, p_missing_fields: [],
      p_requires_discount_review: false, p_delivery_note: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect(updateErr).toBeNull();
    expect((updated ?? [])[0]?.result_outcome).toBe("updated");
  });

  it("5. Sales lain (tidak memiliki toko) -> customer_not_owned, fail-closed", async () => {
    const { data } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales2, p_order_number: `GD3B-5-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.6, p_missing_fields: ["customer.name"],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("customer_not_owned");
  });

  it("6. cross-tenant actor (Sales dari company lain) -> forbidden, fail-closed", async () => {
    const { data } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.salesB, p_order_number: `GD3B-6-${runTag}`,
      p_customer_id: null, p_customer_name_raw: "cross tenant test", p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.6, p_missing_fields: ["customer.name"],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("7. actor tanpa identitas Sales valid -> forbidden, fail-closed", async () => {
    const { data } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: "00000000-0000-0000-0000-000000000000", p_order_number: `GD3B-7-${runTag}`,
      p_customer_id: null, p_customer_name_raw: "no identity test", p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.6, p_missing_fields: ["customer.name"],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");
  });

  it("8. spoofed attribution pada update (actor lain mengedit draft milik sales1) -> ditolak, tidak ada mutasi", async () => {
    const { data: created } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `GD3B-8-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 1.0, p_missing_fields: [],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    const orderId = (created ?? [])[0]?.result_order_id;

    const { data } = await service.rpc("update_draft_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales2, p_order_id: orderId,
      p_customer_id: null, p_customer_name_raw: "spoofed edit attempt", p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 0.5, p_missing_fields: ["hacked"],
      p_requires_discount_review: false, p_delivery_note: null,
      p_total_amount: 999, p_discount_amount: 0, p_final_amount: 999, p_items: [],
    });
    expect((data ?? [])[0]?.result_outcome).toBe("forbidden");

    const { data: row } = await service.from("sales_orders").select("missing_fields, final_amount").eq("id", orderId).single();
    expect((row as { missing_fields: unknown[] }).missing_fields).toEqual([]);
    // Gate 3E-D4-C7: p_items=[] -> final_amount direkomputasi server-side dari
    // sales_order_items (0, bukan lagi p_final_amount=10000 dari client) --
    // assersi ini tetap membuktikan hal yang sama (update spoof tidak mengubah
    // apa pun), hanya nilai baseline-nya sekarang 0 (item kosong), bukan 10000.
    expect(Number((row as { final_amount: number }).final_amount)).toBe(0);
  });

  it("9. draft lengkap TANPA missing fields (NULL dan array kosong) -> tidak ada regresi", async () => {
    const { data: withNull, error: errNull } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales1, p_order_number: `GD3B-9-NULL-${runTag}`,
      p_customer_id: customerMineId, p_customer_name_raw: null, p_order_source: "OTHER",
      p_knowledge_version: "v1", p_extraction_confidence: 1.0, p_missing_fields: null,
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: null,
      p_total_amount: 10000, p_discount_amount: 0, p_final_amount: 10000, p_items: [],
    });
    expect(errNull).toBeNull();
    expect((withNull ?? [])[0]?.result_outcome).toBe("created");
    const { data: rowNull } = await service.from("sales_orders").select("missing_fields").eq("id", (withNull ?? [])[0]?.result_order_id).single();
    expect((rowNull as { missing_fields: unknown }).missing_fields).toEqual([]);
  });
});
