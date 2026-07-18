// =============================================================================
// Validasi + duplicate detection per domain (LANGKAH 7). Setiap validator
// menerima satu baris ter-mapping (target_field -> raw string) dan
// mengembalikan status + proposed_action + normalizedData siap commit.
//
// Aturan umum: customer/PIC/order/invoice TIDAK PERNAH digabung hanya karena
// nama mirip -- pencocokan existing SELALU exact (legacy_id atau nama persis
// sama), tidak pernah fuzzy/substring.
// =============================================================================

import { PIC_ROLES, type PicRole } from "@/lib/customer-pic/types";
import { normalizeIdPhone, normalizeEmail, normalizeIdDate, normalizeIdCurrency, normalizeIdNumber, normalizeSku, normalizeBoolean } from "./normalize";
import { neutralizeFormulaInjection } from "./security";
import type { ImportLookup } from "./dedupe";
import type { ProposedAction, RowFieldError, RowValidationStatus } from "./types";

export interface RowValidationResult {
  validationStatus: RowValidationStatus;
  proposedAction: ProposedAction;
  errors: RowFieldError[];
  warnings: RowFieldError[];
  detectedExistingId: string | null;
  normalizedData: Record<string, unknown>;
}

function clean(raw: string | undefined): string {
  if (!raw) return "";
  return neutralizeFormulaInjection(raw.trim()).value;
}

function finalize(errors: RowFieldError[], warnings: RowFieldError[], proposedAction: ProposedAction, detectedExistingId: string | null, normalizedData: Record<string, unknown>): RowValidationResult {
  let validationStatus: RowValidationStatus;
  if (errors.length > 0) validationStatus = "ERROR";
  else if (proposedAction === "SKIP_DUPLICATE") validationStatus = "DUPLICATE";
  else if (warnings.length > 0) validationStatus = "WARNING";
  else validationStatus = "VALID";

  return { validationStatus, proposedAction: errors.length > 0 ? "NEEDS_REVIEW" : proposedAction, errors, warnings, detectedExistingId, normalizedData };
}

// ---------------------------------------------------------------------------
// A. CUSTOMER_PIC
// ---------------------------------------------------------------------------

export async function validateCustomerPicRow(
  row: Record<string, string>, companyId: string, sourceSystem: string, lookup: ImportLookup
): Promise<RowValidationResult> {
  const errors: RowFieldError[] = [];
  const warnings: RowFieldError[] = [];

  const storeLegacyCode = clean(row.store_legacy_code);
  const storeName = clean(row.store_name);
  const picName = clean(row.pic_name);
  const picPhoneRaw = clean(row.pic_phone);

  if (!storeLegacyCode) errors.push({ field: "store_legacy_code", message: "Kode toko lama wajib diisi." });
  if (!storeName) errors.push({ field: "store_name", message: "Nama toko wajib diisi." });
  if (!picName) errors.push({ field: "pic_name", message: "Nama PIC wajib diisi." });
  if (!picPhoneRaw) errors.push({ field: "pic_phone", message: "Nomor HP PIC wajib diisi." });

  const picPhone = normalizeIdPhone(picPhoneRaw);
  if (picPhoneRaw && !picPhone) errors.push({ field: "pic_phone", message: "Format nomor HP PIC tidak valid." });

  const picEmailRaw = clean(row.pic_email);
  const picEmail = picEmailRaw ? normalizeEmail(picEmailRaw) : null;
  if (picEmailRaw && picEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(picEmail)) {
    errors.push({ field: "pic_email", message: "Format email PIC tidak valid." });
  }

  const rolesRaw = clean(row.pic_roles);
  const roles = rolesRaw.split(/[;,]/).map((r) => r.trim().toUpperCase()).filter(Boolean);
  const validRoles = roles.filter((r) => (PIC_ROLES as readonly string[]).includes(r)) as PicRole[];
  if (roles.length === 0) errors.push({ field: "pic_roles", message: "Peran PIC wajib diisi." });
  else if (validRoles.length !== roles.length) errors.push({ field: "pic_roles", message: `Peran tidak dikenal: ${roles.filter((r) => !validRoles.includes(r as PicRole)).join(", ")}` });

  const storePhone = normalizeIdPhone(clean(row.store_phone));
  const isActive = normalizeBoolean(clean(row.is_active), true);

  let assignedSalesId: string | null = null;
  const salesmanName = clean(row.assigned_salesman_name);
  if (salesmanName) {
    const salesman = await lookup.findSalesmanByName(companyId, salesmanName);
    if (salesman) assignedSalesId = salesman.id;
    else warnings.push({ field: "assigned_salesman_name", message: `Sales "${salesmanName}" tidak ditemukan -- toko diimport tanpa sales ditugaskan.` });
  }

  if (errors.length > 0) {
    return finalize(errors, warnings, "NEEDS_REVIEW", null, {});
  }

  // Cari toko existing: legacy_id dulu, baru exact name (tenant-scoped, exact-only).
  let existingStoreId: string | null = null;
  const byLegacy = await lookup.findCustomerByLegacyId(companyId, sourceSystem, storeLegacyCode);
  if (byLegacy) {
    existingStoreId = byLegacy.id;
  } else {
    const byName = await lookup.findCustomerByExactName(companyId, storeName);
    if (byName.length === 1) existingStoreId = byName[0]!.id;
    else if (byName.length > 1) {
      warnings.push({ field: "store_name", message: "Ditemukan lebih dari satu toko dengan nama persis sama -- butuh review manual." });
      return finalize(errors, warnings, "NEEDS_REVIEW", null, {});
    }
  }

  const normalizedData = {
    store_legacy_code: storeLegacyCode, store_name: storeName, store_phone: storePhone,
    store_address: clean(row.store_address) || null, store_area: clean(row.store_area) || null,
    assigned_sales_id: assignedSalesId, pic_name: picName, pic_phone: picPhone,
    pic_email: picEmail, pic_roles: validRoles, is_active: isActive,
  };

  if (existingStoreId) {
    const existingPic = await lookup.findPicByPhoneOnStore(companyId, existingStoreId, picPhone!);
    if (existingPic) {
      warnings.push({ field: "pic_phone", message: "Nomor PIC ini sudah terdaftar pada toko ini -- dilewati (bukan duplicate baru)." });
      return finalize(errors, warnings, "SKIP_DUPLICATE", existingPic.id, normalizedData);
    }
    return finalize(errors, warnings, "UPDATE", existingStoreId, normalizedData);
  }

  return finalize(errors, warnings, "CREATE", null, normalizedData);
}

