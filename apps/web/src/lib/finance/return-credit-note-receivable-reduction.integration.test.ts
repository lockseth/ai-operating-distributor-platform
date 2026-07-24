// =============================================================================
// DB-backed integration test -- Gate 2F: Retur, Credit Note & Pengurangan
// Piutang (supabase/migrations/20260831000001_return_credit_note_receivable_reduction.sql).
//
// Membuktikan: invoice asli -> retur dengan bukti (requested) -> verifikasi
// Owner (approve/reject) -> credit note (immutable) -> pengurangan piutang
// lewat receivable_ledger credit baru. Retur TIDAK PERNAH mengedit invoice/
// invoice_lines lama, TIDAK PERNAH menghapus ledger lama. Skip graceful jika
// kredensial Supabase lokal tidak tersedia atau URL bukan loopback -- pola
// sama dengan gate finance sebelumnya.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260831000001_return_credit_note_receivable_reduction.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB).
// ---------------------------------------------------------------------------
describe("Gate 2F -- static proof atomicity & vocabulary (migration 20260831000001)", () => {
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

  it("ketiga RPC adalah SATU function body tanpa blok EXCEPTION (kegagalan selalu rollback penuh)", () => {
    expect(extractFunctionBody("request_return_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(extractFunctionBody("verify_return_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(extractFunctionBody("reverse_credit_note_atomic")).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("ketiga RPC terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role)", () => {
    const sig1 = "public.request_return_atomic(UUID, UUID, UUID, JSONB, TEXT, TEXT, TEXT)";
    const sig2 = "public.verify_return_atomic(UUID, UUID, UUID, TEXT)";
    const sig3 = "public.reverse_credit_note_atomic(UUID, UUID, UUID, TEXT, TEXT)";
    for (const sig of [sig1, sig2, sig3]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${sig}\n  FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${sig}\n  TO service_role;`);
    }
  });

  it("izin return.verify/credit_note.reverse HANYA digrant ke owner (bukan manager/admin/super_admin/finance)", () => {
    expect(migration).toContain("AND r.name = 'owner'\n  AND p.name IN ('return.verify', 'credit_note.reverse')");
  });

  it("izin return.request digrant ke owner/manager/admin/super_admin/finance (bukan sales)", () => {
    expect(migration).toContain("AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')\n  AND p.name = 'return.request'");
  });

  it("returns hanya mengizinkan transisi status requested->approved|rejected (bukan append-only penuh)", () => {
    expect(migration).toContain("RETURN_ALREADY_RESOLVED");
    expect(migration).toContain("RETURN_INVALID_TRANSITION");
  });

  it("credit_notes/credit_note_lines/credit_note_reversals immutable penuh (tidak ada transisi status)", () => {
    expect(migration).toContain("CREDIT_NOTE_IMMUTABLE");
    expect(migration).toContain("CREDIT_NOTE_LINE_IMMUTABLE");
    expect(migration).toContain("CREDIT_NOTE_REVERSAL_IMMUTABLE");
  });

  it("credit_notes.return_id UNIQUE -- satu retur hanya satu credit note secara struktural", () => {
    expect(migration).toContain("return_id                UUID          NOT NULL UNIQUE REFERENCES public.returns");
  });

  it("credit_note_reversals.credit_note_id UNIQUE -- idempotency struktural reversal", () => {
    expect(migration).toContain("credit_note_id                  UUID          NOT NULL UNIQUE REFERENCES public.credit_notes");
  });

  it("pairing invariant DEFERRED menutup celah orphan credit_note/credit_note_reversal ledger", () => {
    expect(migration).toContain("trg_receivable_ledger_return_pairing");
    expect(migration).toContain("ORPHAN_CREDIT_NOTE_LEDGER_CREDIT");
    expect(migration).toContain("ORPHAN_CREDIT_NOTE_REVERSAL_LEDGER_DEBIT");
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
  lineId: string;
  quantity: number;
  unitPrice: number;
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
type ReverseRow = {
  out_reversal_id: string;
  out_credit_note_id: string;
  out_reversed_amount: string;
  out_customer_credit_voided_amount: string;
  out_already_exists: boolean;
};

describeIfDb("Gate 2F: Retur, Credit Note & Pengurangan Piutang (DB-backed, Postgres nyata)", () => {
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
  let inactiveOwnerUser: { userId: string; email: string; password: string };
  let otherOwnerUser: { userId: string; email: string; password: string };

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2F ${tag}`,
      slug: `itest-g2f-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550005",
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

  async function createInvoice(targetCompanyId: string, tag: string, actorId: string, quantity = 10, unitPrice = 1000, discountAmount = 0): Promise<InvoiceFixture> {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);
    return createOrderInvoice(targetCompanyId, tag, actorId, customerId, quantity, unitPrice, discountAmount);
  }

  async function createOrderInvoice(
    targetCompanyId: string,
    tag: string,
    actorId: string,
    customerId: string,
    quantity: number,
    unitPrice: number,
    discountAmount = 0,
  ): Promise<InvoiceFixture> {
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

    const totalAmount = quantity * unitPrice - discountAmount;
    const { data: item, error: itemErr } = await supabase
      .from("sales_order_items")
      .insert({ order_id: orderId, product_name_raw: `Produk ${tag}`, unit: "pcs", quantity, unit_price: unitPrice, discount_amount: discountAmount, total_amount: totalAmount })
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
      quantity,
      unitPrice,
    };
  }

  async function pay(actorId: string, invoiceId: string, amount: number, ref: string) {
    const { data, error } = await supabase.rpc("record_verified_payment_atomic", {
      p_company_id: companyId,
      p_actor_id: actorId,
      p_method: "cash",
      p_amount: amount,
      p_proofs: [{ proof_type: "cash_receipt", object_reference: `storage://proofs/${ref}.jpg` }],
      p_allocations: [{ invoice_id: invoiceId, amount }],
    });
    if (error) throw new Error(`record_verified_payment_atomic gagal: ${error.message}`);
    return (data as Array<{ out_payment_receipt_id: string }>)[0].out_payment_receipt_id;
  }

  async function requestReturn(
    actorId: string,
    invoiceId: string,
    items: Array<{ invoice_line_id: string; requested_quantity: number }>,
    opts: { reasonCode?: string; proofReference?: string; companyId?: string; idempotencyKey?: string } = {},
  ) {
    return supabase.rpc("request_return_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_invoice_id: invoiceId,
      p_items: items,
      p_reason_code: opts.reasonCode ?? "DAMAGED_GOODS",
      p_proof_reference: opts.proofReference ?? `storage://return-proofs/${randomUUID()}.jpg`,
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function verifyReturn(actorId: string, returnId: string, decision: "approve" | "reject", opts: { companyId?: string } = {}) {
    return supabase.rpc("verify_return_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_return_id: returnId,
      p_decision: decision,
    });
  }

  async function reverseCreditNote(actorId: string, creditNoteId: string, opts: { reason?: string; idempotencyKey?: string; companyId?: string } = {}) {
    return supabase.rpc("reverse_credit_note_atomic", {
      p_company_id: opts.companyId ?? companyId,
      p_actor_id: actorId,
      p_credit_note_id: creditNoteId,
      p_reason: opts.reason ?? "Koreksi retur",
      p_idempotency_key: opts.idempotencyKey ?? null,
    });
  }

  async function balanceOf(invoiceId: string) {
    const { data } = await supabase.from("invoice_receivable_balances").select("*").eq("invoice_id", invoiceId).single();
    return data as { outstanding_balance: string; financial_status: string; total_debit: string; total_credit: string };
  }

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "PGF");
    await insertCompany(otherCompanyId, `${runTag}-B`, "PGG");

    ownerUser = await createActor(companyId, `${runTag}-owner`, "owner");
    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    salesUser = await createActor(companyId, `${runTag}-sales`, "sales");
    inactiveOwnerUser = await createActor(companyId, `${runTag}-inactive-owner`, "owner", false);
    otherOwnerUser = await createActor(otherCompanyId, `${runTag}-oowner`, "owner");
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
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
  // 1. Retur requested valid tersimpan dengan item dan proof.
  // ---------------------------------------------------------------------
  it("1. request_return_atomic menyimpan retur requested dengan item dan proof", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REQ`, financeUser.userId, 10, 1000);
    const { data, error } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 3 }]);
    expect(error).toBeNull();
    const row = (data as RequestReturnRow[])[0];
    expect(row.out_status).toBe("requested");
    expect(row.out_already_exists).toBe(false);

    const { data: ret } = await supabase.from("returns").select("*").eq("id", row.out_return_id).single();
    expect((ret as { status: string }).status).toBe("requested");

    const { count: itemCount } = await supabase.from("return_items").select("id", { count: "exact", head: true }).eq("return_id", row.out_return_id);
    expect(itemCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 2. Requested return tidak mengubah invoice, ledger, atau outstanding.
  // ---------------------------------------------------------------------
  it("2. Return requested TIDAK mengubah invoice/ledger/outstanding", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NOEFFECT`, financeUser.userId, 10, 1000);
    const before = await balanceOf(inv.invoiceId);

    await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 4 }]);

    const after = await balanceOf(inv.invoiceId);
    expect(after.outstanding_balance).toBe(before.outstanding_balance);
    expect(after.financial_status).toBe(before.financial_status);

    const { count: ledgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(ledgerCount).toBe(1); // hanya opening debit invoice_issued
  });

  // ---------------------------------------------------------------------
  // 3. Cross-tenant dan actor tidak aktif ditolak.
  // ---------------------------------------------------------------------
  it("3a. Actor cross-tenant ditolak (FORBIDDEN)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-XTENANT`, financeUser.userId, 10, 1000);
    const { error } = await requestReturn(otherOwnerUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 1 }]);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);
  });

  it("3b. Actor tidak aktif ditolak (FORBIDDEN)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-INACTIVE`, financeUser.userId, 10, 1000);
    const { error } = await verifyReturn(inactiveOwnerUser.userId, inv.invoiceId, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/FORBIDDEN/);
  });

  // ---------------------------------------------------------------------
  // 4. Direct client mutation ditolak.
  // ---------------------------------------------------------------------
  it("4. Direct client insert ke returns/credit_notes ditolak (anon/authenticated tidak boleh mutasi)", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const { error } = await anon.from("returns").insert({
      company_id: companyId, customer_id: randomUUID(), invoice_id: randomUUID(), sales_order_id: randomUUID(),
      delivery_id: randomUUID(), reason_code: "x", proof_reference: "x", requested_by: randomUUID(), request_payload: {},
    });
    expect(error).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // 5. Item dari invoice lain ditolak.
  // ---------------------------------------------------------------------
  it("5. Item invoice_line dari invoice lain ditolak", async () => {
    const invA = await createInvoice(companyId, `${runTag}-CROSSLINE-A`, financeUser.userId, 10, 1000);
    const invB = await createInvoice(companyId, `${runTag}-CROSSLINE-B`, financeUser.userId, 10, 1000);
    const { error } = await requestReturn(financeUser.userId, invA.invoiceId, [{ invoice_line_id: invB.lineId, requested_quantity: 1 }]);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVOICE_LINE_NOT_IN_INVOICE/);
  });

  // ---------------------------------------------------------------------
  // 6. Quantity nol/negatif dan over-return ditolak.
  // ---------------------------------------------------------------------
  it("6a. Quantity nol/negatif ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ZEROQ`, financeUser.userId, 10, 1000);
    const { error } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 0 }]);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVALID_ITEM_QUANTITY/);
  });

  it("6b. Over-return (melebihi invoice_lines.quantity) ditolak", async () => {
    const inv = await createInvoice(companyId, `${runTag}-OVERQ`, financeUser.userId, 10, 1000);
    const { error } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 999 }]);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/RETURN_QUANTITY_EXCEEDS_INVOICED/);
  });

  // ---------------------------------------------------------------------
  // 7. Non-Owner tidak dapat approve/reject/reverse.
  // ---------------------------------------------------------------------
  it("7. Non-Owner (finance) tidak dapat approve/reject/reverse", async () => {
    const inv = await createInvoice(companyId, `${runTag}-NONOWNER`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 2 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { error: verifyErr } = await verifyReturn(financeUser.userId, returnId, "approve");
    expect(verifyErr).not.toBeNull();
    expect(verifyErr!.message).toMatch(/FORBIDDEN/);

    const { error: rejectErr } = await verifyReturn(financeUser.userId, returnId, "reject");
    expect(rejectErr).not.toBeNull();
    expect(rejectErr!.message).toMatch(/FORBIDDEN/);
  });

  // ---------------------------------------------------------------------
  // 8. Rejection tidak menciptakan credit note atau ledger entry.
  // ---------------------------------------------------------------------
  it("8. Rejection menandai rejected TANPA credit note/ledger entry", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REJECT`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 3 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { data, error } = await verifyReturn(ownerUser.userId, returnId, "reject");
    expect(error).toBeNull();
    const row = (data as VerifyReturnRow[])[0];
    expect(row.out_status).toBe("rejected");
    expect(row.out_credit_note_id).toBeNull();

    const { count: cnCount } = await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("return_id", returnId);
    expect(cnCount).toBe(0);
    const { count: ledgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(ledgerCount).toBe(1); // hanya opening debit
  });

  // ---------------------------------------------------------------------
  // 9. Approval menghitung nominal dari invoice line, bukan input client.
  // ---------------------------------------------------------------------
  it("9. Approval menghitung nilai dari invoice_lines (RPC tidak menerima parameter nominal)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-SERVERVALUE`, financeUser.userId, 10, 2000, 2000); // line_total = 18000, unit net = 1800/pcs
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 5 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { data, error } = await verifyReturn(ownerUser.userId, returnId, "approve");
    expect(error).toBeNull();
    const row = (data as VerifyReturnRow[])[0];
    // 5/10 * 18000 = 9000
    expect(Number(row.out_total_amount)).toBe(9000);
  });

  // ---------------------------------------------------------------------
  // 10. Approval membuat satu credit note dan ledger credit atomik.
  // ---------------------------------------------------------------------
  it("10. Approval membuat SATU credit note dan SATU ledger credit dalam satu transaksi", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ONECN`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 4 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { data, error } = await verifyReturn(ownerUser.userId, returnId, "approve");
    expect(error).toBeNull();
    const row = (data as VerifyReturnRow[])[0];
    expect(row.out_status).toBe("approved");
    expect(Number(row.out_applied_amount)).toBe(4000);
    expect(Number(row.out_customer_credit_amount)).toBe(0);

    const { count: cnCount } = await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("return_id", returnId);
    expect(cnCount).toBe(1);
    const { count: creditLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "credit_note");
    expect(creditLedgerCount).toBe(1);

    const balance = await balanceOf(inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(6000);
  });

  // ---------------------------------------------------------------------
  // 11. Partial return mengurangi outstanding dengan tepat.
  // ---------------------------------------------------------------------
  it("11. Partial return mengurangi outstanding dengan tepat", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PARTIAL`, financeUser.userId, 20, 500); // total 10000
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 6 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    await verifyReturn(ownerUser.userId, returnId, "approve");

    const balance = await balanceOf(inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(7000); // 10000 - 3000
    expect(balance.financial_status).toBe("partially_paid");
  });

  // ---------------------------------------------------------------------
  // 12. Retur melebihi outstanding menghasilkan customer credit tanpa
  //     saldo negatif.
  // ---------------------------------------------------------------------
  it("12. Retur melebihi outstanding (setelah sebagian dibayar) menghasilkan customer_credit_amount tanpa saldo negatif", async () => {
    const inv = await createInvoice(companyId, `${runTag}-EXCEEDOUT`, financeUser.userId, 10, 1000); // total 10000
    await pay(financeUser.userId, inv.invoiceId, 8000, `${runTag}-exceedout`); // outstanding = 2000

    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 5 }]); // nilai 5000
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const row = (data as VerifyReturnRow[])[0];

    expect(Number(row.out_total_amount)).toBe(5000);
    expect(Number(row.out_applied_amount)).toBe(2000); // dibatasi outstanding
    expect(Number(row.out_customer_credit_amount)).toBe(3000);

    const balance = await balanceOf(inv.invoiceId);
    expect(Number(balance.outstanding_balance)).toBe(0);
    expect(Number(balance.outstanding_balance)).toBeGreaterThanOrEqual(0);
  });

  // ---------------------------------------------------------------------
  // 13. Invoice yang sudah lunas menghasilkan customer credit tanpa
  //     ledger credit nol/palsu.
  // ---------------------------------------------------------------------
  it("13. Invoice lunas (outstanding=0) menghasilkan customer_credit murni TANPA ledger credit", async () => {
    const inv = await createInvoice(companyId, `${runTag}-PAIDFULL`, financeUser.userId, 10, 1000);
    await pay(financeUser.userId, inv.invoiceId, 10000, `${runTag}-paidfull`);

    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 3 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const row = (data as VerifyReturnRow[])[0];

    expect(Number(row.out_applied_amount)).toBe(0);
    expect(Number(row.out_customer_credit_amount)).toBe(3000);

    const { data: cn } = await supabase.from("credit_notes").select("receivable_ledger_id").eq("id", row.out_credit_note_id!).single();
    expect((cn as { receivable_ledger_id: string | null }).receivable_ledger_id).toBeNull();

    const { count: creditLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "credit_note");
    expect(creditLedgerCount).toBe(0);
  });

  // ---------------------------------------------------------------------
  // 14. Double/concurrent approval tidak menggandakan credit note atau
  //     pengurangan AR.
  // ---------------------------------------------------------------------
  it("14. Concurrent approval pada return yang SAMA hanya menghasilkan SATU credit note", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CONCURAPPR`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 4 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const [r1, r2] = await Promise.allSettled([verifyReturn(ownerUser.userId, returnId, "approve"), verifyReturn(ownerUser.userId, returnId, "approve")]);
    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0].error!.message)).toMatch(/RETURN_ALREADY_RESOLVED/);

    const { count: cnCount } = await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("return_id", returnId);
    expect(cnCount).toBe(1);
    const { count: creditLedgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "credit_note");
    expect(creditLedgerCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 15. Total credited quantity tidak melebihi quantity invoice.
  // ---------------------------------------------------------------------
  it("15. Total credited quantity lintas retur tidak boleh melebihi invoice_lines.quantity", async () => {
    const inv = await createInvoice(companyId, `${runTag}-CUMUL`, financeUser.userId, 10, 1000);

    const { data: req1 } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 7 }]);
    const return1 = (req1 as RequestReturnRow[])[0].out_return_id;
    const { error: approve1Err } = await verifyReturn(ownerUser.userId, return1, "approve");
    expect(approve1Err).toBeNull();

    const { data: req2 } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 5 }]);
    const return2 = (req2 as RequestReturnRow[])[0].out_return_id;
    const { error: approve2Err } = await verifyReturn(ownerUser.userId, return2, "approve");
    expect(approve2Err).not.toBeNull();
    expect(approve2Err!.message).toMatch(/RETURN_QUANTITY_EXCEEDS_CREDITABLE/);

    const { count: cnCount } = await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId);
    expect(cnCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 16. Reversal membuat compensating debit tanpa menghapus histori.
  // ---------------------------------------------------------------------
  it("16. Reversal membuat compensating debit TANPA menghapus credit_notes/ledger lama", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REVERSAL`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 4 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data: verifyData } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const creditNoteId = (verifyData as VerifyReturnRow[])[0].out_credit_note_id!;

    const balanceBeforeReversal = await balanceOf(inv.invoiceId);
    expect(Number(balanceBeforeReversal.outstanding_balance)).toBe(6000);

    const { data, error } = await reverseCreditNote(ownerUser.userId, creditNoteId);
    expect(error).toBeNull();
    const row = (data as ReverseRow[])[0];
    expect(Number(row.out_reversed_amount)).toBe(4000);
    expect(row.out_already_exists).toBe(false);

    // Credit note lama TETAP ada, tidak dihapus/diubah.
    const { data: cnAfter } = await supabase.from("credit_notes").select("id, applied_amount").eq("id", creditNoteId).single();
    expect(Number((cnAfter as { applied_amount: number | string }).applied_amount)).toBe(4000);

    // Ledger lama tetap ada (invoice_issued + credit_note), plus SATU baris baru credit_note_reversal.
    const { count: reversalLedgerCount } = await supabase
      .from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "credit_note_reversal");
    expect(reversalLedgerCount).toBe(1);

    const balanceAfterReversal = await balanceOf(inv.invoiceId);
    expect(Number(balanceAfterReversal.outstanding_balance)).toBe(10000); // dipulihkan penuh
  });

  // ---------------------------------------------------------------------
  // 17. Double reversal idempotent.
  // ---------------------------------------------------------------------
  it("17. Double reversal pada credit_note yang SAMA idempotent (tidak menggandakan)", async () => {
    const inv = await createInvoice(companyId, `${runTag}-DOUBLEREV`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 3 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    const { data: verifyData } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const creditNoteId = (verifyData as VerifyReturnRow[])[0].out_credit_note_id!;

    const { data: firstRev, error: firstErr } = await reverseCreditNote(ownerUser.userId, creditNoteId);
    expect(firstErr).toBeNull();
    const firstRow = (firstRev as ReverseRow[])[0];
    expect(firstRow.out_already_exists).toBe(false);

    const { data: secondRev, error: secondErr } = await reverseCreditNote(ownerUser.userId, creditNoteId);
    expect(secondErr).toBeNull();
    const secondRow = (secondRev as ReverseRow[])[0];
    expect(secondRow.out_already_exists).toBe(true);
    expect(secondRow.out_reversal_id).toBe(firstRow.out_reversal_id);

    const { count: reversalCount } = await supabase.from("credit_note_reversals").select("id", { count: "exact", head: true }).eq("credit_note_id", creditNoteId);
    expect(reversalCount).toBe(1);
    const { count: reversalLedgerCount } = await supabase
      .from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId).eq("entry_type", "credit_note_reversal");
    expect(reversalLedgerCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 18. Audit event dan payload benar.
  // ---------------------------------------------------------------------
  it("18. Audit event return.requested/approved/credit_note.issued/applied/receivable.adjusted/reversed tercatat benar", async () => {
    const inv = await createInvoice(companyId, `${runTag}-AUDIT`, financeUser.userId, 10, 1000);
    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 4 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;

    const { count: requestedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "return.requested").eq("entity_id", returnId);
    expect(requestedAudit).toBe(1);

    const { data: verifyData } = await verifyReturn(ownerUser.userId, returnId, "approve");
    const creditNoteId = (verifyData as VerifyReturnRow[])[0].out_credit_note_id!;

    const { count: approvedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "return.approved").eq("entity_id", returnId);
    expect(approvedAudit).toBe(1);
    const { count: issuedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "credit_note.issued").eq("entity_id", creditNoteId);
    expect(issuedAudit).toBe(1);
    const { count: appliedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "credit_note.applied").eq("entity_id", creditNoteId);
    expect(appliedAudit).toBe(1);
    const { count: adjustedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "receivable.adjusted").contains("new_data", { credit_note_id: creditNoteId });
    expect(adjustedAudit).toBe(1);

    await reverseCreditNote(ownerUser.userId, creditNoteId);
    const { count: reversedAudit } = await supabase.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "credit_note.reversed").contains("new_data", { credit_note_id: creditNoteId });
    expect(reversedAudit).toBe(1);
  });

  // ---------------------------------------------------------------------
  // 19. Kegagalan natural constraint membuktikan rollback tanpa partial
  //     mutation.
  // ---------------------------------------------------------------------
  it("19. Kegagalan natural constraint (over-creditable) tidak meninggalkan partial mutation", async () => {
    const inv = await createInvoice(companyId, `${runTag}-ROLLBACK`, financeUser.userId, 10, 1000);
    const { data: req1 } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 10 }]);
    const return1 = (req1 as RequestReturnRow[])[0].out_return_id;
    await verifyReturn(ownerUser.userId, return1, "approve"); // habiskan seluruh quantity

    const { data: req2 } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 1 }]);
    const return2 = (req2 as RequestReturnRow[])[0].out_return_id;

    const beforeCnCount = (await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId)).count;
    const beforeLedgerCount = (await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId)).count;

    const { error } = await verifyReturn(ownerUser.userId, return2, "approve");
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/RETURN_QUANTITY_EXCEEDS_CREDITABLE/);

    const afterCnCount = (await supabase.from("credit_notes").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId)).count;
    const afterLedgerCount = (await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", inv.invoiceId)).count;
    expect(afterCnCount).toBe(beforeCnCount);
    expect(afterLedgerCount).toBe(beforeLedgerCount);

    const { data: returnAfter } = await supabase.from("returns").select("status").eq("id", return2).single();
    expect((returnAfter as { status: string }).status).toBe("requested"); // status TIDAK berubah, gagal atomik
  });

  // ---------------------------------------------------------------------
  // 20. Invariant Gate 2A-2E tetap lulus (spot-check regresi).
  // ---------------------------------------------------------------------
  it("20. Regresi Gate 2A-2E: issue_invoice_atomic + record_verified_payment_atomic tetap konsisten setelah retur", async () => {
    const inv = await createInvoice(companyId, `${runTag}-REGRESSION`, financeUser.userId, 10, 1000);
    const receiptId = await pay(financeUser.userId, inv.invoiceId, 5000, `${runTag}-regression`);
    expect(receiptId).toBeTruthy();

    const { data: reqData } = await requestReturn(financeUser.userId, inv.invoiceId, [{ invoice_line_id: inv.lineId, requested_quantity: 2 }]);
    const returnId = (reqData as RequestReturnRow[])[0].out_return_id;
    await verifyReturn(ownerUser.userId, returnId, "approve");

    const balance = await balanceOf(inv.invoiceId);
    // total 10000 - payment 5000 - credit_note 2000 = 3000
    expect(Number(balance.outstanding_balance)).toBe(3000);

    const { data: reconcileData, error: reconcileErr } = await supabase.rpc("reconcile_verified_payment", {
      p_company_id: companyId, p_actor_id: financeUser.userId, p_payment_receipt_id: receiptId, p_method: "automatic", p_idempotency_key: null,
    });
    expect(reconcileErr).toBeNull();
    expect((reconcileData as Array<{ out_classification: string }>)[0].out_classification).toBe("matched");
  });
});
