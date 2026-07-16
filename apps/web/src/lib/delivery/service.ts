// =============================================================================
// Service — business logic Delivery Verification, terpisah dari Telegram
// transport (workflow.ts memanggil fungsi-fungsi ini, tidak sebaliknya).
//
// Setiap fungsi mengutip aturan sumbernya (Pack v1.0 / Implementation Gate).
// Di mana sumber tidak eksplisit, keputusan MVP diberi komentar jelas —
// bukan mengarang aturan bisnis baru.
// =============================================================================

import type {
  DeliveryRecord,
  DeliveryItemRecord,
  DeliveryStatus,
  DeliveryOutcome,
  EvidenceType,
  ExceptionSeverity,
  ItemDiscrepancy,
  InvoiceEligibility,
  InvoiceEligibilityItem,
  AggregateInvoiceEligibility,
  AggregateInvoiceEligibilityItem,
  OwnerAlertPayload,
  ItemOutcomeInput,
} from "./types";
import { isTerminalStatus } from "./types";

/**
 * DV-01..DV-04 (Pack v1.0 §5): outcome yang dipilih driver dipetakan ke
 * status final delivery. "full" -> verified mengikuti Implementation Gate
 * §8 Scenario A secara eksplisit ("Delivery menjadi verified"). Skenario
 * lain memakai nama status yang sama dengan outcome-nya.
 */
export function mapOutcomeToFinalStatus(outcome: DeliveryOutcome): DeliveryStatus {
  switch (outcome) {
    case "full":
      return "verified";
    case "partial":
      return "partially_received";
    case "rejected":
      return "rejected";
    case "store_closed":
      return "store_closed";
    case "failed":
      return "failed";
  }
}

/**
 * Evidence minimum per outcome (Pack v1.0 §4.2 + Implementation Gate §4/§8).
 * Lokasi/GPS TIDAK PERNAH wajib kecuali outcome store_closed (Gate DV-03:
 * "foto, waktu, dan lokasi wajib direkam") — untuk outcome lain lokasi
 * "bila tersedia" (opsional, tidak boleh dikarang bila driver tidak mengirim).
 */
export interface EvidenceRequirement {
  requiredTypes: EvidenceType[];
  requireRecipient: boolean;
  requireReasonCode: boolean;
}

export function evidenceRequirementFor(outcome: DeliveryOutcome): EvidenceRequirement {
  switch (outcome) {
    case "full":
      // DV-01: "bukti minimum lengkap" -> foto + tanda tangan + identitas penerima.
      return { requiredTypes: ["photo", "signature"], requireRecipient: true, requireReasonCode: false };
    case "partial":
      // DV-02: "alasan wajib dipilih; bukti penerimaan wajib ada".
      return { requiredTypes: ["photo", "signature"], requireRecipient: true, requireReasonCode: true };
    case "rejected":
      // DV-04: "alasan penolakan dan evidence wajib" -- tidak mensyaratkan
      // tanda tangan (penerima menolak, tidak realistis meminta ttd).
      return { requiredTypes: ["photo"], requireRecipient: false, requireReasonCode: true };
    case "store_closed":
      // DV-03: "foto, waktu, dan lokasi wajib direkam". Lokasi divalidasi
      // terpisah (lihat validateStoreClosedEvidence) karena bukan EvidenceType biasa.
      return { requiredTypes: ["photo"], requireRecipient: false, requireReasonCode: false };
    case "failed":
      // Tidak dirinci eksplisit di Pack/Gate -- MVP: hanya reason code wajib
      // (mis. VEHICLE_OR_DRIVER_ISSUE, ADDRESS_NOT_FOUND), evidence opsional.
      return { requiredTypes: [], requireRecipient: false, requireReasonCode: true };
  }
}

export interface EvidenceValidationInput {
  outcome: DeliveryOutcome;
  evidenceTypes: EvidenceType[];
  hasRecipient: boolean;
  hasLocation: boolean;
  reasonCode: string | null;
}

