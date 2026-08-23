// =============================================================================
// Gate P4.16 -- Lock Toko Tertunggak, DB-backed (Postgres/Supabase NYATA).
// Membuktikan migration 20261016000001 (skema store_unlock_requests +
// is_customer_order_locked), 20261017000001 (submit/decide RPC), dan
// 20261018000001 (guard customer_locked_overdue di create_sales_order_atomic/
// confirm_sales_order_atomic/create_draft_sales_order_atomic) terhadap
// kontrak rencana Fase 2 (~/.claude/plans/linear-strolling-teacup.md):
//   1. Toko overdue >= H+3 -> order baru ditolak customer_locked_overdue.
//   2. Sales ajukan buka-lock -> Owner approve.
//   3. Order berikutnya berhasil, exception ter-konsumsi.
//   4. Order KEDUA tanpa approval baru -> ditolak lagi (re-lock otomatis).
//   5. Toko yang TIDAK locked mengajukan buka-lock -> outcome not_locked.
//
// submit_store_unlock_request_atomic/decide_store_unlock_request_atomic HANYA
// GRANT ke `authenticated` dan resolve identitas dari auth.uid() (pola
// identik gate-3e-d4-c2/c3) -- dipanggil lewat sesi Supabase Auth SUNGGUHAN.
// create_sales_order_atomic/confirm_sales_order_atomic/create_draft_sales_
// order_atomic menerima p_actor_id/p_company_id trusted -- dipanggil lewat
// client service-role langsung, pola identik actions.integration.test.ts.
//
// Fixture invoice overdue dibangun dengan INSERT LANGSUNG ke issued_documents/
// invoices/receivable_ledger (bukan lewat issue_invoice_atomic) -- RPC itu
// SELALU menghitung due_date = business_date + payment_terms_days (positif,
// CHECK constraint), jadi tidak pernah bisa menghasilkan invoice yang SUDAH
// overdue pada hari yang sama test dijalankan. invoices/issued_documents/
// receivable_ledger immutable (tidak ada UPDATE/DELETE) tapi TIDAK ada
// trigger yang memaksa jalur INSERT lewat RPC tertentu -- pola fixture
// langsung-ke-tabel ini konsisten dengan makeOrder() di gate-3e-d4-c2 (bypass
// create_sales_order_atomic untuk data uji, RPC hanya dipanggil untuk
// perilaku yang benar-benar diuji).
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
  console.warn("Gate P4.16 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

type SubmitRow = { result_outcome: string; request_id: string | null; customer_id: string | null };
type DecideRow = { result_outcome: string; request_id: string | null; decision: string | null; customer_id: string | null; decided_at: string | null };
type CreateOrderRow = { result_outcome: string; result_order_id: string | null };
type ConfirmOrderRow = { result_outcome: string; already_confirmed: boolean | null };
type CreateDraftRow = { result_outcome: string; result_order_id: string | null };

describeIfDb("Gate P4.16: Lock Toko Tertunggak (DB-backed, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-p416-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = randomUUID();

  const companyId = randomUUID();
  const authIds: Record<string, string> = {};
  const emails: Record<string, string> = {};
  let productId: string;
  let seq = 0;

  const createdCustomerIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdDocIds: string[] = [];
  const createdInvoiceIds: string[] = [];

  async function signIn(key: string): Promise<SupabaseClient> {
    const scoped = createServiceClient(env!.url, env!.anonKey);
    const { error } = await scoped.auth.signInWithPassword({ email: emails[key], password });
    if (error) throw new Error(`sign-in gagal untuk ${key}: ${error.message}`);
    return scoped;
  }

  async function makeUser(key: string, roleName: string): Promise<string> {
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

  async function makeCustomer(): Promise<string> {
    seq += 1;
    const { data, error } = await service.from("customers").insert({ company_id: companyId, name: `Toko ${runTag}-${seq}`, code: `CUST-P416-${runTag}-${seq}` }).select("id").single();
    if (error) throw new Error(`gagal buat customer: ${error.message}`);
    const id = (data as { id: string }).id;
    createdCustomerIds.push(id);
    return id;
  }

  /**
   * Fixture invoice overdue -- lihat catatan header file. daysOverdue=3
   * artinya due_date = CURRENT_DATE - 3 (tepat di ambang H+3, HARUS locked).
   */
  async function makeOverdueInvoice(customerId: string, daysOverdue: number, totalAmount = 100_000): Promise<string> {
    seq += 1;
    const { data: order, error: orderErr } = await service.from("sales_orders").insert({
      company_id: companyId, order_number: `SO-P416-${runTag}-${seq}`, customer_id: customerId, sales_id: authIds.sales,
      status: "delivered", total_amount: totalAmount, final_amount: totalAmount,
    }).select("id").single();
    if (orderErr) throw new Error(`gagal buat order fixture invoice: ${orderErr.message}`);
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    const { data: delivery, error: delErr } = await service.from("deliveries").insert({
      company_id: companyId, sales_order_id: orderId, attempt_number: 1, status: "verified",
    }).select("id").single();
    if (delErr) throw new Error(`gagal buat delivery fixture invoice: ${delErr.message}`);
    const deliveryId = (delivery as { id: string }).id;
    createdDeliveryIds.push(deliveryId);

    const issuedAt = new Date(Date.now() - (daysOverdue + 10) * 86_400_000).toISOString();
    const dueDate = new Date(Date.now() - daysOverdue * 86_400_000).toISOString().slice(0, 10);
    const docNumber = `INV-P416-${runTag}-${seq}`;
    const snapshot = { totals: { subtotal: totalAmount, totalDiscount: 0, grandTotal: totalAmount } };

    const { data: doc, error: docErr } = await service.from("issued_documents").insert({
      company_id: companyId, document_type: "INVOICE", source_order_id: orderId, source_delivery_id: deliveryId,
      document_number: docNumber, version: 1, snapshot, status: "active", issued_at: issuedAt,
    }).select("id").single();
    if (docErr) throw new Error(`gagal buat issued_documents fixture invoice: ${docErr.message}`);
    const docId = (doc as { id: string }).id;
    createdDocIds.push(docId);

    const { data: invoice, error: invErr } = await service.from("invoices").insert({
      company_id: companyId, issued_document_id: docId, invoice_number: docNumber, sales_order_id: orderId,
      delivery_id: deliveryId, customer_id: customerId, issued_at: issuedAt, due_date: dueDate,
      subtotal_amount: totalAmount, discount_amount: 0, total_amount: totalAmount,
    }).select("id").single();
    if (invErr) throw new Error(`gagal buat invoices fixture: ${invErr.message}`);
    const invoiceId = (invoice as { id: string }).id;
    createdInvoiceIds.push(invoiceId);

    const { error: ledgerErr } = await service.from("receivable_ledger").insert({
      company_id: companyId, invoice_id: invoiceId, entry_type: "invoice_issued", direction: "debit", amount: totalAmount,
    });
    if (ledgerErr) throw new Error(`gagal buat receivable_ledger fixture: ${ledgerErr.message}`);

    return invoiceId;
  }

  beforeAll(async () => {
    if (!env) return;
    service = createServiceClient(env.url, env.serviceRoleKey);

    const { error: companyErr } = await service.from("companies").insert({ id: companyId, name: `Itest P4.16 ${runTag}`, slug: `itest-p416-${runTag}` });
    if (companyErr) throw new Error(`gagal buat company: ${companyErr.message}`);

    await makeUser("sales", "sales");
    await makeUser("sales2", "sales");
    await makeUser("owner", "owner");
    await makeUser("admin", "admin");

    const { data: product, error: productErr } = await service.from("products").insert({
      company_id: companyId, sku: `SKU-P416-${runTag}`, name: `Produk P4.16 ${runTag}`, price: 10_000, is_active: true,
    }).select("id").single();
    if (productErr) throw new Error(`gagal buat produk: ${productErr.message}`);
    productId = (product as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    if (!env) return;
    // Best-effort -- invoices/issued_documents/receivable_ledger immutable
    // (tidak ada UPDATE/DELETE, lihat trg_*_immutable) sehingga delete di
    // bawah untuk ketiganya diperkirakan gagal senyap (error diabaikan,
    // konsisten pola cleanup gate-3e-d4-c2/collection-promise-foundation).
    await service.from("store_unlock_requests").delete().eq("company_id", companyId);
    await service.from("receivable_ledger").delete().in("company_id", [companyId]);
    await service.from("invoices").delete().in("company_id", [companyId]);
    await service.from("issued_documents").delete().in("company_id", [companyId]);
    await service.from("sales_order_items").delete().in("order_id", createdOrderIds);
    await service.from("deliveries").delete().in("id", createdDeliveryIds);
    await service.from("sales_orders").delete().in("id", createdOrderIds);
    await service.from("products").delete().eq("company_id", companyId);
    await service.from("customers").delete().in("id", createdCustomerIds);
    await service.from("user_roles").delete().in("user_id", Object.values(authIds));
    await service.from("users").delete().in("id", Object.values(authIds));
    for (const id of Object.values(authIds)) {
      await service.auth.admin.deleteUser(id);
    }
    await service.from("companies").delete().eq("id", companyId);
  }, 60_000);

  it("1. toko dengan invoice overdue H+3 -> create_sales_order_atomic ditolak customer_locked_overdue", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);

    const { data: lockedData } = await service.rpc("is_customer_order_locked", { p_company_id: companyId, p_customer_id: customerId });
    expect(lockedData).toBe(true);

    const { data, error } = await service.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales, p_order_number: `SO-P416-BLOCK-${runTag}`,
      p_customer_id: customerId, p_sales_id: authIds.sales, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10_000, discount_amount: 0, total_amount: 10_000, notes: null }],
    });
    expect(error).toBeNull();
    const row = ((data ?? []) as CreateOrderRow[])[0];
    expect(row.result_outcome).toBe("customer_locked_overdue");
    expect(row.result_order_id).toBeNull();
  });

  it("2. toko dengan invoice overdue H+2 (belum H+3) -> TIDAK locked", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 2);

    const { data: lockedData } = await service.rpc("is_customer_order_locked", { p_company_id: companyId, p_customer_id: customerId });
    expect(lockedData).toBe(false);
  });

  it("5. toko yang TIDAK locked mengajukan buka-lock -> outcome not_locked", async () => {
    const customerId = await makeCustomer();
    const salesClient = await signIn("sales");

    const { data, error } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "coba ajukan padahal tidak terkunci", p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    const row = ((data ?? []) as SubmitRow[])[0];
    expect(row.result_outcome).toBe("not_locked");
  });

  it("bukan role sales tidak bisa mengajukan (forbidden)", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);
    const ownerClient = await signIn("owner");

    const { data, error } = await ownerClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "owner coba ajukan", p_idempotency_key: randomUUID(),
    });
    expect(error).toBeNull();
    const row = ((data ?? []) as SubmitRow[])[0];
    expect(row.result_outcome).toBe("forbidden");
  });

  it("bukan role owner tidak bisa memutuskan (forbidden)", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);
    const salesClient = await signIn("sales");
    const { data: submitData } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "alasan uji forbidden decide", p_idempotency_key: randomUUID(),
    });
    const requestId = ((submitData ?? []) as SubmitRow[])[0].request_id;

    const salesDecideClient = await signIn("sales");
    const { data, error } = await salesDecideClient.rpc("decide_store_unlock_request_atomic", {
      p_request_id: requestId, p_decision: "APPROVE", p_idempotency_key: randomUUID(), p_decision_reason: null,
    });
    expect(error).toBeNull();
    const row = ((data ?? []) as DecideRow[])[0];
    expect(row.result_outcome).toBe("forbidden");
  });

  it("2-4. alur penuh: ajukan -> approve -> order berikutnya berhasil (exception konsumsi) -> order kedua ditolak lagi (re-lock)", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 5);

    // Step 2: sales ajukan.
    const salesClient = await signIn("sales");
    const { data: submitData, error: submitErr } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "sudah janji bayar minggu ini", p_idempotency_key: randomUUID(),
    });
    expect(submitErr).toBeNull();
    const submitRow = ((submitData ?? []) as SubmitRow[])[0];
    expect(submitRow.result_outcome).toBe("submitted");
    const requestId = submitRow.request_id!;

    // Owner approve.
    const ownerClient = await signIn("owner");
    const { data: decideData, error: decideErr } = await ownerClient.rpc("decide_store_unlock_request_atomic", {
      p_request_id: requestId, p_decision: "APPROVE", p_idempotency_key: randomUUID(), p_decision_reason: null,
    });
    expect(decideErr).toBeNull();
    const decideRow = ((decideData ?? []) as DecideRow[])[0];
    expect(decideRow.result_outcome).toBe("approved");

    // is_customer_order_locked sekarang FALSE (exception tersedia, unconsumed).
    const { data: lockedAfterApprove } = await service.rpc("is_customer_order_locked", { p_company_id: companyId, p_customer_id: customerId });
    expect(lockedAfterApprove).toBe(false);

    // Step 3: order pertama BERHASIL dibuat (exception dikonsumsi di create).
    const { data: createData, error: createErr } = await service.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales, p_order_number: `SO-P416-UNLOCK1-${runTag}`,
      p_customer_id: customerId, p_sales_id: authIds.sales, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10_000, discount_amount: 0, total_amount: 10_000, notes: null }],
    });
    expect(createErr).toBeNull();
    const createRow = ((createData ?? []) as CreateOrderRow[])[0];
    expect(createRow.result_outcome).toBe("created");
    const firstOrderId = createRow.result_order_id!;
    createdOrderIds.push(firstOrderId);

    const { data: consumedRow } = await service.from("store_unlock_requests").select("consumed_at, consumed_by_order_id").eq("id", requestId).single();
    expect((consumedRow as { consumed_by_order_id: string }).consumed_by_order_id).toBe(firstOrderId);
    expect((consumedRow as { consumed_at: string | null }).consumed_at).not.toBeNull();

    // Confirm order pertama BERHASIL walau toko masih overdue -- guard
    // confirm melewati pemeriksaan locked karena order ini sudah tercatat
    // sebagai consumed_by_order_id (lihat header migration 20261018000001).
    const { data: confirmData, error: confirmErr } = await service.rpc("confirm_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.owner, p_order_id: firstOrderId, p_payment_terms_days: null,
    });
    expect(confirmErr).toBeNull();
    const confirmRow = ((confirmData ?? []) as ConfirmOrderRow[])[0];
    expect(confirmRow.result_outcome).toBe("confirmed");

    // Step 4: toko masih overdue (invoice yang sama, belum dibayar) DAN
    // exception sudah terpakai -> order KEDUA ditolak lagi (re-lock otomatis,
    // TANPA mekanisme cron/reversal apa pun -- murni live computation).
    const { data: lockedAfterConsume } = await service.rpc("is_customer_order_locked", { p_company_id: companyId, p_customer_id: customerId });
    expect(lockedAfterConsume).toBe(true);

    const { data: secondCreateData, error: secondCreateErr } = await service.rpc("create_sales_order_atomic", {
      p_company_id: companyId, p_actor_id: authIds.sales, p_order_number: `SO-P416-UNLOCK2-${runTag}`,
      p_customer_id: customerId, p_sales_id: authIds.sales, p_notes: null, p_delivery_date: null,
      p_discount_amount: 0, p_items: [{ product_id: productId, quantity: 1, unit_price: 10_000, discount_amount: 0, total_amount: 10_000, notes: null }],
    });
    expect(secondCreateErr).toBeNull();
    const secondCreateRow = ((secondCreateData ?? []) as CreateOrderRow[])[0];
    expect(secondCreateRow.result_outcome).toBe("customer_locked_overdue");
  });

  it("REJECT: toko tetap terkunci, order baru tetap ditolak", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 4);

    const salesClient = await signIn("sales2");
    const { data: submitData } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "coba ajukan, akan ditolak Owner", p_idempotency_key: randomUUID(),
    });
    const requestId = ((submitData ?? []) as SubmitRow[])[0].request_id!;

    const ownerClient = await signIn("owner");
    const { data: decideData, error: decideErr } = await ownerClient.rpc("decide_store_unlock_request_atomic", {
      p_request_id: requestId, p_decision: "REJECT", p_idempotency_key: randomUUID(), p_decision_reason: "belum ada bukti transfer",
    });
    expect(decideErr).toBeNull();
    expect(((decideData ?? []) as DecideRow[])[0].result_outcome).toBe("rejected");

    const { data: lockedAfterReject } = await service.rpc("is_customer_order_locked", { p_company_id: companyId, p_customer_id: customerId });
    expect(lockedAfterReject).toBe(true);
  });

  it("REJECT tanpa alasan -> reason_required", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 4);
    const salesClient = await signIn("sales");
    const { data: submitData } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "alasan pengajuan", p_idempotency_key: randomUUID(),
    });
    const requestId = ((submitData ?? []) as SubmitRow[])[0].request_id!;

    const ownerClient = await signIn("owner");
    const { data, error } = await ownerClient.rpc("decide_store_unlock_request_atomic", {
      p_request_id: requestId, p_decision: "REJECT", p_idempotency_key: randomUUID(), p_decision_reason: null,
    });
    expect(error).toBeNull();
    expect(((data ?? []) as DecideRow[])[0].result_outcome).toBe("reason_required");
  });

  it("idempotency: retry submit dengan key+payload sama -> already_exists (bukan baris baru)", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);
    const salesClient = await signIn("sales");
    const key = randomUUID();

    const { data: first } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "idempotency check", p_idempotency_key: key,
    });
    const firstRow = ((first ?? []) as SubmitRow[])[0];
    expect(firstRow.result_outcome).toBe("submitted");

    const { data: second, error: secondErr } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "idempotency check", p_idempotency_key: key,
    });
    expect(secondErr).toBeNull();
    const secondRow = ((second ?? []) as SubmitRow[])[0];
    expect(secondRow.result_outcome).toBe("already_exists");
    expect(secondRow.request_id).toBe(firstRow.request_id);

    const { count } = await service.from("store_unlock_requests").select("id", { count: "exact", head: true }).eq("customer_id", customerId);
    expect(count).toBe(1);
  });

  it("idempotency: retry submit dengan key sama tapi payload beda -> idempotency_conflict", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);
    const salesClient = await signIn("sales");
    const key = randomUUID();

    await salesClient.rpc("submit_store_unlock_request_atomic", { p_customer_id: customerId, p_reason: "alasan A", p_idempotency_key: key });

    const { data, error } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "alasan BERBEDA", p_idempotency_key: key,
    });
    expect(error).toBeNull();
    expect(((data ?? []) as SubmitRow[])[0].result_outcome).toBe("idempotency_conflict");
  });

  it("hanya satu PENDING aktif per toko -- pengajuan kedua ditolak constraint (backstop unique partial index)", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);
    const salesClient = await signIn("sales");

    const { data: first } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "pengajuan pertama", p_idempotency_key: randomUUID(),
    });
    expect(((first ?? []) as SubmitRow[])[0].result_outcome).toBe("submitted");

    const { error } = await salesClient.rpc("submit_store_unlock_request_atomic", {
      p_customer_id: customerId, p_reason: "pengajuan kedua, key beda", p_idempotency_key: randomUUID(),
    });
    // Unique partial index uq_sur_one_pending_per_customer -- request kedua
    // dengan idempotency_key BEDA (bukan retry) menabrak constraint mentah,
    // pola sama uq_spar_one_pending_per_order (special price, tidak di-catch
    // secara graceful di RPC submit, lihat header migration 20261017000001).
    expect(error).not.toBeNull();
  });

  it("create_draft_sales_order_atomic (jalur Telegram) -- toko locked ditolak customer_locked_overdue, TIDAK ada order tersimpan", async () => {
    const customerId = await makeCustomer();
    await makeOverdueInvoice(customerId, 3);

    const { data, error } = await service.rpc("create_draft_sales_order_atomic", {
      p_company_id: companyId, p_sales_id: authIds.sales, p_order_number: `SO-P416-TG-${runTag}`,
      p_customer_id: customerId, p_customer_name_raw: null, p_order_source: "telegram_text",
      p_knowledge_version: "v1", p_extraction_confidence: 1, p_missing_fields: [],
      p_requires_discount_review: false, p_delivery_note: null, p_telegram_event_id: randomUUID(),
      p_total_amount: 10_000, p_discount_amount: 0, p_final_amount: 10_000,
      p_items: [{ product_id: productId, product_name_raw: null, quantity: 1, unit: "pcs", unit_price: 10_000, discount_type: null, discount_value: null, amount_before_discount: 10_000, discount_amount: 0, discount_exception: false, total_amount: 10_000 }],
    });
    expect(error).toBeNull();
    const row = ((data ?? []) as CreateDraftRow[])[0];
    expect(row.result_outcome).toBe("customer_locked_overdue");
    expect(row.result_order_id).toBeNull();

    const { count } = await service.from("sales_orders").select("id", { count: "exact", head: true }).eq("customer_id", customerId).eq("source_channel", "telegram");
    expect(count).toBe(0);
  });
});