// ---------------------------------------------------------------------------
// B. PRODUCT_PRICE
// ---------------------------------------------------------------------------

export async function validateProductPriceRow(
  row: Record<string, string>, companyId: string, sourceSystem: string, lookup: ImportLookup
): Promise<RowValidationResult> {
  const errors: RowFieldError[] = [];
  const warnings: RowFieldError[] = [];

  const productLegacyCode = clean(row.product_legacy_code);
  const sku = normalizeSku(clean(row.sku));
  const name = clean(row.name);
  const priceRaw = clean(row.price);
  const price = normalizeIdCurrency(priceRaw);

  if (!productLegacyCode) errors.push({ field: "product_legacy_code", message: "Kode produk lama wajib diisi." });
  if (!sku) errors.push({ field: "sku", message: "SKU wajib diisi." });
  if (!name) errors.push({ field: "name", message: "Nama produk wajib diisi." });
  if (!priceRaw) errors.push({ field: "price", message: "Harga wajib diisi." });
  else if (price === null) errors.push({ field: "price", message: "Format harga tidak valid." });

  if (errors.length > 0) return finalize(errors, warnings, "NEEDS_REVIEW", null, {});

  const normalizedData = {
    product_legacy_code: productLegacyCode, sku, name,
    unit: clean(row.unit) || "pcs", price, is_active: normalizeBoolean(clean(row.is_active), true),
  };

  const byLegacy = await lookup.findProductByLegacyId(companyId, sourceSystem, productLegacyCode);
  if (byLegacy) return finalize(errors, warnings, "UPDATE", byLegacy.id, normalizedData);

  const bySku = await lookup.findProductBySku(companyId, sku!);
  if (bySku) {
    warnings.push({ field: "sku", message: "SKU sudah terdaftar (dari sumber lain) -- akan diperbarui." });
    return finalize(errors, warnings, "UPDATE", bySku.id, normalizedData);
  }

  return finalize(errors, warnings, "CREATE", null, normalizedData);
}

// ---------------------------------------------------------------------------
// C. OPEN_AR
// ---------------------------------------------------------------------------

const AR_TOLERANCE = 0.01;

