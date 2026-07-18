// =============================================================================
// AODP adapter — normalisasi. Primitif FORMAT generik (tanggal/nominal/
// boolean) di-reuse dari Universal Core (lib/data-onboarding/core/normalize.ts).
// Nomor telepon & email REUSE persis dari modul customer-pic (satu sumber
// kebenaran AODP, konsisten dengan RPC create_store_with_pic/
// create_customer_pic) -- ini AODP-specific, bukan universal, sengaja TIDAK
// pindah ke core.
// =============================================================================

import { normalizeIdPhone } from "@/lib/customer-pic/phone";
import { normalizeEmail } from "@/lib/customer-pic/email";
import { normalizeIdDate, normalizeIdCurrency, normalizeIdNumber, normalizeUpperSlug, normalizeBoolean } from "@/lib/data-onboarding/core/normalize";

export { normalizeIdPhone, normalizeEmail, normalizeIdDate, normalizeIdCurrency, normalizeIdNumber, normalizeBoolean };

export function normalizeSku(raw: string | null | undefined): string | null {
  return normalizeUpperSlug(raw);
}
