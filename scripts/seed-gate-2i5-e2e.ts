/**
 * scripts/seed-gate-2i5-e2e.ts
 *
 * Fixture builder khusus untuk Gate 2I.5 (Browser E2E & Owner/Finance UAT
 * Closeout). TIDAK menyentuh scripts/seed-dev.ts (dirty pre-existing, wajib
 * tetap utuh). Seluruh mutation bisnis dipanggil lewat RPC canonical yang
 * sama dipakai server action (`apps/web/src/lib/finance/actions.ts`,
 * `apps/web/src/lib/orders/actions.ts`, `apps/web/src/lib/delivery/*`) —
 * tidak ada raw insert untuk entity bisnis (order/delivery/invoice/
 * payment/return/cancellation/refund). Idempotent per fixture di mana RPC
 * mendukungnya; script ini aman dijalankan ulang untuk company/user/produk/
 * customer, tapi akan membuat sales_order/invoice baru bila dijalankan
 * ulang (order_number unik per run pakai timestamp arg).
 *
 * Run: pnpm tsx scripts/seed-gate-2i5-e2e.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

function loadEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), "apps", "web", ".env.local"),
    path.resolve(process.cwd(), ".env.local"),
  ];
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
    console.log(`[env] Loaded from ${filePath}`);
    break;
  }
}

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SEED_PASSWORD = process.env.SEED_PASSWORD ?? "Aodp2026!";

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY harus di-set.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPANY = { name: "AODP Dev Distributor", slug: "aodp-dev" };
const PRODUCT = { sku: "AODP-001", name: "Air Mineral Cup 220 ml", unit: "dus", price: 18000 };
const CUSTOMER = {
  code: "CUST-001",
  name: "Toko Sumber Rejeki",
  type: "reseller",
  phone: "0812-9999-0001",
  area: "Cirebon Kota",
};

const RUN_TAG = process.env.SEED_RUN_TAG ?? String(Date.now());

function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  return supabase.rpc(fn, args).then(({ data, error }) => {
    if (error) throw new Error(`${fn} gagal: ${error.message} | args=${JSON.stringify(args)}`);
    return (Array.isArray(data) ? data[0] : data) as T;
  });
}

async function findAuthUserByEmail(email: string): Promise<string | null> {
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers gagal: ${error.message}`);
    const users = data?.users ?? [];
    const found = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (users.length < perPage) return null;
    page++;
  }
}

async function ensureUser(email: string, fullName: string, role: string, companyId: string): Promise<string> {
  let userId = await findAuthUserByEmail(email);
  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error) throw new Error(`Gagal membuat auth user ${email}: ${error.message}`);
    userId = data.user.id;
    console.log(`[user] dibuat: ${email}`);
  } else {
    console.log(`[user] sudah ada: ${email}`);
  }

  const { error: profileErr } = await supabase.from("users").upsert(
    { id: userId, company_id: companyId, email, full_name: fullName, is_active: true },
    { onConflict: "id" },
  );
  if (profileErr) throw new Error(`Gagal upsert profile ${email}: ${profileErr.message}`);

  const { data: roleRow, error: roleErr } = await supabase
    .from("roles").select("id").eq("name", role).is("company_id", null).single();
  if (roleErr || !roleRow) throw new Error(`Role ${role} tidak ditemukan: ${roleErr?.message}`);

  const { error: urErr } = await supabase.from("user_roles").upsert(
    { user_id: userId, role_id: roleRow.id, company_id: companyId },
    { onConflict: "user_id,role_id,company_id" },
  );
  if (urErr) throw new Error(`Gagal assign role ${role} ke ${email}: ${urErr.message}`);
  console.log(`    role ${role} -> ${email} (${userId})`);
  return userId;
}

interface InvoicedFixture {
  orderId: string;
  invoiceId: string;
  totalAmount: number;
  invoiceLineId: string;
  quantity: number;
}

/** Order -> confirmed -> delivered (fully_received) -> invoiced, seluruhnya via RPC canonical. */
async function buildInvoicedOrder(params: {
  orderNumber: string;
  companyId: string;
  ownerId: string;
  customerId: string;
  salesId: string;
  driverId: string;
  productId: string;
  quantity: number;
  unitPrice: number;
}): Promise<InvoicedFixture> {
  const { orderNumber, companyId, ownerId, customerId, salesId, driverId, productId, quantity, unitPrice } = params;
  const totalAmount = quantity * unitPrice;

  const orderResult = await rpc<{ result_outcome: string; result_order_id: string }>(
    "create_sales_order_atomic",
    {
      p_company_id: companyId,
      p_actor_id: ownerId,
      p_order_number: orderNumber,
      p_customer_id: customerId,
      p_sales_id: salesId,
      p_notes: null,
      p_delivery_date: null,
      p_discount_amount: 0,
      p_items: [
        {
          product_id: productId,
          quantity,
          unit_price: unitPrice,
          discount_amount: 0,
          total_amount: totalAmount,
          notes: null,
        },
      ],
    },
  );
  const orderId = orderResult.result_order_id;
  console.log(`  [order] ${orderNumber} -> ${orderId} (${orderResult.result_outcome})`);

  await rpc("update_sales_order_status_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_order_id: orderId,
    p_new_status: "confirmed",
  });

  const { data: soItems, error: soItemsErr } = await supabase
    .from("sales_order_items").select("id").eq("order_id", orderId);
  if (soItemsErr || !soItems?.length) throw new Error(`sales_order_items tidak ditemukan untuk order ${orderId}`);
  const soItemId = soItems[0].id as string;

  const deliveryResult = await rpc<{ result_outcome: string; result_delivery_id: string }>(
    "create_delivery_atomic",
    {
      p_company_id: companyId,
      p_actor_id: ownerId,
      p_sales_order_id: orderId,
      p_idempotency_key: randomUUID(),
      p_driver_id: driverId,
      p_items: [{ sales_order_item_id: soItemId, ordered_quantity: quantity }],
    },
  );
  const deliveryId = deliveryResult.result_delivery_id;
  console.log(`  [delivery] -> ${deliveryId} (${deliveryResult.result_outcome})`);

  await rpc("dispatch_delivery_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_delivery_id: deliveryId,
  });
  await supabase.rpc("sync_sales_order_delivery_status", { p_sales_order_id: orderId });

  const { data: deliveryItems, error: diErr } = await supabase
    .from("delivery_items").select("id").eq("delivery_id", deliveryId);
  if (diErr || !deliveryItems?.length) throw new Error(`delivery_items tidak ditemukan untuk delivery ${deliveryId}`);
  const deliveryItemId = deliveryItems[0].id as string;

  await rpc("finalize_delivery_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_delivery_id: deliveryId,
    p_final_status: "fully_received",
    p_item_outcomes: [
      {
        delivery_item_id: deliveryItemId,
        received_quantity: quantity,
        rejected_quantity: 0,
        returned_quantity: 0,
        unresolved_quantity: 0,
      },
    ],
    p_reason_code: null,
    p_reason_note: null,
    p_severity: null,
    p_recipient_name: "Gate 2I.5 E2E Fixture",
    p_is_expected_pic: true,
  });
  await supabase.rpc("sync_sales_order_delivery_status", { p_sales_order_id: orderId });

  const invoiceResult = await rpc<{ out_invoice_id: string; out_total_amount: number }>(
    "issue_invoice_atomic",
    { p_company_id: companyId, p_actor_id: ownerId, p_order_id: orderId },
  );
  const invoiceId = invoiceResult.out_invoice_id;
  console.log(`  [invoice] -> ${invoiceId} total=${invoiceResult.out_total_amount}`);

  const { data: invoiceLines, error: ilErr } = await supabase
    .from("invoice_lines").select("id").eq("invoice_id", invoiceId);
  if (ilErr || !invoiceLines?.length) throw new Error(`invoice_lines tidak ditemukan untuk invoice ${invoiceId}`);

  return { orderId, invoiceId, totalAmount, invoiceLineId: invoiceLines[0].id as string, quantity };
}