export interface EvidenceValidationResult {
  valid: boolean;
  missing: string[];
}

/** Dipanggil sebelum finalizeDelivery -- menolak submission yang belum lengkap, tidak pernah mengarang bukti. */
export function validateEvidence(input: EvidenceValidationInput): EvidenceValidationResult {
  const req = evidenceRequirementFor(input.outcome);
  const missing: string[] = [];

  for (const type of req.requiredTypes) {
    if (!input.evidenceTypes.includes(type)) missing.push(type);
  }
  if (req.requireRecipient && !input.hasRecipient) missing.push("recipient");
  if (req.requireReasonCode && !input.reasonCode) missing.push("reason_code");
  if (input.outcome === "store_closed" && !input.hasLocation) missing.push("location");

  return { valid: missing.length === 0, missing };
}

/** DV-04: reason OTHER_REQUIRES_NOTE wajib punya catatan (mirror CHECK constraint DB). */
export function validateReasonNote(reasonCode: string, note: string | null | undefined): boolean {
  if (reasonCode !== "OTHER_REQUIRES_NOTE") return true;
  return typeof note === "string" && note.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Reconciliation & discrepancy (Pack v1.0 §4.2, Implementation Gate §4)
// ---------------------------------------------------------------------------

export function computeItemDiscrepancy(item: DeliveryItemRecord): ItemDiscrepancy {
  const discrepancyQuantity = item.dispatchedQuantity - item.receivedQuantity;
  return {
    deliveryItemId: item.id,
    salesOrderItemId: item.salesOrderItemId,
    productName: item.productName,
    dispatchedQuantity: item.dispatchedQuantity,
    receivedQuantity: item.receivedQuantity,
    discrepancyQuantity,
    discrepancyValue: discrepancyQuantity * item.unitPrice,
    hasDiscrepancy: discrepancyQuantity !== 0,
  };
}

export function computeDiscrepancies(delivery: DeliveryRecord): ItemDiscrepancy[] {
  return delivery.items.map(computeItemDiscrepancy);
}

/**
 * Kontrak Invoice Eligibility (Implementation Gate §9): SELALU dari
 * verified received_quantity, tidak pernah ordered/dispatched. TIDAK
 * membuat invoice -- murni derivasi untuk dikonsumsi tahap Invoice berikutnya.
 */
export function computeInvoiceEligibility(delivery: DeliveryRecord): InvoiceEligibility {
  const items: InvoiceEligibilityItem[] = delivery.items.map((item) => ({
    salesOrderItemId: item.salesOrderItemId,
    deliveryItemId: item.id,
    productName: item.productName,
    eligibleQuantity: item.receivedQuantity,
    unitPrice: item.unitPrice,
    eligibleValue: item.receivedQuantity * item.unitPrice,
  }));

  const totalEligibleValue = items.reduce((sum, i) => sum + i.eligibleValue, 0);
  const totalOrderedValue = delivery.items.reduce((sum, i) => sum + i.orderedQuantity * i.unitPrice, 0);

  return {
    deliveryId: delivery.id,
    salesOrderId: delivery.salesOrderId,
    status: delivery.status,
    isFinal: isTerminalStatus(delivery.status),
    items,
    totalEligibleValue,
    totalOrderedValue,
    varianceValue: totalOrderedValue - totalEligibleValue,
  };
}

/**
 * Invoice eligibility AGREGAT lintas seluruh delivery attempt milik satu
 * sales_order (bukan satu delivery). Item 5 audit invariant kuantitas: fungsi
 * ini adalah lapisan pertahanan KEDUA (defense in depth) -- lapisan pertama
 * dan otoritatif adalah `finalize_delivery_item_quantities` (atomic, DB-level)
 * yang MENCEGAH SUM received_quantity melebihi ordered_quantity sejak ditulis.
 * Fungsi ini tidak pernah diam-diam menyembunyikan anomali: bila suatu saat
 * data historis (mis. dari sebelum fix ini) menunjukkan SUM > ordered,
 * `eligibleQuantity` tetap di-cap ke ordered (tidak pernah dipakai untuk
 * invoice melebihi yang dipesan), TAPI `dataIntegrityWarning` diset TRUE --
 * bukan silent clamp, konsumen wajib menampilkan/menindaklanjuti peringatan itu.
 */
export function computeAggregateInvoiceEligibility(
  salesOrderId: string,
  rawItems: { salesOrderItemId: string; productName: string; unitPrice: number; orderedQuantity: number; aggregateReceivedQuantity: number }[]
): AggregateInvoiceEligibility {
  const items: AggregateInvoiceEligibilityItem[] = rawItems.map((raw) => {
    const dataIntegrityWarning = raw.aggregateReceivedQuantity > raw.orderedQuantity;
    const eligibleQuantity = Math.min(raw.aggregateReceivedQuantity, raw.orderedQuantity);
    return {
      salesOrderItemId: raw.salesOrderItemId,
      productName: raw.productName,
      orderedQuantity: raw.orderedQuantity,
      aggregateReceivedQuantity: raw.aggregateReceivedQuantity,
      eligibleQuantity,
      unitPrice: raw.unitPrice,
      eligibleValue: eligibleQuantity * raw.unitPrice,
      dataIntegrityWarning,
    };
  });

  return {
    salesOrderId,
    items,
    totalEligibleValue: items.reduce((sum, i) => sum + i.eligibleValue, 0),
    totalOrderedValue: items.reduce((sum, i) => sum + i.orderedQuantity * i.unitPrice, 0),
    hasDataIntegrityWarning: items.some((i) => i.dataIntegrityWarning),
  };
}

// ---------------------------------------------------------------------------
// Severity & owner alert decision (tanpa nominal buatan -- lihat Pack §10)
// ---------------------------------------------------------------------------

/**
 * Severity kualitatif, BUKAN dari ambang nominal (materiality threshold
 * belum dikalibrasi -- Pack v1.0 §10). Berbasis outcome + apakah customer
 * menerima sebagian/tidak sama sekali.
 */
export function computeExceptionSeverity(outcome: DeliveryOutcome, invoiceEligibility: InvoiceEligibility): ExceptionSeverity {
  if (outcome === "rejected") {
    return invoiceEligibility.totalEligibleValue === 0 ? "high" : "medium";
  }
  if (outcome === "partial") {
    return "medium";
  }
  // store_closed / failed: belum ada barang berpindah tangan, tidak ada
  // dampak invoice langsung -- tetap butuh perhatian owner (lihat
  // requiresOwnerAlert) tapi risikonya operasional, bukan finansial.
  return "low";
}

/**
 * Owner alert (WhatsApp, §4.5) policy terpusat -- dipicu oleh DAMPAK BISNIS,
 * bukan daftar outcome yang di-hardcode. Prinsip (AODP Waluyo Living
 * Knowledge Pack v1.0 §4.5, Implementation Gate §7):
 *
 *   1. Verified received value berbeda dari yang seharusnya diterima
 *      (invoice eligibility bervariansi dari nilai order); ATAU
 *   2. Outcome termasuk kelas yang secara inheren butuh perhatian owner
 *      (store_closed, rejected, failed, partially_received) -- barang tidak
 *      sampai ke tangan customer sesuai rencana, terlepas dari nilai variance-nya
 *      (mis. store_closed/failed punya invoice eligible = 0, variance = nilai
 *      order penuh -- tetap harus mengalir lewat cabang #1 juga, cabang #2
 *      ini eksplisit sebagai jaring pengaman bila suatu saat ada order
 *      bernilai 0); ATAU
 *   3. Ada exception dengan severity yang butuh keputusan owner/supervisor
 *      (medium/high -- bukan sekadar dicatat, tapi perlu ditindaklanjuti).
 *
 *   Pengecualian tunggal: delivery `verified` (full, tanpa exception) TIDAK
 *   PERNAH menghasilkan alert -- itulah jalur "semua beres", justru noise
 *   bila dialert (Pack v1.0 §4.5: "Prioritas, bukan volume").
 */
const OUTCOME_REQUIRES_OWNER_ATTENTION: readonly DeliveryStatus[] = [
  "store_closed",
  "rejected",
  "failed",
  "partially_received",
];

export function requiresOwnerAlert(
  finalStatus: DeliveryStatus,
  invoiceEligibility: InvoiceEligibility,
  exceptions: { severity: ExceptionSeverity }[] = []
): boolean {
  // Full delivery bersih -- tidak pernah alert, walau ada exception "low"
  // yang entah bagaimana menempel (tidak terjadi di alur saat ini, tapi
  // dijaga eksplisit sesuai instruksi "jangan buat critical variance alert
  // untuk full delivery tanpa variance").
  if (finalStatus === "verified" && invoiceEligibility.varianceValue === 0) {
    return false;
  }

  if (OUTCOME_REQUIRES_OWNER_ATTENTION.includes(finalStatus)) return true;
  if (invoiceEligibility.varianceValue !== 0) return true;
  if (exceptions.some((e) => e.severity === "medium" || e.severity === "high")) return true;

  return false;
}

export function buildOwnerAlertPayload(input: {
  customerName: string;
  orderReference: string;
  finalStatus: DeliveryStatus;
  invoiceEligibility: InvoiceEligibility;
  reason: string;
  evidenceSummary: string;
  actor: string;
}): OwnerAlertPayload {
  const RECOMMENDATION: Partial<Record<DeliveryStatus, string>> = {
    rejected: "Tinjau alasan penolakan bersama sales/driver sebelum pengiriman ulang.",
    partially_received: "Verifikasi selisih dengan customer sebelum invoice diterbitkan.",
    store_closed: "Toko tutup saat pengiriman -- jadwalkan ulang pengiriman dan konfirmasi jam operasional toko ke sales/customer.",
    failed: "Pengiriman gagal (lihat alasan) -- tinjau kendala dan jadwalkan ulang; periksa evidence yang tersedia sebelum menugaskan ulang driver.",
  };

  return {
    customerName: input.customerName,
    orderReference: input.orderReference,
    status: input.finalStatus,
    orderedValue: input.invoiceEligibility.totalOrderedValue,
    acceptedValue: input.invoiceEligibility.totalEligibleValue,
    varianceValue: input.invoiceEligibility.varianceValue,
    reason: input.reason,
    evidenceSummary: input.evidenceSummary,
    actor: input.actor,
    recommendation:
      RECOMMENDATION[input.finalStatus] ?? "Tinjau detail delivery ini sebelum melanjutkan proses invoice.",
  };
}

// ---------------------------------------------------------------------------
// Per-item outcome application -- dipanggil workflow setelah driver
// menuntaskan input jumlah per item.
// ---------------------------------------------------------------------------

export function applyItemOutcome(item: DeliveryItemRecord, input: ItemOutcomeInput): DeliveryItemRecord {
  return {
    ...item,
    receivedQuantity: input.receivedQuantity,
    rejectedQuantity: input.rejectedQuantity,
    returnedQuantity: input.returnedQuantity,
    unresolvedQuantity: input.unresolvedQuantity,
  };
}

/** Rekonsiliasi wajib: dispatched harus sama dengan jumlah keempat kategori (Gate §4 constraint). */
export function isItemOutcomeReconciled(item: DeliveryItemRecord): boolean {
  const sum = item.receivedQuantity + item.rejectedQuantity + item.returnedQuantity + item.unresolvedQuantity;
  return sum === item.dispatchedQuantity;
}

export function isFullyReceived(delivery: DeliveryRecord): boolean {
  return delivery.items.every((i) => i.receivedQuantity === i.dispatchedQuantity && i.dispatchedQuantity === i.orderedQuantity);
}