export async function validateOpenArRow(
  row: Record<string, string>, companyId: string, sourceSystem: string, lookup: ImportLookup
): Promise<RowValidationResult> {
  const errors: RowFieldError[] = [];
  const warnings: RowFieldError[] = [];

  const legacyInvoiceNumber = clean(row.legacy_invoice_number);
  const customerLegacyCode = clean(row.customer_legacy_code);
  const invoiceDate = normalizeIdDate(clean(row.invoice_date));
  const dueDate = clean(row.due_date) ? normalizeIdDate(clean(row.due_date)) : null;
  const originalAmount = normalizeIdCurrency(clean(row.original_amount));
  const amountPaid = normalizeIdCurrency(clean(row.amount_paid)) ?? 0;
  const outstandingBalanceSource = normalizeIdCurrency(clean(row.outstanding_balance));

  if (!legacyInvoiceNumber) errors.push({ field: "legacy_invoice_number", message: "Nomor invoice lama wajib diisi." });
  if (!customerLegacyCode) errors.push({ field: "customer_legacy_code", message: "Kode toko/pelanggan wajib diisi." });
  if (!clean(row.invoice_date)) errors.push({ field: "invoice_date", message: "Tanggal invoice wajib diisi." });
  else if (!invoiceDate) errors.push({ field: "invoice_date", message: "Format tanggal invoice tidak valid." });
  if (clean(row.due_date) && !dueDate) errors.push({ field: "due_date", message: "Format jatuh tempo tidak valid." });
  if (originalAmount === null) errors.push({ field: "original_amount", message: "Format nilai awal tidak valid." });
  if (outstandingBalanceSource === null) errors.push({ field: "outstanding_balance", message: "Format saldo outstanding tidak valid." });

  let customerId: string | null = null;
  if (customerLegacyCode) {
    const customer = await lookup.findCustomerByLegacyId(companyId, sourceSystem, customerLegacyCode);
    if (customer) customerId = customer.id;
    else errors.push({ field: "customer_legacy_code", message: `Toko dengan kode "${customerLegacyCode}" belum diimport -- import CUSTOMER_PIC terlebih dahulu.` });
  }

  let assignedSalesId: string | null = null;
  const salesmanName = clean(row.assigned_salesman_name);
  if (salesmanName) {
    const salesman = await lookup.findSalesmanByName(companyId, salesmanName);
    if (salesman) assignedSalesId = salesman.id;
    else warnings.push({ field: "assigned_salesman_name", message: `Sales "${salesmanName}" tidak ditemukan.` });
  }

  // Reconciliation per-baris (LANGKAH 9): original - paid harus = outstanding, dengan toleransi.
  const computedOutstanding = originalAmount !== null ? Number((originalAmount - amountPaid).toFixed(2)) : null;
  if (originalAmount !== null && outstandingBalanceSource !== null) {
    const diff = Math.abs(computedOutstanding! - outstandingBalanceSource);
    if (diff > AR_TOLERANCE) {
      errors.push({ field: "outstanding_balance", message: `Tidak konsisten: ${originalAmount} - ${amountPaid} = ${computedOutstanding}, bukan ${outstandingBalanceSource} (selisih ${diff.toFixed(2)}).` });
    }
  }

  if (errors.length > 0) return finalize(errors, warnings, "NEEDS_REVIEW", null, {});

  const normalizedData = {
    legacy_invoice_number: legacyInvoiceNumber, customer_id: customerId, invoice_date: invoiceDate,
    due_date: dueDate, original_amount: originalAmount, amount_paid: amountPaid,
    outstanding_balance: computedOutstanding, payment_terms: clean(row.payment_terms) || null,
    assigned_sales_id: assignedSalesId,
    _source_outstanding_balance: outstandingBalanceSource, // dipakai reconciliation.ts, bukan commit
  };

  const existing = await lookup.findArInvoiceByLegacyId(companyId, sourceSystem, legacyInvoiceNumber);
  if (existing) return finalize(errors, warnings, "UPDATE", existing.id, normalizedData);
  return finalize(errors, warnings, "CREATE", null, normalizedData);
}

// ---------------------------------------------------------------------------
// D/E. OPEN_ORDER & HISTORICAL_ORDER (satu baris = satu order+item, item
// digabung per legacy_order_number di service.ts sebelum commit)
// ---------------------------------------------------------------------------

const OPEN_ORDER_STATUSES = ["draft", "confirmed", "processing", "delivering"];
const TERMINAL_STATUSES = ["delivered", "invoiced", "paid", "cancelled"];

