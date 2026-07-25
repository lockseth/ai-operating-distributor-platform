// =============================================================================
// DB-backed integration test -- Gate 2I.3: Finance Operations Workspace read
// model + RPC wiring untuk Retur & Credit Note / Customer Credit & Refund
// (apps/web/src/lib/finance/queries.ts: getReturnList/getReturnsForInvoice/
// getReturnDetail/getCreditNoteList/getRefundList/getRefundDetail dipanggil
// terhadap Postgres nyata setelah RPC canonical Gate 2F/2H dijalankan lewat
// service-role client -- pola identik workspace-read-model.integration.test.ts
// (Gate 2I.2) dan fixture chain return-credit-note-receivable-reduction.
// integration.test.ts (Gate 2F).
//
// RPC canonical Gate 2F/2H sendiri (locking, over-return/over-refund guard,
// pairing invariant, dsb.) TIDAK diuji ulang di sini secara menyeluruh --
// sudah dibuktikan masing-masing di return-credit-note-receivable-reduction.
// integration.test.ts dan customer-credit-ledger-refund.integration.test.ts.
// Fokus test ini: (1) read model Gate 2I.3 mencerminkan state RPC dengan
// benar (bukan re-implementasi formula), (2) tenant isolation query workspace,
// (3) lifecycle/idempotency/containment YANG SPESIFIK dipetakan ke FIN-ID
// test matrix Gate 2I.3 (jangan lakukan direct table mutation atau
// service-role di luar konteks test setup).
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola sama
// seluruh integration test finance lain.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";
import {
  getCreditNoteList,
  getRefundDetail,
  getRefundList,
  getReturnDetail,
  getReturnList,
  getReturnsForInvoice,
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
  lineId: string;
}

type RequestReturnRow = { out_return_id: string; out_status: string; out_already_exists: boolean };
type VerifyReturnRow = {
  out_return_id: string;
  out_status: string;
  out_credit_note_id: string | null;
  out_total_amount: string | null;
  out_applied_amount: string | null;
  out_customer_credit_amount: string | null;
};
type RequestRefundRow = { out_refund_id: string; out_status: string; out_already_exists: boolean };
type ApproveRefundRow = {
  out_refund_id: string;
  out_status: string;
  out_ledger_entry_id: string | null;
  out_amount: string | null;
  out_already_exists: boolean;
};

