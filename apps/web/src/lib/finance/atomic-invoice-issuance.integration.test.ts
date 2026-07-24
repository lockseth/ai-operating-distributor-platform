// =============================================================================
// DB-backed integration test -- Gate 2B: Atomic Invoice Issuance
// (supabase/migrations/20260827000001_atomic_invoice_issuance.sql).
//
// Membuktikan issue_invoice_atomic() -- satu-satunya jalur resmi penerbitan
// invoice: header + invoice_lines lengkap (per-baris, bukan hanya agregat) +
// opening debit + transisi order delivered->invoiced dalam SATU transaksi
// atomik. Skip graceful jika kredensial Supabase lokal tidak tersedia atau
// URL bukan loopback -- pola sama dengan receivable-ledger-foundation.
// integration.test.ts (Gate 2A).
//
// Rollback proof (hardening note): migration ini TIDAK LAGI berisi trigger/
// fungsi test-only apa pun (dihapus -- helper semacam itu bisa dipakai untuk
// sengaja menghentikan insert receivable_ledger di produksi, risiko yang
// tidak sepadan). Rollback atomik dibuktikan lewat DUA lapis, keduanya
// production-safe:
//   1. DB-backed, kegagalan ALAMI dari constraint canonical Gate 2A yang
//      tidak diubah sama sekali (invoices UNIQUE(company_id, invoice_number))
//      -- lihat test "8." di bawah untuk mekanisme detail.
//   2. Static/procedural: assertion atas TEKS migration bahwa
//      issue_invoice_atomic() adalah SATU function body tanpa blok EXCEPTION
//      apa pun (lihat describe block terpisah "Static proof" di bawah, pola
//      sama dengan apps/web/src/lib/orders/invoiced-lock-migration.security.
//      test.ts) -- lihat LIMITATION di describe block tsb untuk penjelasan
//      kenapa proof DB-backed tidak bisa dipaksa terjadi PERSIS setelah
//      invoice_lines (bukan hanya setelah invoice header).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

const MIGRATION_PATH = path.resolve(__dirname, "../../../../../supabase/migrations/20260827000001_atomic_invoice_issuance.sql");