export async function validateOrderRow(
  row: Record<string, string>, companyId: string, sourceSystem: string, lookup: ImportLookup, kind: "OPEN_ORDER" | "HISTORICAL_ORDER"
): Promise<RowValidationResult> {
  const errors: RowFieldError[] = [];
  const warnings: RowFieldError[] = [];

  const legacyOrderNumber = clean(row.legacy_order_number);
  const customerLegacyCode = clean(row.customer_legacy_code);
  const productLegacyCode = clean(row.product_legacy_code);
  const orderDate = normalizeIdDate(clean(row.order_date));
  const quantity = normalizeIdNumber(clean(row.quantity));
  const unitPrice = normalizeIdCurrency(clean(row.unit_price));

  if (!legacyOrderNumber) errors.push({ field: "legacy_order_number", message: "Nomor order wajib diisi." });
  if (!customerLegacyCode) errors.push({ field: "customer_legacy_code", message: "Kode toko/pelanggan wajib diisi." });
  if (!productLegacyCode) errors.push({ field: "product_legacy_code", message: "Kode produk wajib diisi." });
  if (!clean(row.order_date)) errors.push({ field: "order_date", message: "Tanggal order wajib diisi." });
  else if (!orderDate) errors.push({ field: "order_date", message: "Format tanggal order tidak valid." });
  if (quantity === null || quantity <= 0) errors.push({ field: "quantity", message: "Kuantitas wajib > 0." });
  if (unitPrice === null) errors.push({ field: "unit_price", message: "Format harga satuan tidak valid." });

  let customerId: string | null = null;
  if (customerLegacyCode) {
    const customer = await lookup.findCustomerByLegacyId(companyId, sourceSystem, customerLegacyCode);
    if (customer) customerId = customer.id;
    else errors.push({ field: "customer_legacy_code", message: `Toko dengan kode "${customerLegacyCode}" belum diimport.` });
  }

  let productId: string | null = null;
  if (productLegacyCode) {
    const product = await lookup.findProductByLegacyId(companyId, sourceSystem, productLegacyCode);
    if (product) productId = product.id;
    else errors.push({ field: "product_legacy_code", message: `Produk dengan kode "${productLegacyCode}" belum diimport.` });
  }

  let salesId: string | null = null;
  const salesmanName = clean(row.salesman_name || row.assigned_salesman_name);
  if (salesmanName) {
    const salesman = await lookup.findSalesmanByName(companyId, salesmanName);
    if (salesman) salesId = salesman.id;
    else warnings.push({ field: "salesman_name", message: `Sales "${salesmanName}" tidak ditemukan.` });
  }

  let status: string;
  const statusRaw = clean(row.status || row.final_status).toLowerCase();
  if (kind === "HISTORICAL_ORDER") {
    status = TERMINAL_STATUSES.includes(statusRaw) ? statusRaw : "delivered";
    if (statusRaw && !TERMINAL_STATUSES.includes(statusRaw)) {
      warnings.push({ field: "final_status", message: `Status "${statusRaw}" bukan status final yang dikenal -- default ke "delivered".` });
    }
  } else {
    status = OPEN_ORDER_STATUSES.includes(statusRaw) ? statusRaw : "confirmed";
    if (statusRaw && !OPEN_ORDER_STATUSES.includes(statusRaw)) {
      warnings.push({ field: "status", message: `Status "${statusRaw}" tidak dikenal untuk open order -- default ke "confirmed".` });
    }
  }

  const discount = normalizeIdCurrency(clean(row.discount)) ?? 0;
  const totalRaw = clean(row.total || row.total_value);
  const total = normalizeIdCurrency(totalRaw) ?? (quantity !== null && unitPrice !== null ? quantity * unitPrice - discount : null);
  const outstandingQty = kind === "OPEN_ORDER" ? normalizeIdNumber(clean(row.outstanding_delivery_quantity)) : null;

  if (errors.length > 0) return finalize(errors, warnings, "NEEDS_REVIEW", null, {});

  const normalizedData = {
    legacy_order_number: legacyOrderNumber, customer_id: customerId, order_date: orderDate,
    sales_id: salesId, status,
    items: [{ product_id: productId, quantity, unit_price: unitPrice, discount_amount: discount, total_amount: total, legacy_outstanding_quantity: outstandingQty }],
    total_amount: total, discount_amount: discount, final_amount: total,
  };

  const existing = await lookup.findOrderByLegacyId(companyId, sourceSystem, legacyOrderNumber);
  if (existing) {
    warnings.push({ field: "legacy_order_number", message: "Nomor order ini sudah pernah diimport -- dilewati." });
    return finalize(errors, warnings, "SKIP_DUPLICATE", existing.id, normalizedData);
  }
  return finalize(errors, warnings, "CREATE", null, normalizedData);
}
