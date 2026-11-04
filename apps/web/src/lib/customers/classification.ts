// =============================================================================
// Klasifikasi customer (K-1): aturan murni tempo bayar per klasifikasi.
// Rancangan: docs/product/customer-classification/AODP_CUSTOMER_CLASSIFICATION_DESIGN.md
// =============================================================================

export const CLASS_MANAGER_ROLES = ["owner", "manager", "admin", "super_admin"];

export interface CustomerClassTerms {
  /** null = klasifikasi tidak menetapkan tempo (bayar tunai/COD atau manual). */
  defaultPaymentTermsDays: number | null;
}

/**
 * Tempo order: customer berklasifikasi -> tempo klasifikasi TERKUNCI untuk role
 * non-privileged (sales tidak bisa memperpanjang tempo). Owner/Admin boleh
 * mengoreksi. Customer tanpa klasifikasi -> input manual seperti sebelumnya.
 */
export function resolveOrderPaymentTerms(input: {
  requested: number | null;
  customerClass: CustomerClassTerms | null;
  isPrivileged: boolean;
}): number | null {
  const { requested, customerClass, isPrivileged } = input;
  if (!customerClass) return requested;
  if (isPrivileged && requested !== null) return requested;
  return customerClass.defaultPaymentTermsDays;
}

export interface ClassFormInput {
  name: string;
  defaultPaymentTermsDays: number | null;
  approvalThresholdAmount: number | null;
}

export type ClassValidation = { ok: true; value: ClassFormInput } | { ok: false; error: string };

export function validateClassInput(raw: {
  name: string;
  defaultPaymentTermsDays: string | number | null;
  approvalThresholdAmount: string | number | null;
}): ClassValidation {
  const name = raw.name.trim();
  if (name.length < 2 || name.length > 100) return { ok: false, error: "Nama klasifikasi 2–100 karakter." };

  const parse = (v: string | number | null): number | null | "invalid" => {
    if (v === null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : "invalid";
  };

  const terms = parse(raw.defaultPaymentTermsDays);
  if (terms === "invalid" || (terms !== null && (!Number.isInteger(terms) || terms < 1 || terms > 365))) {
    return { ok: false, error: "Tempo harus bilangan bulat 1–365 hari, atau kosong untuk tunai." };
  }
  const threshold = parse(raw.approvalThresholdAmount);
  if (threshold === "invalid" || (threshold !== null && threshold < 0)) {
    return { ok: false, error: "Ambang persetujuan harus angka ≥ 0, atau kosong." };
  }
  return { ok: true, value: { name, defaultPaymentTermsDays: terms, approvalThresholdAmount: threshold } };
}