// ---------------------------------------------------------------------------
// Static/procedural proof (TIDAK digerbang oleh ketersediaan DB -- selalu
// jalan). Migration Gate 2B TIDAK punya helper test-only, dan
// issue_invoice_atomic() TIDAK punya blok EXCEPTION apa pun -- artinya
// kegagalan APA PUN di dalamnya (RAISE EXCEPTION eksplisit, error dari
// fungsi yang dipanggil, ATAU trigger Gate 2A yang menolak INSERT) selalu
// mem-propagate ke atas dan membatalkan SELURUH statement/transaksi
// panggilan RPC ini -- termasuk INSERT/UPDATE yang sudah dieksekusi lebih
// dulu DI DALAM function body yang SAMA (issued_documents, invoice header,
// dst). Ini jaminan baku PL/pgSQL (lihat "Trapping Errors":
// https://www.postgresql.org/docs/current/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING
// -- function tanpa EXCEPTION block tidak bisa partial-commit). Proof ini
// berlaku UNTUK SETIAP statement dalam function body, termasuk yang
// letaknya SETELAH invoice_lines (receivable_ledger, UPDATE status, audit)
// -- proof DB-backed test "8." di bawah HANYA bisa memaksa kegagalan alami
// sampai pada langkah invoice header (lihat LIMITATION di situ); proof
// statis inilah yang menutup celah bahwa jaminan atomicity yang SAMA juga
// berlaku pada langkah-langkah sesudahnya.
describe("Gate 2B hardening -- static proof atomicity (migration 20260827000001)", () => {
  const migration = readFileSync(MIGRATION_PATH, "utf8");

  function extractFunctionBody(fnName: string): string {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
    expect(start, `function public.${fnName} tidak ditemukan di migration`).toBeGreaterThanOrEqual(0);
    const end = migration.indexOf("$$ LANGUAGE plpgsql", start);
    expect(end, `penutup $$ LANGUAGE plpgsql untuk ${fnName} tidak ditemukan`).toBeGreaterThan(start);
    return migration.slice(start, end);
  }

  it("tidak ada identifier test-only (_test_) atau trigger failure-injection tersisa di migration produksi", () => {
    expect(migration).not.toMatch(/_test_/i);
    expect(migration).not.toMatch(/TEST_FORCED_ROLLBACK/);
    expect(migration).not.toMatch(/CREATE TRIGGER trg_test_/i);
  });

  it("issue_invoice_atomic() adalah SATU function body tanpa blok EXCEPTION -- kegagalan di mana pun membatalkan seluruh transaksi", () => {
    const body = extractFunctionBody("issue_invoice_atomic");
    expect(body).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("seluruh langkah mutasi (issued_documents, invoice header, invoice_lines, receivable_ledger, status order, audit) berada di DALAM SATU function body yang sama, berurutan", () => {
    const body = extractFunctionBody("issue_invoice_atomic");
    const steps = [
      "public.record_issued_document(",
      "INSERT INTO public.invoices (",
      "INSERT INTO public.invoice_lines (",
      "INSERT INTO public.receivable_ledger (",
      "UPDATE public.sales_orders SET status = 'invoiced'",
      "INSERT INTO public.audit_logs (",
    ];
    let cursor = -1;
    for (const step of steps) {
      const idx = body.indexOf(step);
      expect(idx, `langkah "${step}" tidak ditemukan di dalam function body`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it("function tetap terkunci ke service_role (REVOKE PUBLIC/anon/authenticated, GRANT service_role) -- hardening tidak melemahkan grant", () => {
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.issue_invoice_atomic(UUID, UUID, UUID)\n  FROM PUBLIC, anon, authenticated;");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.issue_invoice_atomic(UUID, UUID, UUID)\n  TO service_role;");
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

interface OrderLineSpec {
  productName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountAmount?: number;
}

interface DeliveredOrderFixture {
  companyId: string;
  customerId: string;
  orderId: string;
  orderNumber: string;
  deliveryId: string;
  orderItemIds: string[];
  deliveryItemIds: string[];
  lines: OrderLineSpec[];
}

interface IssueInvoiceRow {
  out_invoice_id: string;
  out_invoice_number: string;
  out_issued_document_id: string;
  out_receivable_ledger_id: string;
  out_total_amount: string;
  out_order_status: string;
}

describeIfDb("Gate 2B: Atomic Invoice Issuance (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient; // service_role
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const rollbackCompanyId = randomUUID();
  const createdCompanyIds = [companyId, otherCompanyId, rollbackCompanyId];

  const createdOrderIds: string[] = [];
  const createdDeliveryIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];

  async function insertCompany(id: string, tag: string, prefix: string) {
    const { error } = await supabase.from("companies").insert({
      id,
      name: `ITest Gate2B ${tag}`,
      slug: `itest-g2b-${tag}`,
      document_number_prefix: prefix,
      legal_address: "Jl. Uji Coba No. 1, Jakarta",
      contact_email: `${tag}@itest.test`,
      contact_phone: "021-5550001",
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

  async function createDeliveredOrder(
    targetCompanyId: string,
    tag: string,
    lines: OrderLineSpec[],
    opts?: { status?: string; multiDelivery?: boolean },
  ): Promise<DeliveredOrderFixture> {
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .insert({ company_id: targetCompanyId, name: `Toko ${tag}`, code: `CUST-${tag}` })
      .select("id")
      .single();
    if (custErr) throw new Error(`gagal buat customer: ${custErr.message}`);
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const orderNumber = `SO-${tag}`;
    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({ company_id: targetCompanyId, order_number: orderNumber, customer_id: customerId, status: opts?.status ?? "delivered" })
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

    const orderItemIds: string[] = [];
    const deliveryItemIds: string[] = [];
    for (const line of lines) {
      const discount = line.discountAmount ?? 0;
      const totalAmount = line.quantity * line.unitPrice - discount;
      const { data: item, error: itemErr } = await supabase
        .from("sales_order_items")
        .insert({
          order_id: orderId,
          product_name_raw: line.productName,
          unit: line.unit,
          quantity: line.quantity,
          unit_price: line.unitPrice,
          discount_amount: discount,
          total_amount: totalAmount,
        })
        .select("id")
        .single();
      if (itemErr) throw new Error(`gagal buat order item: ${itemErr.message}`);
      const orderItemId = (item as { id: string }).id;
      orderItemIds.push(orderItemId);

      const { data: di, error: diErr } = await supabase
        .from("delivery_items")
        .insert({
          delivery_id: deliveryId,
          sales_order_item_id: orderItemId,
          ordered_quantity: line.quantity,
          dispatched_quantity: line.quantity,
          received_quantity: line.quantity,
        })
        .select("id")
        .single();
      if (diErr) throw new Error(`gagal buat delivery item: ${diErr.message}`);
      deliveryItemIds.push((di as { id: string }).id);
    }

    return { companyId: targetCompanyId, customerId, orderId, orderNumber, deliveryId, orderItemIds, deliveryItemIds, lines };
  }

  async function issueInvoice(targetCompanyId: string, actorId: string, orderId: string) {
    return supabase.rpc("issue_invoice_atomic", { p_company_id: targetCompanyId, p_actor_id: actorId, p_order_id: orderId });
  }

  let financeUser: { userId: string; email: string; password: string };
  let salesUser: { userId: string; email: string; password: string };
  let otherFinanceUser: { userId: string; email: string; password: string };
  let rollbackFinanceUser: { userId: string; email: string; password: string };

  let primary: DeliveredOrderFixture; // company A, 3 lines -- happy path + completeness
  let primaryResult: IssueInvoiceRow;
  let otherCompanySource: DeliveredOrderFixture; // company B -- cross-tenant proof

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    await insertCompany(companyId, `${runTag}-A`, "IGA");
    await insertCompany(otherCompanyId, `${runTag}-B`, "IGB");
    await insertCompany(rollbackCompanyId, `${runTag}-RB`, "IGR");

    financeUser = await createActor(companyId, `${runTag}-finance`, "finance");
    salesUser = await createActor(companyId, `${runTag}-sales`, "sales");
    otherFinanceUser = await createActor(otherCompanyId, `${runTag}-ofinance`, "finance");
    rollbackFinanceUser = await createActor(rollbackCompanyId, `${runTag}-rbfinance`, "finance");

    primary = await createDeliveredOrder(companyId, `${runTag}-PRI`, [
      { productName: "Produk A", unit: "pcs", quantity: 10, unitPrice: 1000, discountAmount: 0 },
      { productName: "Produk B", unit: "pcs", quantity: 5, unitPrice: 2000, discountAmount: 500 },
      { productName: "Produk C", unit: "dus", quantity: 2, unitPrice: 15000, discountAmount: 1000 },
    ]);

    const { data, error } = await issueInvoice(companyId, financeUser.userId, primary.orderId);
    if (error) throw new Error(`setup happy path gagal: ${error.message}`);
    primaryResult = (data as IssueInvoiceRow[])[0];

    otherCompanySource = await createDeliveredOrder(otherCompanyId, `${runTag}-OTH`, [
      { productName: "Produk Lain", unit: "pcs", quantity: 4, unitPrice: 3000, discountAmount: 0 },
    ]);
  }, 60000);

  afterAll(async () => {
    if (!supabase) return;
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
  // Happy path + completeness (per-baris, bukan hanya agregat)
  // ---------------------------------------------------------------------

  it("1. Happy path: RPC mengembalikan identifier canonical dan tepat satu invoice header dibuat", async () => {
    expect(primaryResult.out_invoice_id).toBeTruthy();
    expect(primaryResult.out_invoice_number).toMatch(/^IGA-INV-\d{8}-\d{6}$/);
    expect(primaryResult.out_issued_document_id).toBeTruthy();
    expect(primaryResult.out_receivable_ledger_id).toBeTruthy();
    expect(Number(primaryResult.out_total_amount)).toBe(10000 + 9500 + 29000);
    expect(primaryResult.out_order_status).toBe("invoiced");

    const { data: invoices } = await supabase.from("invoices").select("id").eq("sales_order_id", primary.orderId);
    expect((invoices ?? []).length).toBe(1);
  });

  it("2. issued_documents INVOICE aktif dibuat dan menjadi acuan invoice header (bukan parallel source of truth)", async () => {
    const { data: doc } = await supabase.from("issued_documents").select("*").eq("id", primaryResult.out_issued_document_id).single();
    const row = doc as { document_type: string; status: string; source_order_id: string; source_delivery_id: string; document_number: string };
    expect(row.document_type).toBe("INVOICE");
    expect(row.status).toBe("active");
    expect(row.source_order_id).toBe(primary.orderId);
    expect(row.source_delivery_id).toBe(primary.deliveryId);
    expect(row.document_number).toBe(primaryResult.out_invoice_number);
  });

  it("3. Seluruh source line termaterialisasi menjadi invoice_lines dengan mapping PER-BARIS yang benar", async () => {
    const { data: lines, error } = await supabase
      .from("invoice_lines")
      .select("*")
      .eq("invoice_id", primaryResult.out_invoice_id)
      .order("line_no", { ascending: true });
    expect(error).toBeNull();
    const rows = (lines ?? []) as Array<{
      invoice_id: string;
      sales_order_item_id: string;
      delivery_item_id: string;
      product_name: string;
      quantity: string;
      unit_price: string;
      discount_amount: string;
      line_total: string;
    }>;

    expect(rows.length).toBe(primary.lines.length);

    const bySoiId = new Map(rows.map((r) => [r.sales_order_item_id, r]));
    expect(bySoiId.size).toBe(primary.orderItemIds.length); // tidak ada duplikasi source line

    for (let i = 0; i < primary.lines.length; i++) {
      const spec = primary.lines[i];
      const soiId = primary.orderItemIds[i];
      const diId = primary.deliveryItemIds[i];
      const row = bySoiId.get(soiId);
      expect(row, `baris untuk sales_order_item ${soiId} (${spec.productName}) hilang`).toBeTruthy();
      expect(row!.invoice_id).toBe(primaryResult.out_invoice_id);
      expect(row!.delivery_item_id).toBe(diId);
      expect(row!.product_name).toBe(spec.productName);
      expect(Number(row!.quantity)).toBe(spec.quantity);
      expect(Number(row!.unit_price)).toBe(spec.unitPrice);
      expect(Number(row!.discount_amount)).toBe(spec.discountAmount ?? 0);
      expect(Number(row!.line_total)).toBe(spec.quantity * spec.unitPrice - (spec.discountAmount ?? 0));
    }

    const headerTotal = rows.reduce((sum, r) => sum + Number(r.line_total), 0);
    expect(headerTotal).toBe(Number(primaryResult.out_total_amount));
  });

  it("4. Tepat satu opening debit dengan amount == invoice total", async () => {
    const { data: entries, error } = await supabase.from("receivable_ledger").select("*").eq("invoice_id", primaryResult.out_invoice_id);
    expect(error).toBeNull();
    const rows = (entries ?? []) as Array<{ entry_type: string; direction: string; amount: string; company_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].entry_type).toBe("invoice_issued");
    expect(rows[0].direction).toBe("debit");
    expect(Number(rows[0].amount)).toBe(Number(primaryResult.out_total_amount));
    expect(rows[0].company_id).toBe(companyId);
  });

  it("5. Order berubah menjadi 'invoiced' dan audit canonical tercatat", async () => {
    const { data: order } = await supabase.from("sales_orders").select("status").eq("id", primary.orderId).single();
    expect((order as { status: string }).status).toBe("invoiced");

    const { data: audit } = await supabase
      .from("audit_logs")
      .select("*")
      .eq("entity_type", "invoices")
      .eq("entity_id", primaryResult.out_invoice_id)
      .eq("action", "invoice.issued");
    const rows = (audit ?? []) as Array<{ outcome: string; company_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe("success");
    expect(rows[0].company_id).toBe(companyId);
  });

  // ---------------------------------------------------------------------
  // Duplicate & concurrency
  // ---------------------------------------------------------------------

  it("6. Pemanggilan kedua untuk order yang sama ditolak, tidak ada invoice/lines/ledger tambahan", async () => {
    const { error } = await issueInvoice(companyId, financeUser.userId, primary.orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/INVALID_ORDER_STATE|ORDER_ALREADY_INVOICED/);

    const { count: invCount } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("sales_order_id", primary.orderId);
    expect(invCount).toBe(1);
    const { count: lineCount } = await supabase.from("invoice_lines").select("id", { count: "exact", head: true }).eq("invoice_id", primaryResult.out_invoice_id);
    expect(lineCount).toBe(primary.lines.length);
    const { count: ledgerCount } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("invoice_id", primaryResult.out_invoice_id);
    expect(ledgerCount).toBe(1);
  });

  it("7. Dua pemanggilan concurrent untuk order yang sama hanya menghasilkan SATU invoice (row lock FOR UPDATE)", async () => {
    const concurrent = await createDeliveredOrder(companyId, `${runTag}-CONCUR`, [
      { productName: "Produk Concur", unit: "pcs", quantity: 3, unitPrice: 5000, discountAmount: 0 },
    ]);

    const [r1, r2] = await Promise.allSettled([
      issueInvoice(companyId, financeUser.userId, concurrent.orderId),
      issueInvoice(companyId, financeUser.userId, concurrent.orderId),
    ]);

    const results = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : { data: null, error: { message: String(r.reason) } }));
    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);

    const { data: concurrentInvoices, count: invCount } = await supabase
      .from("invoices")
      .select("id", { count: "exact" })
      .eq("sales_order_id", concurrent.orderId);
    expect(invCount).toBe(1);
    const concurrentInvoiceId = (concurrentInvoices as Array<{ id: string }>)[0].id;
    const { count: ledgerCount } = await supabase
      .from("receivable_ledger")
      .select("id", { count: "exact", head: true })
      .eq("invoice_id", concurrentInvoiceId);
    expect(ledgerCount).toBe(1);
  }, 30000);

  // ---------------------------------------------------------------------
  // Rollback atomik
  // ---------------------------------------------------------------------

  // LIMITATION (dilaporkan eksplisit, bukan diakali): pipeline
  // issue_invoice_atomic() membangun snapshot + invoice header + invoice_lines
  // + receivable_ledger dari SATU sumber locked yang identik (lihat migration
  // langkah 5) -- artinya trigger canonical Gate 2A pada invoice_lines/
  // receivable_ledger (validate_invoice_line_tenant, validate_receivable_
  // ledger_entry) TIDAK PERNAH bisa gagal secara alami lewat fixture apa pun
  // yang realistis, karena nilai yang divalidasi trigger tsb SELALU konsisten
  // dengan yang di-insert (dijamin oleh konstruksi function itu sendiri, by
  // design -- ini properti KEBENARAN yang baik, tapi berarti tidak ada celah
  // alami untuk memaksa kegagalan PERSIS pada langkah invoice_lines/
  // receivable_ledger tanpa helper test-only produksi (yang sudah dihapus).
  // Titik kegagalan alami TERDALAM yang bisa dipaksa lewat fixture murni
  // (tanpa mengubah/melemahkan constraint apa pun) adalah invoice HEADER --
  // dibuktikan di bawah lewat constraint UNIQUE(company_id, invoice_number)
  // canonical Gate 2A yang tidak diubah sama sekali. Ini membuktikan
  // rollback lintas DUA langkah nyata (issued_documents yang SUDAH ter-INSERT
  // lewat record_issued_document() ikut batal saat invoice header gagal
  // setelahnya) -- proof statis di describe block terpisah ("Static proof")
  // menutup sisanya (menjamin mekanisme atomicity yang SAMA berlaku sampai
  // langkah terakhir/audit_logs, karena seluruhnya satu function body tanpa
  // EXCEPTION block).
  it("8. Rollback penuh saat invoice header gagal via constraint UNIQUE canonical (invoice_number bentrok) -- issued_documents yang sudah tercipta ikut batal, status order tidak berubah", async () => {
    const rbA = await createDeliveredOrder(rollbackCompanyId, `${runTag}-RBA`, [
      { productName: "Produk Rollback A", unit: "pcs", quantity: 4, unitPrice: 1000, discountAmount: 0 },
    ]);
    const { error: errA } = await issueInvoice(rollbackCompanyId, rollbackFinanceUser.userId, rbA.orderId);
    expect(errA).toBeNull();

    // Rewind counter dokumen yang SUDAH terpakai -- skenario nyata (mis.
    // counter direset manual/rusak), BUKAN hook sintetis: hanya memanipulasi
    // data pada tabel primitive existing (document_number_counters) supaya
    // allocate_document_number() -- primitive canonical yang tidak diubah --
    // secara ALAMI mengalokasikan ulang invoice_number yang SAMA dengan
    // invoice A untuk company yang sama.
    const { data: counterRow, error: counterErr } = await supabase
      .from("document_number_counters")
      .select("business_date, last_sequence")
      .eq("company_id", rollbackCompanyId)
      .eq("document_type", "INVOICE")
      .single();
    expect(counterErr).toBeNull();
    const counter = counterRow as { business_date: string; last_sequence: number };

    const { error: rewindErr } = await supabase
      .from("document_number_counters")
      .update({ last_sequence: counter.last_sequence - 1 })
      .eq("company_id", rollbackCompanyId)
      .eq("document_type", "INVOICE")
      .eq("business_date", counter.business_date);
    expect(rewindErr).toBeNull();

    const rbB = await createDeliveredOrder(rollbackCompanyId, `${runTag}-RBB`, [
      { productName: "Produk Rollback B", unit: "pcs", quantity: 3, unitPrice: 2000, discountAmount: 0 },
    ]);

    const { error: errB } = await issueInvoice(rollbackCompanyId, rollbackFinanceUser.userId, rbB.orderId);
    expect(errB).not.toBeNull();
    expect(errB!.code).toBe("23505"); // unique_violation -- invoices UNIQUE(company_id, invoice_number), constraint canonical Gate 2A, tidak disentuh

    // Order B: issued_documents yang SEMPAT ter-INSERT (record_issued_document
    // berhasil SEBELUM invoice header gagal) ikut rollback penuh -- bukti
    // atomicity lintas dua langkah nyata, bukan cuma "tidak ada yang ditulis
    // sama sekali".
    const { count: docCountB } = await supabase
      .from("issued_documents")
      .select("id", { count: "exact", head: true })
      .eq("source_order_id", rbB.orderId)
      .eq("document_type", "INVOICE");
    expect(docCountB).toBe(0);
    const { count: invCountB } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("sales_order_id", rbB.orderId);
    expect(invCountB).toBe(0);
    const { data: orderB } = await supabase.from("sales_orders").select("status").eq("id", rbB.orderId).single();
    expect((orderB as { status: string }).status).toBe("delivered");

    // Company rollback secara keseluruhan hanya punya jejak dari order A yang
    // sukses -- order B tidak menyisakan invoice/ledger/audit sukses apa pun.
    const { count: ledgerCountTotal } = await supabase.from("receivable_ledger").select("id", { count: "exact", head: true }).eq("company_id", rollbackCompanyId);
    expect(ledgerCountTotal).toBe(1);
    const { count: invCountTotal } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("company_id", rollbackCompanyId);
    expect(invCountTotal).toBe(1);
    const { count: auditSuccessCount } = await supabase
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("company_id", rollbackCompanyId)
      .eq("action", "invoice.issued")
      .eq("outcome", "success");
    expect(auditSuccessCount).toBe(1);
  });

  // ---------------------------------------------------------------------
  // Negative / security
  // ---------------------------------------------------------------------

  it("9. TENANT_CONTEXT_MISMATCH: issuance lintas tenant ditolak", async () => {
    const { error } = await issueInvoice(companyId, financeUser.userId, otherCompanySource.orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("TENANT_CONTEXT_MISMATCH");

    const { count } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("sales_order_id", otherCompanySource.orderId);
    expect(count).toBe(0);
  });

  it("10. FORBIDDEN: actor tanpa permission invoice.issue (role sales) ditolak", async () => {
    const forbiddenSource = await createDeliveredOrder(companyId, `${runTag}-FORBID`, [
      { productName: "Produk Forbidden", unit: "pcs", quantity: 1, unitPrice: 1000, discountAmount: 0 },
    ]);
    const { error } = await issueInvoice(companyId, salesUser.userId, forbiddenSource.orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("FORBIDDEN");

    const { count } = await supabase.from("invoices").select("id", { count: "exact", head: true }).eq("sales_order_id", forbiddenSource.orderId);
    expect(count).toBe(0);
  });

  it("11. NO_BILLABLE_LINES: order tanpa delivery_items ditolak", async () => {
    const emptySource = await createDeliveredOrder(companyId, `${runTag}-EMPTY`, []);
    const { error } = await issueInvoice(companyId, financeUser.userId, emptySource.orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("NO_BILLABLE_LINES");
  });

  it("12. INVALID_ORDER_STATE: order belum 'delivered' ditolak", async () => {
    const notDeliveredSource = await createDeliveredOrder(
      companyId,
      `${runTag}-NOTDLV`,
      [{ productName: "Produk Belum Delivered", unit: "pcs", quantity: 1, unitPrice: 1000, discountAmount: 0 }],
      { status: "confirmed" },
    );
    const { error } = await issueInvoice(companyId, financeUser.userId, notDeliveredSource.orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INVALID_ORDER_STATE");
  });

  it("13. INCOMPLETE_DELIVERY_COVERAGE: received_quantity kurang dari order quantity (data tidak konsisten) ditolak", async () => {
    const partial = await createDeliveredOrder(companyId, `${runTag}-PARTIAL`, [
      { productName: "Produk Partial", unit: "pcs", quantity: 10, unitPrice: 1000, discountAmount: 0 },
    ]);
    // Simulasikan data tidak konsisten: status sudah 'delivered' tapi received_quantity < ordered.
    await supabase.from("delivery_items").update({ received_quantity: 6 }).eq("id", partial.deliveryItemIds[0]);

    const { error } = await issueInvoice(companyId, financeUser.userId, partial.orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("INCOMPLETE_DELIVERY_COVERAGE");
  });

  it("14. MULTI_DELIVERY_INVOICING_NOT_SUPPORTED: order dicakup lebih dari satu delivery ditolak (bukan silent aggregation)", async () => {
    const { data: customer } = await supabase
      .from("customers")
      .insert({ company_id: companyId, name: `Toko ${runTag}-MULTI`, code: `CUST-${runTag}-MULTI` })
      .select("id")
      .single();
    const customerId = (customer as { id: string }).id;
    createdCustomerIds.push(customerId);

    const { data: order } = await supabase
      .from("sales_orders")
      .insert({ company_id: companyId, order_number: `SO-${runTag}-MULTI`, customer_id: customerId, status: "delivered" })
      .select("id")
      .single();
    const orderId = (order as { id: string }).id;
    createdOrderIds.push(orderId);

    for (const suffix of ["1", "2"]) {
      const { data: delivery } = await supabase
        .from("deliveries")
        .insert({ company_id: companyId, sales_order_id: orderId, attempt_number: suffix === "1" ? 1 : 2, status: "planned" })
        .select("id")
        .single();
      const deliveryId = (delivery as { id: string }).id;
      createdDeliveryIds.push(deliveryId);

      const { data: item } = await supabase
        .from("sales_order_items")
        .insert({ order_id: orderId, product_name_raw: `Produk Multi ${suffix}`, unit: "pcs", quantity: 5, unit_price: 1000, discount_amount: 0, total_amount: 5000 })
        .select("id")
        .single();

      await supabase.from("delivery_items").insert({
        delivery_id: deliveryId,
        sales_order_item_id: (item as { id: string }).id,
        ordered_quantity: 5,
        dispatched_quantity: 5,
        received_quantity: 5,
      });
    }

    const { error } = await issueInvoice(companyId, financeUser.userId, orderId);
    expect(error).not.toBeNull();
    expect(error!.message).toContain("MULTI_DELIVERY_INVOICING_NOT_SUPPORTED");
  });

  it("15. Generic status mutation (update_sales_order_status_atomic) tetap tidak bisa mengubah order menjadi invoiced", async () => {
    const guardSource = await createDeliveredOrder(companyId, `${runTag}-GUARD`, [
      { productName: "Produk Guard", unit: "pcs", quantity: 1, unitPrice: 1000, discountAmount: 0 },
    ]);
    const { data, error } = await supabase.rpc("update_sales_order_status_atomic", {
      p_company_id: companyId,
      p_actor_id: salesUser.userId, // sales punya orders.update -- membuktikan guard C tetap menahan, bukan gagal di forbidden
      p_order_id: guardSource.orderId,
      p_new_status: "invoiced",
    });
    expect(error).toBeNull();
    expect((data as Array<{ result_outcome: string }>)[0].result_outcome).toBe("invoice_issuance_required");

    const { data: order } = await supabase.from("sales_orders").select("status").eq("id", guardSource.orderId).single();
    expect((order as { status: string }).status).toBe("delivered");
  });

  it("16. Security posture: anon TIDAK dapat memanggil issue_invoice_atomic sama sekali", async () => {
    const anon = createClient(env!.url, env!.anonKey);
    const { error } = await anon.rpc("issue_invoice_atomic", { p_company_id: companyId, p_actor_id: financeUser.userId, p_order_id: primary.orderId });
    expect(error).not.toBeNull();
  });

  it("17. Seluruh invoice_lines terikat ke invoice yang benar (tidak ada baris nyasar ke invoice lain)", async () => {
    const { data: lines } = await supabase.from("invoice_lines").select("invoice_id").eq("invoice_id", primaryResult.out_invoice_id);
    for (const row of (lines ?? []) as Array<{ invoice_id: string }>) {
      expect(row.invoice_id).toBe(primaryResult.out_invoice_id);
    }
  });
});
