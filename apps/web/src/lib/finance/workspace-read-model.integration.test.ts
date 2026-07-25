// =============================================================================
// DB-backed integration test -- Gate 2I.2: Finance Operations Workspace read
// model (apps/web/src/lib/finance/queries.ts: getInvoiceList/getInvoiceDetail/
// getPromiseList/getPaymentReceiptList/getReconciliationExceptionList/
// getReconciliationHistory). Membuktikan test matrix FIN-03-01, FIN-04-01,
// FIN-04-02, FIN-04-04, FIN-05-01, FIN-05-02 dan kasus list kosong (FIN-12-02
// setara level query). RPC canonical Gate 2A/2B/2C/2D/2E sendiri (invariant,
// FORBIDDEN, idempotency) TIDAK diuji ulang di sini -- sudah dibuktikan
// masing-masing di *.integration.test.ts gate terkait. Skip graceful jika
// kredensial Supabase lokal tidak tersedia -- pola sama seluruh integration
// test finance lain.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import {
  getInvoiceDetail,
  getInvoiceList,
  getPaymentReceiptList,
  getPromiseList,
  getReconciliationExceptionList,
  getReconciliationHistory,
} from "./queries";

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

describeIfDb("Gate 2I.2: Finance Operations Workspace read model (DB-backed, Postgres nyata)", () => {
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
  let otherFinanceUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2I2 ${tag}`,
      slug: `itest-g2i2-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550005",
    });
    if (error) throw new Error(`gagal buat company ${tag}: ${error.message}`);
  }

  async function createActor(targetCompanyId: string, tag: string, roleName: string) {
    const email = `${tag}@itest.test`;
    const password = randomUUID();
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`gagal buat auth user ${tag}: ${error?.message}`);
    const userId = data.user.id;
    createdUserIds.push(userId);
    await supabase.from("users").insert({ id: userId, company_id: targetCompanyId, email, full_name: `Actor ${tag}`, is_active: true });
    const { data: role, error: roleErr } = await supabase.from("roles").select("id").is("company_id", null).eq("name", roleName).single();
    if (roleErr || !role) throw new Error(`role ${roleName} tidak ditemukan: ${roleErr?.message}`);
    await supabase.from("user_roles").insert({ user_id: userId, role_id: (role as { id: string }).id, company_id: targetCompanyId });
    return { userId, email, password };
  }

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

  async function pay(actorId: string, invoiceId: string, amount: number, ref: string) {
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_method: "cash",
      p_amount: amount,
      p_proofs: oneProof(ref),
      p_allocations: [{ invoice_id: invoiceId, amount }],
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
    return (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);
    await insertCompany(companyId, `${runTag}-A`, "W2A");
    await insertCompany(otherCompanyId, `${runTag}-B`, "W2B");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("payment_reconciliations").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_allocations").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_proofs").delete().in("company_id", createdCompanyIds);
    await supabase.from("payment_receipts").delete().in("company_id", createdCompanyIds);
    await supabase.from("promises_to_pay").delete().in("company_id", createdCompanyIds);
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
    for (const id of createdUserIds) {
      await supabase.auth.admin.deleteUser(id);
    }
    await supabase.from("companies").delete().in("id", createdCompanyIds);
  }, 60000);

  it("FIN-05-01: outstanding pada getInvoiceDetail identik invoice_receivable_balances.outstanding_balance -- tidak dihitung ulang di client", async () => {
    const inv = await createInvoice(companyId, `${runTag}-OUT1`, financeUser.userId, 1000, 1000); // total 1.000.000
    await pay(financeUser.userId, inv.invoiceId, 400_000, `${runTag}-out1`);

    const detail = await getInvoiceDetail(companyId, inv.invoiceId, supabase);
    expect(detail).not.toBeNull();
    expect(detail!.outstandingBalance).toBe(600_000);
    expect(detail!.totalPaid).toBe(400_000);
    expect(detail!.financialStatus).toBe("partially_paid");

    const { data: viewRow } = await supabase.from("invoice_receivable_balances").select("outstanding_balance").eq("invoice_id", inv.invoiceId).single();
    expect(detail!.outstandingBalance).toBe(Number((viewRow as { outstanding_balance: string }).outstanding_balance));
  });

  it("FIN-05-02: sales_orders.status='paid' tanpa payment_allocation nyata TIDAK memengaruhi outstanding (query tidak menyentuh sales_orders.status)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-STATUSLIE`, financeUser.userId, 10, 1000);
    const { error: updErr } = await supabase.from("sales_orders").update({ status: "paid" }).eq("id", inv.orderId);
    expect(updErr).toBeNull();

    const detail = await getInvoiceDetail(companyId, inv.invoiceId, supabase);
    expect(detail).not.toBeNull();
    expect(detail!.outstandingBalance).toBe(inv.totalAmount);
    expect(detail!.financialStatus).toBe("outstanding");
  });

  it("FIN-04-02: invoice dengan payment menampilkan total terbayar dan outstanding sesuai data gabungan", async () => {
    const inv = await createInvoice(companyId, `${runTag}-DETAIL`, financeUser.userId, 20, 1000); // 20.000
    await pay(financeUser.userId, inv.invoiceId, 12_000, `${runTag}-detail`);

    const detail = await getInvoiceDetail(companyId, inv.invoiceId, supabase);
    expect(detail).not.toBeNull();
    expect(detail!.totalAmount).toBe(20_000);
    expect(detail!.totalPaid).toBe(12_000);
    expect(detail!.creditNoteReduction).toBe(0);
    expect(detail!.outstandingBalance).toBe(8_000);
    expect(detail!.lines.length).toBeGreaterThan(0);
    expect(detail!.ledger.length).toBeGreaterThanOrEqual(2); // invoice_issued + payment_allocation
  });

  it("FIN-03-01: getInvoiceDetail untuk invoice milik company lain mengembalikan null (bukan data company lain yang bocor)", async () => {
    const invB = await createInvoice(otherCompanyId, `${runTag}-XT`, otherFinanceUser.userId);
    const detail = await getInvoiceDetail(companyId, invB.invoiceId, supabase);
    expect(detail).toBeNull();
  });

  it("FIN-04-01: getInvoiceList mengembalikan kolom sesuai kontrak §6 dan filter financial_status berfungsi", async () => {
    const invOutstanding = await createInvoice(companyId, `${runTag}-LISTOUT`, financeUser.userId, 5, 1000);
    const invPaid = await createInvoice(companyId, `${runTag}-LISTPAID`, financeUser.userId, 5, 1000);
    await pay(financeUser.userId, invPaid.invoiceId, invPaid.totalAmount, `${runTag}-listpaid`);

    const all = await getInvoiceList(companyId, {}, supabase);
    const ids = all.items.map((i) => i.id);
    expect(ids).toContain(invOutstanding.invoiceId);
    expect(ids).toContain(invPaid.invoiceId);
    const paidItem = all.items.find((i) => i.id === invPaid.invoiceId)!;
    expect(paidItem.financialStatus).toBe("paid");
    expect(paidItem.outstandingBalance).toBe(0);

    const onlyPaid = await getInvoiceList(companyId, { financialStatus: "paid" }, supabase);
    expect(onlyPaid.items.every((i) => i.financialStatus === "paid")).toBe(true);
    expect(onlyPaid.items.map((i) => i.id)).toContain(invPaid.invoiceId);
    expect(onlyPaid.items.map((i) => i.id)).not.toContain(invOutstanding.invoiceId);
  });

  it("FIN-12-02 (setara level query): company tanpa invoice sama sekali mengembalikan list kosong, bukan error", async () => {
    const emptyCompanyId = randomUUID();
    createdCompanyIds.push(emptyCompanyId);
    await insertCompany(emptyCompanyId, `${runTag}-EMPTY`, "W2E");

    const result = await getInvoiceList(emptyCompanyId, {}, supabase);
    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
  });

  it("FIN-04-04: getReconciliationHistory menampilkan seluruh baris riwayat (reconcile + correction) urut waktu, bukan hanya baris terakhir", async () => {
    const inv = await createInvoice(companyId, `${runTag}-HIST`, financeUser.userId, 10, 1000);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, 4000, `${runTag}-hist`);

    const { data: reconData, error: reconErr } = await supabase.rpc("reconcile_verified_payment", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_payment_receipt_id: receiptId,
      p_method: "manual",
      p_idempotency_key: null,
    });
    expect(reconErr).toBeNull();
    const reconciliationId = (reconData as Array<{ out_reconciliation_id: string }>)[0].out_reconciliation_id;

    const { error: correctErr } = await supabase.rpc("correct_payment_reconciliation", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_reconciliation_id: reconciliationId,
      p_reason: "Re-check rutin",
      p_idempotency_key: null,
    });
    expect(correctErr).toBeNull();

    const history = await getReconciliationHistory(companyId, receiptId, supabase);
    expect(history.length).toBe(2);
    expect(new Date(history[0].createdAt).getTime()).toBeLessThanOrEqual(new Date(history[1].createdAt).getTime());
    expect(history[1].previousReconciliationId).toBe(reconciliationId);
  });

  it("getPromiseList menampilkan janji bayar yang baru dibuat dengan status 'open'", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PROMISELIST`, financeUser.userId, 10, 1000);
    const { data, error } = await supabase.rpc("create_promise_to_pay", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_invoice_id: inv.invoiceId,
      p_promised_amount: 5000,
      p_promised_date: "2099-01-01",
      p_channel: "phone",
    });
    expect(error).toBeNull();
    const promiseId = (data as Array<{ out_promise_id: string }>)[0].out_promise_id;

    const promises = await getPromiseList(companyId, supabase);
    const found = promises.find((p) => p.id === promiseId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("open");
    expect(found!.invoiceNumber).toBeTruthy();
  });

  it("getPaymentReceiptList menghitung proofCount/allocationCount dan mengikuti klasifikasi rekonsiliasi terbaru", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PAYLIST`, financeUser.userId, 10, 1000);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, inv.totalAmount, `${runTag}-paylist`);

    const beforeReconcile = await getPaymentReceiptList(companyId, supabase);
    const beforeItem = beforeReconcile.find((r) => r.id === receiptId)!;
    expect(beforeItem.proofCount).toBe(1);
    expect(beforeItem.allocationCount).toBe(1);
    expect(beforeItem.isReconciled).toBe(false);
    expect(beforeItem.latestReconciliationClassification).toBeNull();

    await supabase.rpc("reconcile_verified_payment", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_payment_receipt_id: receiptId,
      p_method: "manual",
      p_idempotency_key: null,
    });

    const afterReconcile = await getPaymentReceiptList(companyId, supabase);
    const afterItem = afterReconcile.find((r) => r.id === receiptId)!;
    expect(afterItem.isReconciled).toBe(true);
    expect(afterItem.latestReconciliationClassification).toBe("matched");
  });

  it("getReconciliationExceptionList HANYA memuat exception nyata (unmatched), bukan cicilan sah yang fully allocated (matched)", async () => {
    const invInstall = await createInvoice(companyId, `${runTag}-EXCINSTALL`, financeUser.userId, 10, 1000);
    const receiptInstall = await pay(financeUser.userId, invInstall.invoiceId, 3000, `${runTag}-excinstall`);
    await supabase.rpc("reconcile_verified_payment", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_payment_receipt_id: receiptInstall,
      p_method: "manual",
      p_idempotency_key: null,
    });

    const customer = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${runTag}-EXCUNMATCHED`, code: `CUST-${runTag}-EXCUNMATCHED` })
      .select("id")
      .single();
    const customerId = (customer.data as { id: string }).id;
    createdCustomerIds.push(customerId);
    const { data: unmatchedReceipt } = await supabase
      .from("payment_receipts")
      .insert({ company_id: companyId, customer_id: customerId, method: "cash", amount: 2000, recorded_by: financeUser.userId, request_payload: {} })
      .select("id")
      .single();
    const receiptUnmatched = (unmatchedReceipt as { id: string }).id;
    await supabase.rpc("reconcile_verified_payment", {
      p_company_id: companyId,
      p_actor_id: financeUser.userId,
      p_payment_receipt_id: receiptUnmatched,
      p_method: "manual",
      p_idempotency_key: null,
    });

    const exceptions = await getReconciliationExceptionList(companyId, supabase);
    const ids = exceptions.map((e) => e.paymentReceiptId);
    expect(ids).toContain(receiptUnmatched);
    expect(ids).not.toContain(receiptInstall);
    expect(exceptions.find((e) => e.paymentReceiptId === receiptUnmatched)!.classification).toBe("unmatched");
  });
});
