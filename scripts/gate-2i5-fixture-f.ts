/**
 * scripts/gate-2i5-fixture-f.ts
 *
 * Fixture tambahan Gate 2I.5 khusus FIN-18-02: invoice dibayar lunas dulu,
 * lalu Finance mengajukan retur (request_return_atomic) dan DIBIARKAN
 * `requested` (tidak diverifikasi lewat script) supaya Owner bisa approve
 * lewat browser dan menghasilkan credit_note dengan customer_credit_amount
 * > 0 (available_balance baru yang bisa diverifikasi di tab Customer Credit).
 * Seluruh mutation lewat RPC canonical, sama seperti scripts/seed-gate-2i5-e2e.ts.
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

function loadEnv(): void {
  const filePath = path.resolve(process.cwd(), "apps", "web", ".env.local");
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  return supabase.rpc(fn, args).then(({ data, error }) => {
    if (error) throw new Error(`${fn} gagal: ${error.message} | args=${JSON.stringify(args)}`);
    return (Array.isArray(data) ? data[0] : data) as T;
  });
}

const RUN_TAG = process.env.SEED_RUN_TAG ?? String(Date.now());

async function main() {
  const { data: company } = await supabase.from("companies").select("id").eq("slug", "aodp-dev").single();
  const companyId = company!.id as string;
  const { data: owner } = await supabase.from("users").select("id").eq("company_id", companyId).eq("email", "owner@aodp.test").single();
  const { data: finance } = await supabase.from("users").select("id").eq("company_id", companyId).eq("email", "finance@aodp.test").single();
  const { data: sales } = await supabase.from("users").select("id").eq("company_id", companyId).eq("email", "sales@aodp.test").single();
  const { data: customer } = await supabase.from("customers").select("id").eq("company_id", companyId).eq("code", "CUST-001").single();
  const { data: product } = await supabase.from("products").select("id, price").eq("company_id", companyId).eq("sku", "AODP-001").single();

  const ownerId = owner!.id, financeId = finance!.id, salesId = sales!.id, customerId = customer!.id, productId = product!.id;
  const unitPrice = product!.price as number;
  const quantity = 12;
  const totalAmount = quantity * unitPrice;

  const orderResult = await rpc<{ result_order_id: string }>("create_sales_order_atomic", {
    p_company_id: companyId, p_actor_id: ownerId, p_order_number: `SO-G2I5-RETF-${RUN_TAG}`,
    p_customer_id: customerId, p_sales_id: salesId, p_notes: null, p_delivery_date: null, p_discount_amount: 0,
    p_items: [{ product_id: productId, quantity, unit_price: unitPrice, discount_amount: 0, total_amount: totalAmount, notes: null }],
  });
  const orderId = orderResult.result_order_id;
  await rpc("update_sales_order_status_atomic", { p_company_id: companyId, p_actor_id: ownerId, p_order_id: orderId, p_new_status: "confirmed" });

  const { data: soItems } = await supabase.from("sales_order_items").select("id").eq("order_id", orderId);
  const soItemId = soItems![0].id as string;

  const deliveryResult = await rpc<{ result_delivery_id: string }>("create_delivery_atomic", {
    p_company_id: companyId, p_actor_id: ownerId, p_sales_order_id: orderId, p_idempotency_key: randomUUID(),
    p_driver_id: salesId, p_items: [{ sales_order_item_id: soItemId, ordered_quantity: quantity }],
  });
  const deliveryId = deliveryResult.result_delivery_id;
  await rpc("dispatch_delivery_atomic", { p_company_id: companyId, p_actor_id: ownerId, p_delivery_id: deliveryId });
  await supabase.rpc("sync_sales_order_delivery_status", { p_sales_order_id: orderId });

  const { data: deliveryItems } = await supabase.from("delivery_items").select("id").eq("delivery_id", deliveryId);
  const deliveryItemId = deliveryItems![0].id as string;

  await rpc("finalize_delivery_atomic", {
    p_company_id: companyId, p_actor_id: ownerId, p_delivery_id: deliveryId, p_final_status: "fully_received",
    p_item_outcomes: [{ delivery_item_id: deliveryItemId, received_quantity: quantity, rejected_quantity: 0, returned_quantity: 0, unresolved_quantity: 0 }],
    p_reason_code: null, p_reason_note: null, p_severity: null, p_recipient_name: "Gate 2I.5 E2E Fixture F", p_is_expected_pic: true,
  });
  await supabase.rpc("sync_sales_order_delivery_status", { p_sales_order_id: orderId });

  const invoiceResult = await rpc<{ out_invoice_id: string }>("issue_invoice_atomic", { p_company_id: companyId, p_actor_id: ownerId, p_order_id: orderId });
  const invoiceId = invoiceResult.out_invoice_id;

  await rpc("record_verified_payment_atomic", {
    p_company_id: companyId, p_actor_id: financeId, p_method: "bank_transfer", p_amount: totalAmount,
    p_proofs: [{ proof_type: "transfer_slip", object_reference: `SLIP-RETF-${RUN_TAG}`, metadata: {} }],
    p_allocations: [{ invoice_id: invoiceId, amount: totalAmount }],
    p_transfer_reference: `TRF-RETF-${RUN_TAG}`, p_idempotency_key: randomUUID(),
  });

  const { data: invoiceLines } = await supabase.from("invoice_lines").select("id").eq("invoice_id", invoiceId);
  const invoiceLineId = invoiceLines![0].id as string;

  const returnResult = await rpc<{ out_return_id: string; out_status: string }>("request_return_atomic", {
    p_company_id: companyId, p_actor_id: financeId, p_invoice_id: invoiceId,
    p_items: [{ invoice_line_id: invoiceLineId, requested_quantity: quantity }],
    p_reason_code: "DAMAGED", p_proof_reference: `PROOF-RETF-${RUN_TAG}`, p_idempotency_key: randomUUID(),
  });

  console.log(JSON.stringify({ orderId, invoiceId, totalAmount, returnId: returnResult.out_return_id, returnStatus: returnResult.out_status }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