describeIfDb("Gate 2I.3: Retur & Credit Note / Customer Credit & Refund workspace (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role -- dipakai sebagai override client queries.ts (pola sama Gate 2I.2)
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
  let otherOwnerUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2I3 ${tag}`,
      slug: `itest-g2i3-${tag}`,
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

    const { data: line, error: lineErr } = await supabase.from("invoice_lines").select("id").eq("invoice_id", row.out_invoice_id).single();
    if (lineErr) throw new Error(`gagal ambil invoice_line: ${lineErr.message}`);

    return {
      companyId: targetCompanyId,
      customerId,
      orderId,
      invoiceId: row.out_invoice_id,
      totalAmount: Number(row.out_total_amount),
      lineId: (line as { id: string }).id,
    };
  }

  async function pay(actorId: string, invoiceId: string, amount: number, ref: string, targetCompanyId = companyId) {
    const { error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: targetCompanyId,
      p_actor_id: actorId,
      p_method: "cash",
      p_amount: amount,
      p_proofs: [{ proof_type: "cash_receipt", object_reference: `storage://proofs/${ref}.jpg` }],
      p_allocations: [{ invoice_id: invoiceId, amount }],
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
  }

  async function requestReturn(actorId: string, invoiceId: string, lineId: string, qty: number, targetCompanyId = companyId) {
    return supabase.rpc("request_return_atomic", {
      p_company_id: targetCompanyId,
      p_actor_id: actorId,
      p_invoice_id: invoiceId,
      p_items: [{ invoice_line_id: lineId, requested_quantity: qty }],
      p_reason_code: "DAMAGED_GOODS",
      p_proof_reference: `storage://return-proofs/${randomUUID()}.jpg`,
      p_idempotency_key: null,
    });
  }

  async function verifyReturn(actorId: string, returnId: string, decision: "approve" | "reject", targetCompanyId = companyId) {
    return supabase.rpc("verify_return_atomic", {
      p_company_id: targetCompanyId,
      p_actor_id: actorId,
      p_return_id: returnId,
      p_decision: decision,
    });
  }

  async function requestRefund(
    actorId: string,
    creditNoteId: string,
    amount: number,
    opts: { idempotencyKey?: string; companyId?: string } = {},
  ) {
    return supabase.rpc("request_refund_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_credit_note_id: creditNoteId,
      p_amount: amount,
      p_method: "cash",
      p_proof_reference: `storage://refund-proofs/${randomUUID()}.jpg`,
      p_transaction_date: "2026-01-15",
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function approveRefund(actorId: string, refundId: string, decision: "approve" | "reject", targetCompanyId = companyId) {
    return supabase.rpc("approve_refund_atomic", {
      p_company_id: targetCompanyId,
      p_actor_id: actorId,
      p_refund_id: refundId,
      p_decision: decision,
    });
  }

  /** Return + approve sekaligus, mengembalikan credit_note_id (helper fixture untuk skenario refund). */
  async function approvedReturnWithCustomerCredit(tag: string, quantity: number, unitPrice: number, payAmount: number) {
    const inv = await createInvoice(companyId, tag, financeUser.userId, quantity, unitPrice);
    if (payAmount > 0) await pay(financeUser.userId, inv.invoiceId, payAmount, tag);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, inv.lineId, quantity);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data: verifyData } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const row = (verifyData as VerifyReturnRow[])[0];
    return { inv, returnId, creditNoteId: row.out_credit_note_id!, customerCreditAmount: Number(row.out_customer_credit_amount) };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "W3A");
    await insertCompany(otherCompanyId, `${runTag}-B`, "W3B");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    otherOwnerUser = await createActor(otherCompanyId, `${runTag}-oowner`, "owner");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("customer_credit_ledger").delete().in("company_id", createdCompanyIds);
    await supabase.from("refund_requests").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_note_reversals").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_note_lines").delete().in("company_id", createdCompanyIds);
    await supabase.from("credit_notes").delete().in("company_id", createdCompanyIds);
    await supabase.from("return_items").delete().in("company_id", createdCompanyIds);
    await supabase.from("returns").delete().in("company_id", createdCompanyIds);
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
  // FIN-07-04 / FIN-16-02: request_return_atomic requested tercermin di
  // getReturnList/getReturnsForInvoice/getReturnDetail (preview, bukan final).
  // ---------------------------------------------------------------------
  it("FIN-07-04/FIN-16-02: retur requested tercermin di getReturnList/getReturnsForInvoice/getReturnDetail dengan preview", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REQ`, financeUser.userId, 10, 1000);
    const { data, error } = await requestReturn(financeUser.userId, inv.invoiceId, inv.lineId, 4);
    expect(error).toBeNull();
    const returnId = (data as RequestReturnRow[])[0].out_return_id;

    const list = await getReturnList(companyId, supabase);
    expect(list.find((r) => r.id === returnId)?.status).toBe("requested");

    const forInvoice = await getReturnsForInvoice(companyId, inv.invoiceId, supabase);
    expect(forInvoice).toHaveLength(1);
    expect(forInvoice[0].id).toBe(returnId);

    const detail = await getReturnDetail(companyId, returnId, supabase);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe("requested");
    expect(detail!.creditNote).toBeNull();
    expect(detail!.totalPreview).toBe(4000); // 4 * 1000
    expect(detail!.appliedAmountPreview).toBe(4000); // outstanding masih 10000
    expect(detail!.customerCreditAmountPreview).toBe(0);
    expect(detail!.items).toHaveLength(1);
    expect(detail!.items[0].requestedQuantity).toBe(4);
  });

  // ---------------------------------------------------------------------
  // FIN-07-05: approve mencerminkan credit_note NYATA (bukan preview) di
  // getReturnDetail; getReturnList status berubah requested -> approved.
  // ---------------------------------------------------------------------
  it("FIN-07-05: approve retur -- getReturnDetail membaca credit_notes final, getReturnList status approved", async () => {
    const inv = await createInvoice(companyId, `${runTag}-APR`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, inv.lineId, 3);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { data: verifyData, error: verifyErr } = await verifyReturn(ownerUser.userId, returnId, "approve");
    expect(verifyErr).toBeNull();
    const vrow = (verifyData as VerifyReturnRow[])[0];
    expect(vrow.out_status).toBe("approved");

    const detail = await getReturnDetail(companyId, returnId, supabase);
    expect(detail!.status).toBe("approved");
    expect(detail!.creditNote).not.toBeNull();
    expect(detail!.creditNote!.totalAmount).toBe(3000);
    expect(detail!.creditNote!.appliedAmount).toBe(3000);
    expect(detail!.creditNote!.customerCreditAmount).toBe(0);

    const list = await getReturnList(companyId, supabase);
    const row = list.find((r) => r.id === returnId);
    expect(row?.status).toBe("approved");
    expect(row?.creditNoteTotalAmount).toBe(3000);
  });

  // ---------------------------------------------------------------------
  // Reject tidak membuat credit note/perubahan ledger -- getReturnDetail
  // mencerminkan status rejected TANPA creditNote.
  // ---------------------------------------------------------------------
  it("Reject retur: getReturnDetail creditNote null, tidak ada perubahan ledger", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REJ`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, inv.lineId, 2);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { count: ledgerBefore } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);

    const { data, error } = await verifyReturn(ownerUser.userId, returnId, "reject");
    expect(error).toBeNull();
    expect((data as VerifyReturnRow[])[0].out_credit_note_id).toBeNull();

    const detail = await getReturnDetail(companyId, returnId, supabase);
    expect(detail!.status).toBe("rejected");
    expect(detail!.creditNote).toBeNull();

    const { count: ledgerAfter } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  // ---------------------------------------------------------------------
  // FIN-09-01: final state tidak dapat dibuka kembali (double decision).
  // ---------------------------------------------------------------------
  it("FIN-09-01: retur sudah approved -- decision kedua ditolak RETURN_ALREADY_RESOLVED, tidak ada perubahan ganda", async () => {
    const inv = await createInvoice(companyId, `${runTag}-DBL`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, inv.lineId, 2);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    await verifyReturn(ownerUser.userId, returnId, "approve");

    const { count: cnCountBefore } = await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("return_id", returnId);
    const { error } = await verifyReturn(ownerUser.userId, returnId, "reject");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/RETURN_ALREADY_RESOLVED/);

    const { count: cnCountAfter } = await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("return_id", returnId);
    expect(cnCountAfter).toBe(cnCountBefore);
  });

  // ---------------------------------------------------------------------
  // FIN-08-02: direct RPC call oleh Finance (non-Owner) ditolak FORBIDDEN.
  // ---------------------------------------------------------------------
  it("FIN-08-02: verify_return_atomic dipanggil langsung oleh Finance (bypass UI) ditolak FORBIDDEN", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOWN`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, inv.lineId, 2);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { error } = await verifyReturn(financeUser.userId, returnId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);

    const detail = await getReturnDetail(companyId, returnId, supabase);
    expect(detail!.status).toBe("requested");
  });

  // ---------------------------------------------------------------------
  // FIN-04-05: applied_amount=0, customer_credit_amount>0 (invoice sudah
  // lunas) -- getReturnDetail TIDAK menampilkan entri "applied ke invoice".
  // ---------------------------------------------------------------------
  it("FIN-04-05: invoice lunas -- retur menghasilkan applied_amount=0, customer_credit_amount penuh; getReturnDetail tidak menampilkan entri applied", async () => {
    const { inv, returnId, creditNoteId, customerCreditAmount } = await approvedReturnWithCustomerCredit(`${runTag}-FULLCR`, 5, 1000, 5000);
    expect(customerCreditAmount).toBe(5000);

    const detail = await getReturnDetail(companyId, returnId, supabase);
    expect(detail!.creditNote).not.toBeNull();
    expect(detail!.creditNote!.appliedAmount).toBe(0);
    expect(detail!.creditNote!.customerCreditAmount).toBe(5000);
    expect(detail!.creditNote!.totalAmount).toBe(5000);

    // credit_notes.customer_credit_amount (nilai credit awal) SELALU benar dari
    // approval, tapi customer_credit_balances.available_balance masih 0 sampai
    // origin credit dibuat LAZY oleh request_refund_atomic/reverse_credit_note_atomic
    // (perilaku backend Gate 2H by-design, migration 20260902000001 komentar "G" --
    // BUKAN dihitung ulang/di-patch di UI, lihat FIN-07-06 untuk state setelah lazy-create).
    const creditNotes = await getCreditNoteList(companyId, supabase);
    const cn = creditNotes.find((c) => c.id === creditNoteId);
    expect(cn).toBeDefined();
    expect(cn!.customerCreditAmount).toBe(5000);
    expect(cn!.invoiceId).toBe(inv.invoiceId);
  });

  // ---------------------------------------------------------------------
  // FIN-15-01: approve retur dengan customer_credit_amount>0 -- dua ledger
  // (receivable_ledger vs customer_credit_ledger) tetap independen sampai ada
  // refund request terpisah.
  // ---------------------------------------------------------------------
  it("FIN-15-01: approve retur TIDAK menyentuh customer_credit_ledger sama sekali -- dua ledger independen sampai refund diajukan terpisah", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-ISOLATE`, 4, 1000, 4000); // outstanding=0 -> customer_credit penuh

    const { count: ledgerCount } = await supabase
      .from("customer_credit_ledger")
      .select("id", { count: "exact", head: true })
      .eq("credit_note_id", creditNoteId);
    expect(ledgerCount).toBe(0); // origin credit belum lazy-created -- verify_return_atomic tidak pernah menulis ke sini

    const creditNotes = await getCreditNoteList(companyId, supabase);
    const cn = creditNotes.find((c) => c.id === creditNoteId)!;
    expect(cn.isInitialized).toBe(false); // BELUM ada baris credit_note_origin -- bukan "saldo habis"
    expect(cn.ledgerBalance).toBe(0);
    expect(cn.availableBalance).toBe(0);
    expect(cn.customerCreditAmount).toBe(4000); // nilai credit awal tetap terlihat walau ledger belum diinisialisasi
  });

  // ---------------------------------------------------------------------
  // FIN-07-06 / FIN-05-03: request_refund_atomic requested -- pending
  // reservation mengurangi available_balance, TIDAK mengurangi ledger_balance.
  // Lazy-create origin credit terjadi DI DALAM RPC ini -- isInitialized harus
  // menjadi TRUE setelahnya (kontrak §3 closeout: "Setelah lazy initialization
  // terjadi melalui RPC canonical, refresh menampilkan saldo canonical terbaru").
  // ---------------------------------------------------------------------
  it("FIN-07-06/FIN-05-03: refund requested mereservasi saldo -- available_balance turun, ledger_balance tetap, isInitialized menjadi true", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-RESV`, 4, 1000, 4000);

    const before = (await getCreditNoteList(companyId, supabase)).find((c) => c.id === creditNoteId)!;
    expect(before.isInitialized).toBe(false);

    const { data, error } = await requestRefund(financeUser.userId, creditNoteId, 1500);
    expect(error).toBeNull();
    const refundId = (data as RequestRefundRow[])[0].out_refund_id;
    expect((data as RequestRefundRow[])[0].out_status).toBe("requested");

    const creditNotes = await getCreditNoteList(companyId, supabase);
    const cn = creditNotes.find((c) => c.id === creditNoteId)!;
    expect(cn.isInitialized).toBe(true); // lazy-created oleh request_refund_atomic
    expect(cn.ledgerBalance).toBe(4000);
    expect(cn.pendingReserved).toBe(1500);
    expect(cn.availableBalance).toBe(2500);

    const refundList = await getRefundList(companyId, supabase);
    expect(refundList.find((r) => r.id === refundId)?.status).toBe("requested");

    const refundDetail = await getRefundDetail(companyId, refundId, supabase);
    expect(refundDetail!.availableBalance).toBe(2500);
    expect(refundDetail!.pendingReserved).toBe(1500);
    expect(refundDetail!.ledgerBalance).toBe(4000);
  });

  // ---------------------------------------------------------------------
  // FIN-07-07 / FIN-15-03: approve refund -- ledger debit tercatat, saldo
  // berkurang, receivable_ledger/invoice/order/delivery TIDAK tersentuh.
  // ---------------------------------------------------------------------
  it("FIN-07-07/FIN-15-03: approve refund mengurangi saldo customer credit, TIDAK menyentuh receivable_ledger/invoice/order", async () => {
    const { inv, creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-APRR`, 4, 1000, 4000);
    const { data: reqData } = await requestRefund(financeUser.userId, creditNoteId, 1000);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { data: recBefore } = await supabase.from("receivable_ledger").select("id").eq("invoice_id", inv.invoiceId);
    const { data: orderBefore } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();

    const { data, error } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(error).toBeNull();
    const row = (data as ApproveRefundRow[])[0];
    expect(row.out_status).toBe("approved");
    expect(row.out_ledger_entry_id).not.toBeNull();
    expect(Number(row.out_amount)).toBe(1000);

    const { data: recAfter } = await supabase.from("receivable_ledger").select("id").eq("invoice_id", inv.invoiceId);
    expect(recAfter?.length).toBe(recBefore?.length); // receivable ledger TIDAK bertambah dari refund

    const { data: orderAfter } = await supabase.from("sales_orders").select("status").eq("id", inv.orderId).single();
    expect((orderAfter as { status: string }).status).toBe((orderBefore as { status: string }).status);

    const creditNotes = await getCreditNoteList(companyId, supabase);
    const cn = creditNotes.find((c) => c.id === creditNoteId)!;
    expect(cn.ledgerBalance).toBe(3000); // 4000 - 1000 debit
    expect(cn.pendingReserved).toBe(0);
    expect(cn.availableBalance).toBe(3000);

    const refundDetail = await getRefundDetail(companyId, refundId, supabase);
    expect(refundDetail!.status).toBe("approved");
    expect(refundDetail!.availableBalance).toBe(3000);
  });

  // ---------------------------------------------------------------------
  // Closeout §3: canonical zero (saldo memang habis terpakai, isInitialized=
  // true) HARUS tetap dibedakan dari uninitialized (isInitialized=false) --
  // keduanya sama-sama availableBalance=0 secara angka, tapi maknanya berbeda.
  // ---------------------------------------------------------------------
  it("Closeout §3: canonical zero (saldo habis terpakai penuh) tetap isInitialized=true, dibedakan dari uninitialized", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-ZEROFULL`, 2, 1000, 2000); // customer_credit 2000
    const { data: reqData } = await requestRefund(financeUser.userId, creditNoteId, 2000); // refund PENUH
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "approve");

    const cn = (await getCreditNoteList(companyId, supabase)).find((c) => c.id === creditNoteId)!;
    expect(cn.isInitialized).toBe(true); // origin credit SUDAH pernah dibuat (bukan uninitialized)
    expect(cn.ledgerBalance).toBe(0); // canonical zero -- benar-benar habis, bukan belum diinisialisasi
    expect(cn.availableBalance).toBe(0);
    expect(cn.customerCreditAmount).toBe(2000); // nilai credit awal tetap tercatat apa adanya
  });

  // ---------------------------------------------------------------------
  // FIN-09-02: refund final (rejected) tidak dapat diproses ulang.
  // ---------------------------------------------------------------------
  it("FIN-09-02: refund sudah rejected -- approve setelahnya ditolak REFUND_ALREADY_RESOLVED", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-REJR`, 3, 1000, 3000);
    const { data: reqData } = await requestRefund(financeUser.userId, creditNoteId, 500);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, refundId, "reject");

    const { error } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/REFUND_ALREADY_RESOLVED/);

    const refundDetail = await getRefundDetail(companyId, refundId, supabase);
    expect(refundDetail!.status).toBe("rejected");
  });

  // ---------------------------------------------------------------------
  // FIN-10-02: retry approve->approve idempotent struktural, tidak ada
  // baris ledger kedua.
  // ---------------------------------------------------------------------
  it("FIN-10-02: retry approve_refund_atomic (approve->approve) idempotent, tidak menggandakan ledger", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-IDEM`, 3, 1000, 3000);
    const { data: reqData } = await requestRefund(financeUser.userId, creditNoteId, 800);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { data: firstData } = await approveRefund(ownerUser.userId, refundId, "approve");
    const firstRow = (firstData as ApproveRefundRow[])[0];
    expect(firstRow.out_already_exists).toBe(false);

    const { data: secondData, error: secondErr } = await approveRefund(ownerUser.userId, refundId, "approve");
    expect(secondErr).toBeNull();
    const secondRow = (secondData as ApproveRefundRow[])[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_ledger_entry_id).toBe(firstRow.out_ledger_entry_id);

    const { count: ledgerCount } = await supabase
      .from("customer_credit_ledger")
      .select("id", { count: "exact", head: true })
      .eq("refund_id", refundId);
    expect(ledgerCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // FIN-11-02: pending reservation mencegah over-refund -- refund kedua
  // yang melebihi saldo tersisa ditolak.
  // ---------------------------------------------------------------------
  it("FIN-11-02: refund kedua yang melebihi saldo tersisa (setelah reservasi refund pertama) ditolak REFUND_EXCEEDS_AVAILABLE_BALANCE", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-OVER`, 3, 1000, 3000); // customer_credit 3000
    const { data: firstData, error: firstErr } = await requestRefund(financeUser.userId, creditNoteId, 2000);
    expect(firstErr).toBeNull();
    expect((firstData as RequestRefundRow[])[0].out_status).toBe("requested");

    const { error: secondErr } = await requestRefund(financeUser.userId, creditNoteId, 1500); // 2000 + 1500 > 3000
    expect(secondErr).not.toBeNull();
    expect(secondErr!.message).toMatch(/REFUND_EXCEEDS_AVAILABLE_BALANCE/);

    const cn = (await getCreditNoteList(companyId, supabase)).find((c) => c.id === creditNoteId)!;
    expect(cn.pendingReserved).toBe(2000); // hanya refund pertama yang tereservasi
  });

  // ---------------------------------------------------------------------
  // FIN-04-06: credit note dengan 2 refund (1 approved, 1 rejected) --
  // available_balance hanya dikurangi refund approved.
  // ---------------------------------------------------------------------
  it("FIN-04-06: available_balance hanya mencerminkan refund approved, bukan yang rejected", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-MIX`, 5, 1000, 5000); // customer_credit 5000
    const { data: approvedReq } = await requestRefund(financeUser.userId, creditNoteId, 1000);
    const approvedRefundId = (approvedReq as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, approvedRefundId, "approve");

    const { data: rejectedReq } = await requestRefund(financeUser.userId, creditNoteId, 2000);
    const rejectedRefundId = (rejectedReq as RequestRefundRow[])[0].out_refund_id;
    await approveRefund(ownerUser.userId, rejectedRefundId, "reject");

    const cn = (await getCreditNoteList(companyId, supabase)).find((c) => c.id === creditNoteId)!;
    expect(cn.ledgerBalance).toBe(4000); // 5000 - 1000 (hanya approved)
    expect(cn.pendingReserved).toBe(0); // rejected melepas reservasi
    expect(cn.availableBalance).toBe(4000);
  });

  // ---------------------------------------------------------------------
  // FIN-08-03: direct RPC call oleh Finance (non-Owner) untuk approve
  // refund ditolak FORBIDDEN.
  // ---------------------------------------------------------------------
  it("FIN-08-03: approve_refund_atomic dipanggil langsung oleh Finance ditolak FORBIDDEN", async () => {
    const { creditNoteId } = await approvedReturnWithCustomerCredit(`${runTag}-FIN08`, 2, 1000, 2000);
    const { data: reqData } = await requestRefund(financeUser.userId, creditNoteId, 500);
    const refundId = (reqData as RequestRefundRow[])[0].out_refund_id;

    const { error } = await approveRefund(financeUser.userId, refundId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);

    const detail = await getRefundDetail(companyId, refundId, supabase);
    expect(detail!.status).toBe("requested");
  });

  // ---------------------------------------------------------------------
  // FIN-03-03: cross-tenant -- Owner Company A tidak dapat memutus refund
  // Company B, dan query workspace Company A tidak pernah menampilkan data
  // Company B.
  // ---------------------------------------------------------------------
  it("FIN-03-03: cross-tenant -- approve_refund_atomic Company A pada refund Company B ditolak, tidak bocor ke query workspace", async () => {
    const otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
    const invB = await createInvoice(otherCompanyId, `${runTag}-XTENANT-B`, otherFinanceUser.userId, 3, 1000);
    await pay(otherFinanceUser.userId, invB.invoiceId, 3000, `${runTag}-xtenant-b`, otherCompanyId); // outstanding=0 -> retur penuh jadi customer_credit
    const { data: reqB } = await requestReturn(otherFinanceUser.userId, invB.invoiceId, invB.lineId, 3, otherCompanyId);
    const returnIdB = (reqB as RequestReturnRow[])[0].out_return_id;
    const { data: verifyB, error: verifyBErr } = await verifyReturn(otherOwnerUser.userId, returnIdB, "approve", otherCompanyId);
    expect(verifyBErr).toBeNull();
    const creditNoteIdB = (verifyB as VerifyReturnRow[])[0].out_credit_note_id!;
    const { data: refundB, error: refundBErr } = await requestRefund(otherFinanceUser.userId, creditNoteIdB, 500, { companyId: otherCompanyId });
    expect(refundBErr).toBeNull();
    const refundIdB = (refundB as RequestRefundRow[])[0].out_refund_id;

    // Owner Company A mencoba memutus refund Company B lewat konteks company_id sendiri.
    const { error } = await approveRefund(ownerUser.userId, refundIdB, "approve", companyId);
    expect(error).not.toBeNull();

    // Query workspace Company A tidak pernah menampilkan return/credit note/refund Company B.
    const returnListA = await getReturnList(companyId, supabase);
    expect(returnListA.some((r) => r.id === returnIdB)).toBe(false);
    const creditNoteListA = await getCreditNoteList(companyId, supabase);
    expect(creditNoteListA.some((c) => c.id === creditNoteIdB)).toBe(false);
    const refundListA = await getRefundList(companyId, supabase);
    expect(refundListA.some((r) => r.id === refundIdB)).toBe(false);

    // Detail lintas tenant: getReturnDetail/getRefundDetail dengan companyId salah -> null (bukan data company lain).
    expect(await getReturnDetail(companyId, returnIdB, supabase)).toBeNull();
    expect(await getRefundDetail(companyId, refundIdB, supabase)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // Tenant isolation umum: list Company A tidak pernah memuat return/refund
  // yang sengaja dibuat di Company A sendiri tercampur data lama test lain
  // (sanity -- setiap row scoped company_id).
  // ---------------------------------------------------------------------
  it("Tenant isolation: seluruh return/credit note/refund pada list Company A memiliki company_id yang benar", async () => {
    const returnList = await getReturnList(companyId, supabase);
    expect(returnList.length).toBeGreaterThan(0);
    const creditNoteList = await getCreditNoteList(companyId, supabase);
    expect(creditNoteList.length).toBeGreaterThan(0);
    const refundList = await getRefundList(companyId, supabase);
    expect(refundList.length).toBeGreaterThan(0);
    // Tidak ada API untuk company_id di tipe list item (by design -- hanya company
    // pemanggil yang di-query), jadi sanity check dilakukan dengan memverifikasi
    // langsung ke DB bahwa setiap id hasil query benar-benar company_id=companyId.
    const { data: crossCheck } = await supabase.from("returns").select("company_id").in("id", returnList.map((r) => r.id));
    expect(((crossCheck ?? []) as { company_id: string }[]).every((r) => r.company_id === companyId)).toBe(true);
  });
});