async function ensureCompanyProfile(companyId: string): Promise<void> {
  const { error } = await supabase.from("companies").update({
    legal_address: "Jl. Fixture Gate 2I.5 No. 1, Cirebon",
    contact_email: "finance-ops@aodp.test",
    contact_phone: "022-000-0000",
    document_number_prefix: "G2I5",
  }).eq("id", companyId);
  if (error) throw new Error(`Gagal set company profile: ${error.message}`);
}

async function main() {
  const { data: existingCompany } = await supabase
    .from("companies").select("id").eq("slug", COMPANY.slug).maybeSingle();
  let companyId = existingCompany?.id as string | undefined;
  if (!companyId) {
    const { data, error } = await supabase.from("companies")
      .insert({ name: COMPANY.name, slug: COMPANY.slug }).select("id").single();
    if (error) throw new Error(`Gagal membuat company: ${error.message}`);
    companyId = data.id;
  }
  console.log(`[1] Company: ${COMPANY.name} (${companyId})`);
  await ensureCompanyProfile(companyId);

  const ownerId = await ensureUser("owner@aodp.test", "Owner AODP", "owner", companyId);
  const salesId = await ensureUser("sales@aodp.test", "Sales Pertama", "sales", companyId);
  const financeId = await ensureUser("finance@aodp.test", "Finance AODP", "finance", companyId);

  const { data: product, error: prodErr } = await supabase.from("products").upsert(
    { company_id: companyId, sku: PRODUCT.sku, name: PRODUCT.name, unit: PRODUCT.unit, price: PRODUCT.price, is_active: true },
    { onConflict: "company_id,sku" },
  ).select("id").single();
  if (prodErr) throw new Error(`Gagal upsert produk: ${prodErr.message}`);
  const productId = product.id as string;
  console.log(`[2] Produk: ${PRODUCT.sku} (${productId})`);

  const { data: customer, error: custErr } = await supabase.from("customers").upsert(
    { company_id: companyId, ...CUSTOMER, assigned_sales_id: salesId, is_active: true },
    { onConflict: "company_id,code" },
  ).select("id").single();
  if (custErr) throw new Error(`Gagal upsert customer: ${custErr.message}`);
  const customerId = customer.id as string;
  console.log(`[3] Customer: ${CUSTOMER.name} (${customerId})`);

  const evidence: Record<string, unknown> = { companyId, ownerId, salesId, financeId, customerId, productId, runTag: RUN_TAG };

  // --- Fixture A: FIN-18-01 -- invoice outstanding, belum dibayar sama sekali ---
  console.log("\n[A] FIN-18-01 fixture: invoice outstanding (belum dibayar)");
  const invPay = await buildInvoicedOrder({
    orderNumber: `SO-G2I5-PAY-${RUN_TAG}`,
    companyId, ownerId, customerId, salesId, driverId: salesId, productId,
    quantity: 10, unitPrice: PRODUCT.price,
  });
  evidence.finPay = invPay;

  // --- Fixture B: FIN-18-02 -- return sudah diajukan Finance, menunggu Owner ---
  console.log("\n[B] FIN-18-02 fixture: return requested oleh Finance");
  const invRet = await buildInvoicedOrder({
    orderNumber: `SO-G2I5-RET-${RUN_TAG}`,
    companyId, ownerId, customerId, salesId, driverId: salesId, productId,
    quantity: 5, unitPrice: PRODUCT.price,
  });
  const returnResult = await rpc<{ out_return_id: string; out_status: string }>("request_return_atomic", {
    p_company_id: companyId,
    p_actor_id: financeId,
    p_invoice_id: invRet.invoiceId,
    p_items: [{ invoice_line_id: invRet.invoiceLineId, requested_quantity: 2 }],
    p_reason_code: "DAMAGED",
    p_proof_reference: `PROOF-RET-${RUN_TAG}`,
    p_idempotency_key: randomUUID(),
  });
  console.log(`  [return] -> ${returnResult.out_return_id} (${returnResult.out_status})`);
  evidence.finRet = { ...invRet, returnId: returnResult.out_return_id, returnStatus: returnResult.out_status };

  // --- Fixture C: FIN-18-03 -- cancellation requested, invoice sudah ada payment allocation ---
  console.log("\n[C] FIN-18-03 fixture: cancellation requested + invoice settlement exists");
  const invCxl = await buildInvoicedOrder({
    orderNumber: `SO-G2I5-CXL-${RUN_TAG}`,
    companyId, ownerId, customerId, salesId, driverId: salesId, productId,
    quantity: 8, unitPrice: PRODUCT.price,
  });
  const partialAmount = Math.round(invCxl.totalAmount * 0.5);
  const paymentResult = await rpc<{ out_payment_receipt_id: string }>("record_verified_payment_atomic", {
    p_company_id: companyId,
    p_actor_id: financeId,
    p_method: "bank_transfer",
    p_amount: partialAmount,
    p_proofs: [{ proof_type: "transfer_slip", object_reference: `SLIP-CXL-${RUN_TAG}`, metadata: {} }],
    p_allocations: [{ invoice_id: invCxl.invoiceId, amount: partialAmount }],
    p_transfer_reference: `TRF-CXL-${RUN_TAG}`,
    p_idempotency_key: randomUUID(),
  });
  console.log(`  [payment] -> ${paymentResult.out_payment_receipt_id} amount=${partialAmount}`);
  const cxlResult = await rpc<{ out_cancellation_id: string; out_status: string }>("request_order_cancellation_atomic", {
    p_company_id: companyId,
    p_actor_id: financeId,
    p_sales_order_id: invCxl.orderId,
    p_reason_code: "CUSTOMER_REQUEST",
    p_idempotency_key: randomUUID(),
  });
  console.log(`  [cancellation] -> ${cxlResult.out_cancellation_id} (${cxlResult.out_status})`);
  evidence.finCxlSettlement = {
    ...invCxl,
    paymentReceiptId: paymentResult.out_payment_receipt_id,
    paidAmount: partialAmount,
    cancellationId: cxlResult.out_cancellation_id,
    cancellationStatus: cxlResult.out_status,
  };

  // --- Fixture D: FIN-18-04 -- cancellation requested sederhana (belum diinvoice), untuk adversarial force-enable ---
  console.log("\n[D] FIN-18-04 fixture: cancellation requested sederhana (order belum invoiced)");
  const orderD = await rpc<{ result_outcome: string; result_order_id: string }>("create_sales_order_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_order_number: `SO-G2I5-ADV-${RUN_TAG}`,
    p_customer_id: customerId,
    p_sales_id: salesId,
    p_notes: null,
    p_delivery_date: null,
    p_discount_amount: 0,
    p_items: [{ product_id: productId, quantity: 3, unit_price: PRODUCT.price, discount_amount: 0, total_amount: 3 * PRODUCT.price, notes: null }],
  });
  await rpc("update_sales_order_status_atomic", {
    p_company_id: companyId, p_actor_id: ownerId, p_order_id: orderD.result_order_id, p_new_status: "confirmed",
  });
  const cxlAdvResult = await rpc<{ out_cancellation_id: string; out_status: string }>("request_order_cancellation_atomic", {
    p_company_id: companyId,
    p_actor_id: financeId,
    p_sales_order_id: orderD.result_order_id,
    p_reason_code: "CUSTOMER_REQUEST",
    p_idempotency_key: randomUUID(),
  });
  console.log(`  [cancellation-adv] -> ${cxlAdvResult.out_cancellation_id} (${cxlAdvResult.out_status})`);
  evidence.finCxlAdversarial = { orderId: orderD.result_order_id, cancellationId: cxlAdvResult.out_cancellation_id, cancellationStatus: cxlAdvResult.out_status };

  // --- Fixture E: FIN-18-05 -- refund SUDAH approved, credit note masih ada available balance ---
  console.log("\n[E] FIN-18-05 fixture: refund sudah approved");
  const invRefund = await buildInvoicedOrder({
    orderNumber: `SO-G2I5-REF-${RUN_TAG}`,
    companyId, ownerId, customerId, salesId, driverId: salesId, productId,
    quantity: 20, unitPrice: PRODUCT.price,
  });
  await rpc("record_verified_payment_atomic", {
    p_company_id: companyId,
    p_actor_id: financeId,
    p_method: "bank_transfer",
    p_amount: invRefund.totalAmount,
    p_proofs: [{ proof_type: "transfer_slip", object_reference: `SLIP-REF-${RUN_TAG}`, metadata: {} }],
    p_allocations: [{ invoice_id: invRefund.invoiceId, amount: invRefund.totalAmount }],
    p_transfer_reference: `TRF-REF-${RUN_TAG}`,
    p_idempotency_key: randomUUID(),
  });
  console.log(`  [payment] full-pay invoice ${invRefund.invoiceId} amount=${invRefund.totalAmount}`);

  const returnRefResult = await rpc<{ out_return_id: string }>("request_return_atomic", {
    p_company_id: companyId,
    p_actor_id: financeId,
    p_invoice_id: invRefund.invoiceId,
    p_items: [{ invoice_line_id: invRefund.invoiceLineId, requested_quantity: invRefund.quantity }],
    p_reason_code: "DAMAGED",
    p_proof_reference: `PROOF-REF-${RUN_TAG}`,
    p_idempotency_key: randomUUID(),
  });
  console.log(`  [return] -> ${returnRefResult.out_return_id}`);

  const verifyResult = await rpc<{ out_credit_note_id: string; out_customer_credit_amount: number }>("verify_return_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_return_id: returnRefResult.out_return_id,
    p_decision: "approve",
  });
  const creditNoteId = verifyResult.out_credit_note_id;
  const customerCreditAmount = Number(verifyResult.out_customer_credit_amount);
  console.log(`  [credit_note] -> ${creditNoteId} customer_credit_amount=${customerCreditAmount}`);

  const refundAmount = Math.round(customerCreditAmount * 0.4);
  const refundReqResult = await rpc<{ out_refund_id: string }>("request_refund_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_credit_note_id: creditNoteId,
    p_amount: refundAmount,
    p_method: "bank_transfer",
    p_proof_reference: `PROOF-REFUND-${RUN_TAG}`,
    p_transaction_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: randomUUID(),
  });
  const refundId = refundReqResult.out_refund_id;
  console.log(`  [refund requested] -> ${refundId} amount=${refundAmount}`);

  const refundApproveResult = await rpc<{ out_status: string; out_amount: number }>("approve_refund_atomic", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_refund_id: refundId,
    p_decision: "approve",
  });
  console.log(`  [refund approved] -> status=${refundApproveResult.out_status} amount=${refundApproveResult.out_amount}`);

  evidence.finRefundApproved = {
    ...invRefund,
    returnId: returnRefResult.out_return_id,
    creditNoteId,
    customerCreditAmount,
    refundId,
    refundAmount,
    refundStatus: refundApproveResult.out_status,
  };

  console.log("\n=== SEED GATE 2I.5 SELESAI ===");
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\nLogin owner:   owner@aodp.test`);
  console.log(`Login finance: finance@aodp.test`);
  console.log(`Login sales:   sales@aodp.test`);
  console.log(`(password sama untuk ketiganya, sesuai SEED_PASSWORD env / default seed-dev)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
