// =============================================================================
// K-2: aturan murni persetujuan Owner untuk invoice bernilai besar.
// Rancangan: docs/product/customer-classification/AODP_CUSTOMER_CLASSIFICATION_DESIGN.md
// Penegakan sesungguhnya di DB (trigger trg_invoices_enforce_approval); ini hanya
// keputusan alur di server action supaya pesannya ramah.
// =============================================================================

export const INVOICE_APPROVER_ROLES = ["owner", "super_admin"];

export type InvoiceApprovalDecision =
  /** Tanpa ambang / di bawah ambang / sudah disetujui -> lanjut terbitkan. */
  | "proceed"
  /** Penerbit adalah Owner sendiri -> catat persetujuan otomatis, lanjut. */
  | "owner_self_approve"
  /** Perlu persetujuan Owner dulu -> buat permintaan, jangan terbitkan. */
  | "request";

export function decideInvoiceApproval(input: {
  amount: number;
  threshold: number | null;
  alreadyApproved: boolean;
  isOwner: boolean;
}): InvoiceApprovalDecision {
  const { amount, threshold, alreadyApproved, isOwner } = input;
  if (threshold === null || amount <= threshold) return "proceed";
  if (alreadyApproved) return "proceed";
  return isOwner ? "owner_self_approve" : "request";
}
