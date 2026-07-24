// =============================================================================
// DB-backed integration test -- Gate 2D: Payment Receipt, Proof, and Allocation
// (supabase/migrations/20260829000001_payment_receipt_proof_allocation.sql).
//
// Membuktikan: record_verified_payment_atomic() -- cash sebagian/transfer
// lunas/beberapa pembayaran/beberapa invoice, proof wajib, total allocation ==
// receipt amount, allocation tidak melebihi outstanding, tenant/customer/actor
// validation, duplicate transfer reference, idempotency (retry identik +
// payload berbeda ditolak), klaim collection tidak menyentuh ledger, rollback
// penuh saat allocation gagal, immutability, dan direct mutation ditolak. Skip
// graceful jika kredensial Supabase lokal tidak tersedia atau URL bukan
// loopback -- pola sama dengan collection-promise-foundation.integration.test.ts
// (Gate 2C).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260829000001_payment_receipt_proof_allocation.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB).
// record_verified_payment_atomic() TIDAK punya blok EXCEPTION apa pun --
// kegagalan APA PUN di dalamnya selalu mem-propagate ke atas dan membatalkan
// SELURUH transaksi RPC (pola sama dengan issue_invoice_atomic/Gate 2C RPC).
// ---------------------------------------------------------------------------
describe("Gate 2D hardening -- static proof atomicity (migration 20260829000001)", () => {
  const migration = readFileSync(MIGRATION_PATH, "utf8");

  function extractFunctionBody(fnName: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
    expect(start, `function public.${fnName} tidak ditemukan di migration`).toBeGreaterThanOrEqual(0);
    const end = migration.lastIndexOf("$$ LANGUAGE plpgsql");
    expect(end, `penutup $$ LANGUAGE plpgsql untuk ${fnName} tidak ditemukan`).toBeGreaterThan(start);
    return migration.slice(start, end);
  }

  it("tidak ada identifier test-only (_test_) atau trigger failure-injection di migration produksi", () => {
    expect(migration).not.toMatch(/_test_/i);
    expect(migration).not.toMatch(/TEST_FORCED_ROLLBACK/);
    expect(migration).not.toMatch(/CREATE TRIGGER trg_test_/i);
  });

  it("record_verified_payment_atomic() adalah SATU function body tanpa blok EXCEPTION", () => {
    const body = extractFunctionBody("record_verified_payment_atomic");
    expect(body).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("record_verified_payment_atomic() terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role)", () => {
    const sig = "public.record_verified_payment_atomic(UUID, UUID, TEXT, NUMERIC, JSONB, JSONB, TEXT, TEXT)";
    expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig}\n  FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig}\n  TO service_role;`);
  });

  it("izin payment.record HANYA digrant ke owner/finance (bukan manager/admin/super_admin)", () => {
    expect(migration).toContain("AND r.name IN ('owner', 'finance')\n  AND p.name = 'payment.record'");
  });

  it("permintaan sebelum idempotency-return early tidak menulis apa pun (RETURN sebelum lanjut ke actor/permission check)", () => {
    const body = extractFunctionBody("record_verified_payment_atomic");
    const idemIdx = body.indexOf("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
    const forbiddenIdx = body.indexOf("FORBIDDEN: actor");
    expect(idemIdx).toBeGreaterThan(0);
    expect(forbiddenIdx).toBeGreaterThan(idemIdx);
  });

  it("hardening: constraint trigger pairing ledger<->payment_allocations adalah DEFERRABLE INITIALLY DEFERRED (bukan IMMEDIATE)", () => {
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER trg_receivable_ledger_payment_allocation_pairing\s+AFTER INSERT ON public\.receivable_ledger\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW EXECUTE FUNCTION public\.enforce_payment_allocation_ledger_pairing\(\);/,
    );
  });

  it("hardening: pairing check menggunakan ERRCODE check_violation (23514), bukan generic integrity_constraint_violation", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.enforce_payment_allocation_ledger_pairing(");
    expect(start).toBeGreaterThan(0);
    const end = migration.indexOf("$$ LANGUAGE plpgsql", start);
    const body = migration.slice(start, end);
    expect(body).toContain("ORPHAN_PAYMENT_ALLOCATION_LEDGER_CREDIT");
    expect(body).toContain("USING ERRCODE = 'check_violation'");
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

describeIfDb("Gate 2D: Payment Receipt, Proof, and Allocation (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const createdCompanyIds = [companyId, otherCompanyId];

  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];

  let ownerUser: { userId: string; email: string; password: string };
  let financeUser: { userId: string; email: string; password: string };
  let salesUser: { userId: string; email: string; password: string };
  let inactiveFinanceUser: { userId: string; email: string; password: string };
  let otherFinanceUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2D ${tag}`,
      slug: `itest-g2d-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550003",
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
  // balance = total_amount karena belum ada payment/allocation apa pun.
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

  function oneProof(ref: string) {
    return [{ proof_type: "bank_transfer_receipt", object_reference: `storage://proofs/${ref}.jpg`, metadata: { size: 1024 } }];
  }

  async function balanceOf(invoiceId: string) {
    const { data } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", invoiceId).single();
    return data as { outstanding_balance: string; financial_status: string; total_debit: string; total_credit: string };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "PGA");
    await insertCompany(otherCompanyId, `${runTag}-B`, "PGB");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    salesUser = await createActor(companyId, `${runTag}-sales`, "sales");
    inactiveFinanceUser = await createActor(companyId, `${runTag}-inactive`, "finance", false);
    otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("payment_allocations").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_proofs").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_receipts").delete().in("company_id", createdCompanyIds);
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
  // 1. Tunai sebagian -> partially_paid
  // ---------------------------------------------------------------------

  it("1. Pembayaran tunai sebagian menghasilkan partially_paid", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CASHPART`, financeUser.userId);
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_method: "cash",
      p_amount: inv.totalAmount / 2,
      p_proofs: oneProof(`${runTag}-cashpart`),
      p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount / 2 }],
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_payment_receipt_id: string; out_allocations: Array<{ financialStatus: string }> }>)[0];
    expect(row.out_allocations[0].financialStatus).toBe("partially_paid");

    const balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("partially_paid");
    expect(Number(balance.outstanding_balance)).toBe(inv.totalAmount / 2);
  });

  // ---------------------------------------------------------------------
  // 2. Transfer lunas -> paid
  // ---------------------------------------------------------------------

  it("2. Pembayaran transfer lunas menghasilkan paid", async () => {
    const inv = await createInvoice(companyId, `${runTag}-XFERFULL`, financeUser.userId);
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_method: "bank_transfer",
      p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-xferfull`),
      p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
      p_transfer_reference: `TRF-${runTag}-FULL`,
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_allocations: Array<{ financialStatus: string }> }>)[0];
    expect(row.out_allocations[0].financialStatus).toBe("paid");

    const balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("paid");
    expect(Number(balance.outstanding_balance)).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 3. Beberapa pembayaran cash/transfer pada satu invoice
  // ---------------------------------------------------------------------

  it("3. Beberapa pembayaran cash dan transfer pada satu invoice terakumulasi hingga lunas", async () => {
    const inv = await createInvoice(companyId, `${runTag}-MULTI`, financeUser.userId, 30, 1000); // total 30000
    const first = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 10000,
      p_proofs: oneProof(`${runTag}-multi1`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 10000 }],
    });
    expect(first.error).toBeNull();
    let balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("partially_paid");
    expect(Number(balance.outstanding_balance)).toBe(20000);

    const second = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: 15000,
      p_proofs: oneProof(`${runTag}-multi2`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 15000 }],
      p_transfer_reference: `TRF-${runTag}-MULTI2`,
    });
    expect(second.error).toBeNull();
    balance = await balanceOf(inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(5000);

    const third = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 5000,
      p_proofs: oneProof(`${runTag}-multi3`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 5000 }],
    });
    expect(third.error).toBeNull();
    balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("paid");
    expect(Number(balance.outstanding_balance)).toBe(0);

    const { count: ledgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "payment_allocation");
    expect(ledgerCount).toBe(3);
  });

  // ---------------------------------------------------------------------
  // 4. Satu payment dialokasikan ke beberapa invoice customer yang sama
  // ---------------------------------------------------------------------

  it("4. Satu payment dialokasikan ke beberapa invoice milik customer yang sama", async () => {
    const invA = await createInvoice(companyId, `${runTag}-MULTIINV-A`, financeUser.userId, 10, 1000);
    // Invoice kedua untuk customer yang SAMA -- gunakan order/delivery baru tapi customer_id sama.
    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}-MULTIINV-B`, customer_id: invA.customerId, status: "delivered" })
      .select("id")
      .single();
    expect(orderErr).toBeNull();
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: companyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    expect(delErr).toBeNull();
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: "Produk B", unit: "pcs", quantity: 5, unit_price: 1000, discount_amount: 0, total_amount: 5000 })
      .select("id")
      .single();
    expect(itemErr).toBeNull();
    const orderItemId = (item as { id: string }).id;

    await supabase.from("delivery_items").insert({
      delivery_id: deliveryId, sales_order_item_id: orderItemId, ordered_quantity: 5, dispatched_quantity: 5, received_quantity: 5,
    });

    const { data: issueData, error: issueErr } = await supabase.rpc("issue_invoice_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_order_id: orderId,
    });
    expect(issueErr).toBeNull();
    const invB = (issueData as Array<{ out_invoice_id: string }>)[0];

    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: 12000,
      p_proofs: oneProof(`${runTag}-multiinv`),
      p_allocations: [
        { invoice_id: invA.invoiceId, amount: 10000 },
        { invoice_id: invB.out_invoice_id, amount: 2000 },
      ],
      p_transfer_reference: `TRF-${runTag}-MULTIINV`,
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_allocations: unknown[] }>)[0];
    expect(row.out_allocations.length).toBe(2);

    const balanceA = await balanceOf(invA.invoiceId);
    expect(balanceA.financial_status).toBe("paid");
    const balanceB = await balanceOf(invB.out_invoice_id);
    expect(Number(balanceB.outstanding_balance)).toBe(3000);
  });

  // ---------------------------------------------------------------------
  // 5. Proof wajib
  // ---------------------------------------------------------------------

  it("5. Payment tanpa proof ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOPROOF`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: [], p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("PROOF_REQUIRED");

    const { count } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("customer_id", inv.customerId);
    expect(count).toBe(0);
  });

  it("5b. Proof dengan field tidak lengkap ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-BADPROOF`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: [{ proof_type: "", object_reference: "x" }], p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVALID_PROOF");
  });

  // ---------------------------------------------------------------------
  // 6. Total allocation tidak sama dengan receipt ditolak
  // ---------------------------------------------------------------------

  it("6. Total allocation tidak sama dengan payment amount ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-MISMATCH`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-mismatch`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount - 1 }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ALLOCATION_TOTAL_MISMATCH");

    const { count } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("customer_id", inv.customerId);
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 7. Allocation melebihi outstanding ditolak
  // ---------------------------------------------------------------------

  it("7. Allocation melebihi outstanding invoice ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-EXCEED`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount + 1000,
      p_proofs: oneProof(`${runTag}-exceed`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount + 1000 }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ALLOCATION_EXCEEDS_OUTSTANDING");
  });

  // ---------------------------------------------------------------------
  // 8. Cross-tenant dan cross-customer ditolak
  // ---------------------------------------------------------------------

  it("8a. Invoice tenant lain ditolak", async () => {
    const invB = await createInvoice(otherCompanyId, `${runTag}-XT`, otherFinanceUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: invB.totalAmount,
      p_proofs: oneProof(`${runTag}-xt`), p_allocations: [{ invoice_id: invB.invoiceId, amount: invB.totalAmount }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("TENANT_CONTEXT_MISMATCH");
  });

  it("8b. Invoice customer berbeda dalam satu payment ditolak", async () => {
    const invA = await createInvoice(companyId, `${runTag}-XC-A`, financeUser.userId);
    const invB = await createInvoice(companyId, `${runTag}-XC-B`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: invA.totalAmount + invB.totalAmount,
      p_proofs: oneProof(`${runTag}-xc`),
      p_allocations: [
        { invoice_id: invA.invoiceId, amount: invA.totalAmount },
        { invoice_id: invB.invoiceId, amount: invB.totalAmount },
      ],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVOICE_CUSTOMER_MISMATCH");
  });

  // ---------------------------------------------------------------------
  // 9. Actor tidak aktif/tidak berwenang ditolak
  // ---------------------------------------------------------------------

  it("9a. Actor role sales (tanpa permission payment.record) ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-SALESFORBID`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: salesUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-salesforbid`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("9b. Actor nonaktif ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INACTIVE`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: inactiveFinanceUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-inactive`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  it("9c. Actor role owner diizinkan (permission payment.record mencakup owner)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-OWNEROK`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: ownerUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-ownerok`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).toBeNull();
  });

  it("9d. Actor tenant lain ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-XACTOR`, financeUser.userId);
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: otherFinanceUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-xactor`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");
  });

  // ---------------------------------------------------------------------
  // 10. Duplicate transfer reference ditolak
  // ---------------------------------------------------------------------

  it("10. Duplicate transfer_reference dalam tenant yang sama ditolak", async () => {
    const invA = await createInvoice(companyId, `${runTag}-DUPTRF-A`, financeUser.userId);
    const invB = await createInvoice(companyId, `${runTag}-DUPTRF-B`, financeUser.userId);
    const ref = `TRF-${runTag}-DUP`;

    const first = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: invA.totalAmount,
      p_proofs: oneProof(`${runTag}-duptrf1`), p_allocations: [{ invoice_id: invA.invoiceId, amount: invA.totalAmount }],
      p_transfer_reference: ref,
    });
    expect(first.error).toBeNull();

    const second = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: invB.totalAmount,
      p_proofs: oneProof(`${runTag}-duptrf2`), p_allocations: [{ invoice_id: invB.invoiceId, amount: invB.totalAmount }],
      p_transfer_reference: ref,
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain("DUPLICATE_TRANSFER_REFERENCE");

    const balanceB = await balanceOf(invB.invoiceId);
    expect(Number(balanceB.outstanding_balance)).toBe(invB.totalAmount);
  });

  // ---------------------------------------------------------------------
  // 11. Retry identik idempotent
  // ---------------------------------------------------------------------

  it("11. Retry identik (idempotency_key + payload sama) tidak menggandakan receipt/allocation/ledger/audit", async () => {
    const inv = await createInvoice(companyId, `${runTag}-IDEMSAME`, financeUser.userId);
    const key = `idem-${runTag}-same`;
    const payload = {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-idemsame`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
      p_idempotency_key: key,
    };

    const first = await supabase.rpc("record_verified_payment_atomic", payload);
    expect(first.error).toBeNull();
    const firstRow = (first.data as Array<{ out_payment_receipt_id: string; out_already_exists: boolean }>)[0];
    expect(firstRow.out_already_exists).toBe(false);

    const second = await supabase.rpc("record_verified_payment_atomic", payload);
    expect(second.error).toBeNull();
    const secondRow = (second.data as Array<{ out_payment_receipt_id: string; out_already_exists: boolean }>)[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_payment_receipt_id).toBe(firstRow.out_payment_receipt_id);

    const { count: receiptCount } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("idempotency_key", key);
    expect(receiptCount).toBe(1);
    const { count: allocationCount } = await supabase.from("payment_allocations").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(allocationCount).toBe(1);
    const { count: ledgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "payment_allocation");
    expect(ledgerCount).toBe(1);
    const { count: auditCount } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("entity_id", firstRow.out_payment_receipt_id).eq("action", "payment.recorded");
    expect(auditCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 12. Idempotency key dengan payload berbeda ditolak
  // ---------------------------------------------------------------------

  it("12. idempotency_key sama dengan payload berbeda (amount berbeda) ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-IDEMDIFF`, financeUser.userId, 20, 1000); // total 20000
    const key = `idem-${runTag}-diff`;

    const first = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 10000,
      p_proofs: oneProof(`${runTag}-idemdiff1`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 10000 }],
      p_idempotency_key: key,
    });
    expect(first.error).toBeNull();

    const second = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 5000,
      p_proofs: oneProof(`${runTag}-idemdiff1`), p_allocations: [{ invoice_id: inv.invoiceId, amount: 5000 }],
      p_idempotency_key: key,
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toContain("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");

    const { count } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("idempotency_key", key);
    expect(count).toBe(1);
    const balance = await balanceOf(inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(10000);
  });

  // ---------------------------------------------------------------------
  // 13. Collection claim tanpa payment terverifikasi tidak mengubah ledger
  // ---------------------------------------------------------------------

  it("13. Collection claim (claimed_paid_full) tidak mengubah ledger/outstanding/status", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CLAIM`, financeUser.userId);
    const before = await balanceOf(inv.invoiceId);
    const { count: ledgerBefore } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);

    const { error } = await supabase.rpc("record_collection_activity", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_invoice_id: inv.invoiceId,
      p_channel: "whatsapp", p_activity_type: "outcome", p_outcome: "claimed_paid_full", p_reported_amount: inv.totalAmount,
    });
    expect(error).toBeNull();

    const after = await balanceOf(inv.invoiceId);
    expect(after).toEqual(before);
    const { count: ledgerAfter } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  // ---------------------------------------------------------------------
  // 14. Kegagalan allocation membatalkan seluruh transaksi
  // ---------------------------------------------------------------------

  it("14. Kegagalan salah satu allocation (melebihi outstanding) me-rollback SELURUH payment, termasuk invoice lain yang valid", async () => {
    const invOk = await createInvoice(companyId, `${runTag}-RB-OK`, financeUser.userId, 10, 1000); // total 10000
    const invFail = await createInvoice(companyId, `${runTag}-RB-FAIL`, financeUser.userId, 10, 1000); // total 10000, sama customer? beda -- pastikan customer sama dgn invOk agar lolos customer check
    // Perbaiki: invFail harus milik customer yang SAMA dengan invOk supaya gagal
    // karena ALLOCATION_EXCEEDS_OUTSTANDING (bukan INVOICE_CUSTOMER_MISMATCH).
    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}-RB-FAIL2`, customer_id: invOk.customerId, status: "delivered" })
      .select("id")
      .single();
    expect(orderErr).toBeNull();
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);
    const { data: delivery, error: delErr } = await supabase
      .from("deliveries")
      .insert({ company_id: companyId, sales_order_id: orderId, attempt_number: 1, status: "planned" })
      .select("id")
      .single();
    expect(delErr).toBeNull();
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);
    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: "Produk RB", unit: "pcs", quantity: 10, unit_price: 1000, discount_amount: 0, total_amount: 10000 })
      .select("id")
      .single();
    expect(itemErr).toBeNull();
    const orderItemId = (item as { id: string }).id;
    await supabase.from("delivery_items").insert({
      delivery_id: deliveryId, sales_order_item_id: orderItemId, ordered_quantity: 10, dispatched_quantity: 10, received_quantity: 10,
    });
    const { data: issueData, error: issueErr } = await supabase.rpc("issue_invoice_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_order_id: orderId,
    });
    expect(issueErr).toBeNull();
    const invFailReal = (issueData as Array<{ out_invoice_id: string }>)[0].out_invoice_id;
    void invFail; // fixture pertama tidak dipakai, digantikan invFailReal (customer sama dengan invOk)

    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: 10000 + 20000,
      p_proofs: oneProof(`${runTag}-rollback`),
      p_allocations: [
        { invoice_id: invOk.invoiceId, amount: 10000 },
        { invoice_id: invFailReal, amount: 20000 }, // melebihi outstanding (10000)
      ],
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ALLOCATION_EXCEEDS_OUTSTANDING");

    const balanceOk = await balanceOf(invOk.invoiceId);
    expect(Number(balanceOk.outstanding_balance)).toBe(10000); // TIDAK terpengaruh -- rollback penuh
    const { count } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("customer_id", invOk.customerId);
    expect(count).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 15. Direct mutation oleh authenticated ditolak
  // ---------------------------------------------------------------------

  it("15. Direct client mutation (anon) ditolak untuk ketiga tabel", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const inv = await createInvoice(companyId, `${runTag}-ANON`, financeUser.userId);

    const receiptInsert = await anon.from("payment_receipts").insert({
      company_id: companyId, customer_id: inv.customerId, method: "cash", amount: 1000, recorded_by: financeUser.userId, request_payload: {},
    });
    expect(receiptInsert.error).not.toBeNull();

    const proofInsert = await anon.from("payment_proofs").insert({
      company_id: companyId, payment_receipt_id: randomUUID(), proof_type: "x", object_reference: "y", uploaded_by: financeUser.userId,
    });
    expect(proofInsert.error).not.toBeNull();

    const allocationInsert = await anon.from("payment_allocations").insert({
      company_id: companyId, payment_receipt_id: randomUUID(), invoice_id: inv.invoiceId, amount: 1000, receivable_ledger_id: randomUUID(),
    });
    expect(allocationInsert.error).not.toBeNull();
  });

  it("15b. Security posture: anon TIDAK dapat memanggil RPC Gate 2D sama sekali", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const inv = await createInvoice(companyId, `${runTag}-ANONRPC`, financeUser.userId);
    const { error } = await anon.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-anonrpc`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 16. Immutability
  // ---------------------------------------------------------------------

  it("16. payment_receipts/payment_proofs/payment_allocations immutable -- UPDATE dan DELETE ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-IMMUT`, financeUser.userId);
    const { data } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-immut`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    const receiptId = (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    const updateReceipt = await supabase.from("payment_receipts").update({ amount: 1 }).eq("id", receiptId);
    expect(updateReceipt.error).not.toBeNull();
    expect(updateReceipt.error!.message).toContain("PAYMENT_RECEIPT_IMMUTABLE");

    const deleteReceipt = await supabase.from("payment_receipts").delete().eq("id", receiptId);
    expect(deleteReceipt.error).not.toBeNull();

    const { data: proof } = await supabase.from("payment_proofs").select("id").eq("payment_receipt_id", receiptId).limit(1).single();
    const updateProof = await supabase.from("payment_proofs").update({ object_reference: "x" }).eq("id", (proof as { id: string }).id);
    expect(updateProof.error).not.toBeNull();
    expect(updateProof.error!.message).toContain("PAYMENT_PROOF_IMMUTABLE");

    const { data: allocation } = await supabase.from("payment_allocations").select("id").eq("payment_receipt_id", receiptId).limit(1).single();
    const updateAllocation = await supabase.from("payment_allocations").update({ amount: 1 }).eq("id", (allocation as { id: string }).id);
    expect(updateAllocation.error).not.toBeNull();
    expect(updateAllocation.error!.message).toContain("PAYMENT_ALLOCATION_IMMUTABLE");
  });

  // ---------------------------------------------------------------------
  // 17. Canonical audit
  // ---------------------------------------------------------------------

  it("17. Canonical audit memiliki event payment.recorded dengan payload benar", async () => {
    const inv = await createInvoice(companyId, `${runTag}-AUDIT`, financeUser.userId);
    const { data } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-audit`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
      p_transfer_reference: `TRF-${runTag}-AUDIT`,
    });
    const receiptId = (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    const { data: audit } = await supabase.from("audit_logs").select("*").eq("entity_id", receiptId).eq("action", "payment.recorded").single();
    const a = audit as { company_id: string; module: string; event_category: string; outcome: string; new_data: Record<string, unknown> };
    expect(a.company_id).toBe(companyId);
    expect(a.module).toBe("finance");
    expect(a.event_category).toBe("audit");
    expect(a.outcome).toBe("success");
    expect(a.new_data.customer_id).toBe(inv.customerId);
    expect(a.new_data.method).toBe("bank_transfer");
  });

  // ---------------------------------------------------------------------
  // 18. Tenant isolation SELECT -- dua sesi nyata
  // ---------------------------------------------------------------------

  it("18. Tenant isolation SELECT: user finance company A melihat payment sendiri, TIDAK melihat company B", async () => {
    const invA = await createInvoice(companyId, `${runTag}-TENA`, financeUser.userId);
    const invB = await createInvoice(otherCompanyId, `${runTag}-TENB`, otherFinanceUser.userId);

    const paymentA = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: invA.totalAmount,
      p_proofs: oneProof(`${runTag}-tena`), p_allocations: [{ invoice_id: invA.invoiceId, amount: invA.totalAmount }],
    });
    const receiptAId = (paymentA.data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    const paymentB = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: otherCompanyId, p_actor_id: otherFinanceUser.userId, p_method: "cash", p_amount: invB.totalAmount,
      p_proofs: oneProof(`${runTag}-tenb`), p_allocations: [{ invoice_id: invB.invoiceId, amount: invB.totalAmount }],
    });
    const receiptBId = (paymentB.data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    const client = createClient(env!.url, env!.anonKey);
    const { error: signInErr } = await client.auth.signInWithPassword({ email: financeUser.email, password: financeUser.password });
    expect(signInErr).toBeNull();

    const own = await client.from("payment_receipts").select("id").eq("id", receiptAId);
    expect(own.error).toBeNull();
    expect((own.data ?? []).length).toBe(1);

    const cross = await client.from("payment_receipts").select("id").eq("id", receiptBId);
    expect(cross.error).toBeNull();
    expect((cross.data ?? []).length).toBe(0);

    await client.auth.signOut();
  });

  // ---------------------------------------------------------------------
  // 19-23. Hardening -- orphan payment_allocation ledger credit rejection.
  //
  // Root cause: section 0 melebarkan CHECK domain receivable_ledger.entry_type
  // supaya mengizinkan 'payment_allocation' (SAH, tujuan gate ini). Tapi CHECK
  // constraint hanya memvalidasi bentuk satu baris, bukan relasinya ke
  // payment_allocations -- INSERT langsung ke receivable_ledger dengan
  // entry_type='payment_allocation' TANPA payment_allocations/payment_receipts
  // apa pun (persis yang dilakukan Gate 2A test #13, sebelum hardening ini
  // lolos begitu entry_type diperluas) tetap mengurangi derived
  // outstanding_balance walau tidak punya payment canonical. Section 5b
  // (constraint trigger trg_receivable_ledger_payment_allocation_pairing,
  // DEFERRABLE INITIALLY DEFERRED) menutup celah ini -- diverifikasi di sini.
  // ---------------------------------------------------------------------

  it("19. Direct orphan payment_allocation ledger credit (tanpa payment_allocations) oleh service_role ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ORPHAN`, financeUser.userId);
    const { error } = await supabase.from("receivable_ledger").insert({
      company_id: companyId,
      invoice_id: inv.invoiceId,
      entry_type: "payment_allocation",
      direction: "credit",
      amount: 1000,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("ORPHAN_PAYMENT_ALLOCATION_LEDGER_CREDIT");
    expect(error!.code).toBe("23514"); // check_violation -- sama dengan Gate 2A test #13
  });

  it("20. Kegagalan orphan credit tidak meninggalkan ledger row (DEFERRED constraint membatalkan seluruh transaksi INSERT)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ORPHANCLEAN`, financeUser.userId);
    const { count: before } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(before).toBe(1); // hanya opening debit (invoice_issued) dari issue_invoice_atomic

    await supabase.from("receivable_ledger").insert({
      company_id: companyId, invoice_id: inv.invoiceId, entry_type: "payment_allocation", direction: "credit", amount: 1000,
    });

    const { count: after } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(after).toBe(1); // credit orphan TIDAK persist -- rollback penuh pada COMMIT

    const { count: creditCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "payment_allocation");
    expect(creditCount).toBe(0);

    const balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("outstanding");
    expect(Number(balance.outstanding_balance)).toBe(inv.totalAmount);
  });

  it("21. RPC pembayaran normal tetap sukses setelah hardening (ledger+allocation berpasangan dalam satu transaksi)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-HARDENOK`, financeUser.userId);
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-hardenok`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
    });
    expect(error).toBeNull();
    const row = (data as Array<{ out_payment_receipt_id: string; out_allocations: Array<{ ledgerId: string; allocationId: string }> }>)[0];
    expect(row.out_payment_receipt_id).toBeTruthy();
    expect(row.out_allocations.length).toBe(1);
  });

  it("22. Setelah hardening, receipt/allocation/ledger credit/derived balance tetap konsisten satu sama lain", async () => {
    const inv = await createInvoice(companyId, `${runTag}-HARDENCONSIST`, financeUser.userId);
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "bank_transfer", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-hardenconsist`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
      p_transfer_reference: `TRF-${runTag}-HARDENCONSIST`,
    });
    expect(error).toBeNull();
    const receiptId = (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;

    const { data: receipt } = await supabase.from("payment_receipts").select("*").eq("id", receiptId).single();
    expect(receipt).not.toBeNull();

    const { data: allocation } = await supabase.from("payment_allocations").select("*").eq("payment_receipt_id", receiptId).single();
    const alloc = allocation as { receivable_ledger_id: string; invoice_id: string; amount: string };
    expect(alloc.invoice_id).toBe(inv.invoiceId);
    expect(Number(alloc.amount)).toBe(inv.totalAmount);

    const { data: ledger } = await supabase.from("receivable_ledger").select("*").eq("id", alloc.receivable_ledger_id).single();
    const led = ledger as { entry_type: string; direction: string; amount: string; invoice_id: string };
    expect(led.entry_type).toBe("payment_allocation");
    expect(led.direction).toBe("credit");
    expect(Number(led.amount)).toBe(inv.totalAmount);
    expect(led.invoice_id).toBe(inv.invoiceId);

    const balance = await balanceOf(inv.invoiceId);
    expect(balance.financial_status).toBe("paid");
    expect(Number(balance.outstanding_balance)).toBe(0);
  });

  it("23. Retry idempotent tetap tidak menggandakan receipt/allocation/ledger setelah hardening pairing", async () => {
    const inv = await createInvoice(companyId, `${runTag}-HARDENIDEM`, financeUser.userId);
    const key = `idem-${runTag}-hardenidem`;
    const payload = {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_method: "cash", p_amount: inv.totalAmount,
      p_proofs: oneProof(`${runTag}-hardenidem`), p_allocations: [{ invoice_id: inv.invoiceId, amount: inv.totalAmount }],
      p_idempotency_key: key,
    };

    const first = await supabase.rpc("record_verified_payment_atomic", payload);
    expect(first.error).toBeNull();
    const firstRow = (first.data as Array<{ out_payment_receipt_id: string; out_already_exists: boolean }>)[0];
    expect(firstRow.out_already_exists).toBe(false);

    const second = await supabase.rpc("record_verified_payment_atomic", payload);
    expect(second.error).toBeNull();
    const secondRow = (second.data as Array<{ out_payment_receipt_id: string; out_already_exists: boolean }>)[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_payment_receipt_id).toBe(firstRow.out_payment_receipt_id);

    const { count: receiptCount } = await supabase.from("payment_receipts").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("idempotency_key", key);
    expect(receiptCount).toBe(1);
    const { count: allocationCount } = await supabase.from("payment_allocations").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(allocationCount).toBe(1);
    const { count: ledgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "payment_allocation");
    expect(ledgerCount).toBe(1);
  });
});
