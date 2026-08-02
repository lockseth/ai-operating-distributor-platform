/**
 * scripts/seed-gate-3e-a-dataset.ts
 *
 * Gate 3E-A — Demo Identity & Dataset Provisioning. Dataset toko/produk/order
 * realistis untuk tenant demo "PT. Sumber Warna Alam Sudiada" di Supabase
 * project AODP-Waluyo-Demo. Prasyarat: scripts/seed-demo.ts SUDAH dijalankan
 * (company demo + owner/admin/2 sales harus sudah ada).
 *
 * Idempotent: setiap entity dicek dulu (natural key) sebelum dibuat.
 * Rerun TIDAK menggandakan coverage area, toko, produk, atau order. Seluruh
 * mutation bisnis (toko, order, status, dispute) lewat RPC canonical yang
 * sama dipakai server action — TIDAK ADA raw insert untuk entity bisnis.
 *
 * SATU pengecualian yang disengaja dan didokumentasikan: dua order historis
 * (lihat HISTORICAL_ORDER_NUMBERS) di-backdate murni pada kolom timestamp
 * `created_at`/`updated_at` lewat UPDATE langsung SETELAH dibuat via RPC —
 * tidak ada RPC yang mengekspos parameter backdating, dan field ini kosmetik
 * (kapan baris dicatat), bukan state/business-logic order. Tidak mengubah
 * status, item, atau workflow order sama sekali.
 *
 * Skenario "toko meragukan / fake toko" (wajib gate ini): toko kelima
 * (Toko Anugerah Baru) PIC-nya SENGAJA dibiarkan UNVERIFIED (tidak ikut
 * langkah verifikasi PIC), dan order kelima terhadap toko itu diajukan
 * dispute CUSTOMER_DENIES_ORDER lewat RPC create_order_cancellation_dispute
 * lalu DIBIARKAN berstatus REQUESTED (tidak diresolve) supaya Pak Waluyo
 * bisa mendemokan alur validasi/resolusi secara live.
 *
 * Run: pnpm tsx scripts/seed-gate-3e-a-dataset.ts
 */

import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const ENV_FILE = path.resolve(process.cwd(), ".env.demo.local");

function loadEnv(): void {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(".env.demo.local tidak ditemukan di root repo.");
    process.exit(1);
  }
  for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_DEMO_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_DEMO_URL / SUPABASE_DEMO_SERVICE_ROLE_KEY belum ada di .env.demo.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const COMPANY_SLUG = "sumber-warna-alam-sudiada-demo";

const AREA_NAMES = ["Cirebon Timur", "Cirebon Kota", "Cirebon Barat"] as const;

const PRODUCTS = [
  { sku: "SWA-CAT-5KG", name: "Cat Tembok Sumber Warna 5kg", unit: "pail", price: 185000 },
  { sku: "SWA-CAT-25KG", name: "Cat Tembok Sumber Warna 25kg", unit: "pail", price: 750000 },
  { sku: "SWA-CAT-KB-1L", name: "Cat Kayu & Besi Sumber Warna 1L", unit: "kaleng", price: 65000 },
  { sku: "SWA-THINNER-1L", name: "Thinner Sumber Warna 1L", unit: "botol", price: 32000 },
] as const;

interface StoreSpec {
  idemKey: string;
  name: string;
  phone: string;
  address: string;
  area: (typeof AREA_NAMES)[number];
  salesOwner: "sales1" | "sales2";
  pic: { name: string; phone: string; roles: string[] };
  /** Skenario validasi "toko meragukan" — PIC dibiarkan UNVERIFIED. */
  isValidationScenario?: boolean;
}

const STORES: StoreSpec[] = [
  {
    idemKey: "gate-3e-a-store-berkah-jaya",
    name: "Toko Bangunan Berkah Jaya",
    phone: "0812-0001-1001",
    address: "Jl. Kalitanjung No. 12, Cirebon",
    area: "Cirebon Timur",
    salesOwner: "sales1",
    pic: { name: "Slamet Riyadi", phone: "0812-0002-1001", roles: ["OWNER", "ORDERER"] },
  },
  {
    idemKey: "gate-3e-a-store-sumber-makmur",
    name: "Toko Sumber Makmur Cat & Bangunan",
    phone: "0812-0001-1002",
    address: "Jl. Fatahillah No. 45, Cirebon",
    area: "Cirebon Kota",
    salesOwner: "sales1",
    pic: { name: "Dedi Kurniawan", phone: "0812-0002-1002", roles: ["ORDERER", "RECEIVER"] },
  },
  {
    idemKey: "gate-3e-a-store-mitra-sejahtera",
    name: "Warung Material Mitra Sejahtera",
    phone: "0812-0001-1003",
    address: "Jl. Perjuangan No. 8, Cirebon",
    area: "Cirebon Timur",
    salesOwner: "sales1",
    pic: { name: "Rukmini", phone: "0812-0002-1003", roles: ["OWNER"] },
  },
  {
    idemKey: "gate-3e-a-store-cahaya-abadi",
    name: "Toko Cahaya Abadi Bangunan",
    phone: "0812-0001-1004",
    address: "Jl. Tuparev No. 21, Cirebon",
    area: "Cirebon Barat",
    salesOwner: "sales2",
    pic: { name: "Bambang Sutrisno", phone: "0812-0002-1004", roles: ["OWNER", "PAYMENT_CONTACT"] },
  },
  {
    idemKey: "gate-3e-a-store-anugerah-baru",
    name: "Toko Anugerah Baru",
    phone: "0812-0001-1005",
    address: "Jl. Pilang Raya No. 3, Cirebon",
    area: "Cirebon Barat",
    salesOwner: "sales2",
    pic: { name: "Yanto", phone: "0812-0002-1005", roles: ["ORDERER"] },
    isValidationScenario: true,
  },
];

interface OrderSpec {
  orderNumber: string;
  storeIdemKey: string;
  salesOwner: "sales1" | "sales2";
  items: { sku: string; quantity: number }[];
  targetStatus: "draft" | "confirmed" | "processing";
  backdateDays?: number;
  raiseDispute?: boolean;
}

const HISTORICAL_ORDER_NUMBERS = ["SO-DEMO-WALUYO-001", "SO-DEMO-WALUYO-002"];

const ORDERS: OrderSpec[] = [
  {
    orderNumber: "SO-DEMO-WALUYO-001",
    storeIdemKey: "gate-3e-a-store-berkah-jaya",
    salesOwner: "sales1",
    items: [{ sku: "SWA-CAT-25KG", quantity: 10 }],
    targetStatus: "confirmed",
    backdateDays: 14,
  },
  {
    orderNumber: "SO-DEMO-WALUYO-002",
    storeIdemKey: "gate-3e-a-store-sumber-makmur",
    salesOwner: "sales1",
    items: [{ sku: "SWA-CAT-5KG", quantity: 24 }],
    targetStatus: "processing",
    backdateDays: 14,
  },
  {
    orderNumber: "SO-DEMO-WALUYO-003",
    storeIdemKey: "gate-3e-a-store-mitra-sejahtera",
    salesOwner: "sales1",
    items: [
      { sku: "SWA-CAT-KB-1L", quantity: 12 },
      { sku: "SWA-THINNER-1L", quantity: 6 },
    ],
    targetStatus: "draft",
  },
  {
    orderNumber: "SO-DEMO-WALUYO-004",
    storeIdemKey: "gate-3e-a-store-cahaya-abadi",
    salesOwner: "sales2",
    items: [{ sku: "SWA-CAT-5KG", quantity: 15 }],
    targetStatus: "confirmed",
  },
  {
    orderNumber: "SO-DEMO-WALUYO-005",
    storeIdemKey: "gate-3e-a-store-anugerah-baru",
    salesOwner: "sales2",
    items: [{ sku: "SWA-CAT-25KG", quantity: 5 }],
    targetStatus: "confirmed",
    raiseDispute: true,
  },
];

function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  return supabase.rpc(fn, args).then(({ data, error }) => {
    if (error) throw new Error(`${fn} gagal: ${error.message} | args=${JSON.stringify(args)}`);
    return (Array.isArray(data) ? data[0] : data) as T;
  });
}

async function ensureCoverageArea(companyId: string, ownerId: string, name: string): Promise<string> {
  const { data: existing } = await supabase
    .from("coverage_areas")
    .select("id")
    .eq("company_id", companyId)
    .ilike("name", name)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const result = await rpc<{ result_outcome: string; area_id: string | null }>("create_coverage_area", {
    p_company_id: companyId,
    p_actor_id: ownerId,
    p_name: name,
    p_description: "Wilayah demo Gate 3E-A",
  });
  if (result.result_outcome === "created" && result.area_id) return result.area_id;
  if (result.result_outcome === "duplicate_area") {
    const { data: raced } = await supabase
      .from("coverage_areas")
      .select("id")
      .eq("company_id", companyId)
      .ilike("name", name)
      .single();
    if (raced?.id) return raced.id as string;
  }
  throw new Error(`create_coverage_area(${name}) gagal: outcome=${result.result_outcome}`);
}

async function main() {
  console.log("[0] Resolusi company demo + identitas");
  const { data: company, error: companyErr } = await supabase
    .from("companies")
    .select("id")
    .eq("slug", COMPANY_SLUG)
    .maybeSingle();
  if (companyErr || !company?.id) {
    throw new Error(`Company demo (slug=${COMPANY_SLUG}) tidak ditemukan — jalankan seed-demo.ts dulu.`);
  }
  const companyId = company.id as string;

  async function requireUser(email: string): Promise<string> {
    const { data, error } = await supabase.from("users").select("id").eq("company_id", companyId).eq("email", email).single();
    if (error || !data) throw new Error(`User ${email} tidak ditemukan di company demo — jalankan seed-demo.ts dulu.`);
    return data.id as string;
  }

  const ownerId = await requireUser("owner.demo@waluyo.aodp.test");
  const adminId = await requireUser("admin.demo@waluyo.aodp.test");
  const sales1Id = await requireUser("sales.demo@waluyo.aodp.test");
  const sales2Id = await requireUser("sales2.demo@waluyo.aodp.test");
  const salesIds = { sales1: sales1Id, sales2: sales2Id };
  console.log(`  company=${companyId} owner=${ownerId} admin=${adminId} sales1=${sales1Id} sales2=${sales2Id}`);

  console.log("[1] Wilayah cakupan (coverage_areas)");
  const areaIds: Record<string, string> = {};
  for (const name of AREA_NAMES) {
    areaIds[name] = await ensureCoverageArea(companyId, ownerId, name);
    console.log(`  area: ${name} (${areaIds[name]})`);
  }

  console.log("[2] Assign wilayah ke sales (full-replace, idempotent)");
  await rpc("assign_salesman_coverage_areas", {
    p_company_id: companyId,
    p_user_id: sales1Id,
    p_area_ids: [areaIds["Cirebon Timur"], areaIds["Cirebon Kota"]],
    p_actor_id: ownerId,
  });
  console.log("  sales1 -> Cirebon Timur, Cirebon Kota");
  await rpc("assign_salesman_coverage_areas", {
    p_company_id: companyId,
    p_user_id: sales2Id,
    p_area_ids: [areaIds["Cirebon Barat"], areaIds["Cirebon Kota"]],
    p_actor_id: ownerId,
  });
  console.log("  sales2 -> Cirebon Barat, Cirebon Kota");

  console.log("[3] Produk realistis (distributor cat)");
  const productIds: Record<string, string> = {};
  const productPrices: Record<string, number> = {};
  for (const p of PRODUCTS) {
    const { data, error } = await supabase
      .from("products")
      .upsert({ company_id: companyId, sku: p.sku, name: p.name, unit: p.unit, price: p.price, is_active: true }, { onConflict: "company_id,sku" })
      .select("id, price")
      .single();
    if (error) throw new Error(`Gagal upsert produk ${p.sku}: ${error.message}`);
    productIds[p.sku] = data.id as string;
    productPrices[p.sku] = Number(data.price);
    console.log(`  produk: ${p.sku} (${data.id})`);
  }

  console.log("[4] Toko demo (create_store_with_pic, canonical)");
  const storeCustomerIds: Record<string, string> = {};
  const storePicIds: Record<string, string> = {};
  for (const store of STORES) {
    const assignedSalesId = salesIds[store.salesOwner];
    const result = await rpc<{
      result_outcome: string;
      customer_id: string | null;
      customer_pic_id: string | null;
      duplicate_customer_id: string | null;
    }>("create_store_with_pic", {
      p_company_id: companyId,
      p_actor_id: ownerId,
      p_store_name: store.name,
      p_store_phone: store.phone,
      p_store_address: store.address,
      p_store_area: store.area,
      p_store_latitude: null,
      p_store_longitude: null,
      p_assigned_sales_id: assignedSalesId,
      p_pic_name: store.pic.name,
      p_pic_phone: store.pic.phone,
      p_pic_roles: store.pic.roles,
      p_idempotency_key: store.idemKey,
      p_source: "ADMIN_DASHBOARD",
    });
    if (result.result_outcome !== "created" && result.result_outcome !== "already_exists") {
      throw new Error(`create_store_with_pic(${store.name}) gagal: outcome=${result.result_outcome}`);
    }
    if (!result.customer_id) throw new Error(`create_store_with_pic(${store.name}) tidak mengembalikan customer_id`);
    storeCustomerIds[store.idemKey] = result.customer_id;
    if (result.customer_pic_id) storePicIds[store.idemKey] = result.customer_pic_id;
    console.log(`  toko: ${store.name} -> ${result.customer_id} (${result.result_outcome})`);
  }

  console.log("[5] Verifikasi PIC (4 toko) — 1 toko SENGAJA dibiarkan UNVERIFIED (skenario validasi)");
  for (const store of STORES) {
    const picId = storePicIds[store.idemKey];
    if (store.isValidationScenario || !picId) {
      console.log(`  skip verifikasi PIC: ${store.name} (skenario toko meragukan / PIC sudah lama terverifikasi)`);
      continue;
    }
    const { data: picRow } = await supabase.from("customer_pics").select("validation_status").eq("id", picId).single();
    if (picRow?.validation_status === "VERIFIED_BY_ADMIN") {
      console.log(`  PIC ${store.pic.name} sudah VERIFIED_BY_ADMIN, skip`);
      continue;
    }
    const verifyResult = await rpc<{ result_outcome: string }>("verify_customer_pic", {
      p_company_id: companyId,
      p_customer_pic_id: picId,
      p_reviewer_id: adminId,
      p_new_status: "VERIFIED_BY_ADMIN",
      p_reason: "Verifikasi awal onboarding toko demo Gate 3E-A",
    });
    console.log(`  verifikasi PIC ${store.pic.name}: ${verifyResult.result_outcome}`);
  }

  console.log("[6] Sales order demo (create_sales_order_atomic, canonical)");
  const today = new Date();
  for (const order of ORDERS) {
    const { data: existing } = await supabase
      .from("sales_orders")
      .select("id, status, created_at")
      .eq("company_id", companyId)
      .eq("order_number", order.orderNumber)
      .maybeSingle();
    if (existing?.id) {
      console.log(`  order ${order.orderNumber} sudah ada (${existing.id}, status=${existing.status}) — skip`);
      continue;
    }

    const customerId = storeCustomerIds[order.storeIdemKey];
    const salesId = salesIds[order.salesOwner];
    const items = order.items.map((it) => {
      const unitPrice = productPrices[it.sku];
      const totalAmount = unitPrice * it.quantity;
      return {
        product_id: productIds[it.sku],
        quantity: it.quantity,
        unit_price: unitPrice,
        discount_amount: 0,
        total_amount: totalAmount,
        notes: null,
      };
    });

    const orderResult = await rpc<{ result_outcome: string; result_order_id: string }>("create_sales_order_atomic", {
      p_company_id: companyId,
      p_actor_id: ownerId,
      p_order_number: order.orderNumber,
      p_customer_id: customerId,
      p_sales_id: salesId,
      p_notes: "Gate 3E-A demo dataset",
      p_delivery_date: null,
      p_discount_amount: 0,
      p_items: items,
    });
    if (orderResult.result_outcome !== "created") {
      throw new Error(`create_sales_order_atomic(${order.orderNumber}) gagal: outcome=${orderResult.result_outcome}`);
    }
    const orderId = orderResult.result_order_id;
    console.log(`  order: ${order.orderNumber} -> ${orderId} (draft)`);

    if (order.targetStatus !== "draft") {
      const statusResult = await rpc<{ result_outcome: string }>("update_sales_order_status_atomic", {
        p_company_id: companyId,
        p_actor_id: ownerId,
        p_order_id: orderId,
        p_new_status: order.targetStatus,
      });
      console.log(`    status -> ${order.targetStatus} (${statusResult.result_outcome})`);
    }

    if (order.backdateDays) {
      const backdated = new Date(today.getTime() - order.backdateDays * 24 * 60 * 60 * 1000).toISOString();
      // SATU pengecualian raw-write yang didokumentasikan di header file ini:
      // backdate kolom timestamp kosmetik saja, bukan state/business-logic.
      const { error: backdateErr } = await supabase
        .from("sales_orders")
        .update({ created_at: backdated, updated_at: backdated })
        .eq("id", orderId)
        .eq("company_id", companyId);
      if (backdateErr) throw new Error(`Gagal backdate order ${order.orderNumber}: ${backdateErr.message}`);
      console.log(`    created_at di-backdate ke ~${order.backdateDays} hari lalu (${backdated})`);
    }

    if (order.raiseDispute) {
      const storeSpec = STORES.find((s) => s.idemKey === order.storeIdemKey)!;
      const disputeResult = await rpc<{ result_outcome: string; request_id: string; ai_classification: string }>(
        "create_order_cancellation_dispute",
        {
          p_company_id: companyId,
          p_sales_order_id: orderId,
          p_request_type: "CUSTOMER_DENIES_ORDER",
          p_reason_code: "SUSPECTED_FAKE_STORE",
          p_notes:
            "Gate 3E-A demo fixture: skenario validasi toko meragukan — PIC toko belum terverifikasi, pelanggan yang dihubungi mengaku tidak pernah memesan. Dibiarkan REQUESTED untuk demo alur resolusi live.",
          p_reported_pic_name: storeSpec.pic.name,
          p_reported_pic_phone: storeSpec.pic.phone,
          p_contact_source: "CUSTOMER_PHONE",
          p_requested_by: salesId,
          p_idempotency_key: `gate-3e-a-dispute-${order.orderNumber}`,
        },
      );
      console.log(
        `    dispute diajukan (CUSTOMER_DENIES_ORDER): ${disputeResult.result_outcome} request_id=${disputeResult.request_id} ai=${disputeResult.ai_classification} (dibiarkan REQUESTED, tidak diresolve)`,
      );
    }
  }

  console.log("\n=== SEED GATE 3E-A DATASET SELESAI ===");
  console.log(
    JSON.stringify(
      {
        company_id: companyId,
        stores: Object.fromEntries(Object.entries(storeCustomerIds).map(([k, v]) => [k, v])),
        orders: ORDERS.map((o) => o.orderNumber),
        historical_order_numbers: HISTORICAL_ORDER_NUMBERS,
        validation_scenario_store: "gate-3e-a-store-anugerah-baru",
        validation_scenario_order: "SO-DEMO-WALUYO-005",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
