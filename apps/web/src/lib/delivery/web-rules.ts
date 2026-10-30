// =============================================================================
// Aturan murni alur pengiriman versi web (tanpa Telegram). Lihat
// docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md.
// Tanpa I/O supaya mudah diuji; dipakai web-actions.ts dan halaman Pengiriman.
// =============================================================================

import type { DeliveryEvidenceInput, DeliveryOutcome, DeliveryStatus, ReasonCode } from "./types";

export type DeliveryNextStep = "start" | "arrive" | "record_result" | "done";

/** Langkah berikutnya yang boleh dilakukan pengantar untuk status delivery. */
export function nextDeliveryStep(status: DeliveryStatus): DeliveryNextStep {
  switch (status) {
    case "planned":
      return "start";
    case "dispatched":
      return "arrive";
    case "arrived":
      return "record_result";
    default:
      return "done";
  }
}

/** Hanya pengantar yang ditugaskan yang boleh mengerjakan (keputusan Founder 2026-10-30). */
export function canOperateDelivery(userId: string, delivery: { assignedDriverId: string | null }): boolean {
  return delivery.assignedDriverId !== null && delivery.assignedDriverId === userId;
}

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

export function isValidGeoFix(fix: GeoFix | null | undefined): fix is GeoFix {
  return (
    !!fix &&
    Number.isFinite(fix.latitude) &&
    Number.isFinite(fix.longitude) &&
    fix.latitude >= -90 &&
    fix.latitude <= 90 &&
    fix.longitude >= -180 &&
    fix.longitude <= 180
  );
}

/**
 * Bukti lokasi saat tiba. Lokasi TIDAK memblokir (izin GPS bisa ditolak /
 * sinyal buruk) tetapi ketiadaannya ditandai `locationMissing` agar masuk
 * audit Owner.
 */
export function buildArrivalLocationEvidence(
  fix: GeoFix | null | undefined,
  capturedAtIso: string,
): { evidence: DeliveryEvidenceInput | null; locationMissing: boolean } {
  if (!isValidGeoFix(fix)) return { evidence: null, locationMissing: true };
  return {
    evidence: {
      evidenceType: "location",
      storageRef: `geo:${fix.latitude.toFixed(6)},${fix.longitude.toFixed(6)}`,
      capturedAt: capturedAtIso,
      latitude: fix.latitude,
      longitude: fix.longitude,
      metadata: { source: "web", step: "arrival", accuracyMeters: fix.accuracy ?? null },
    },
    locationMissing: false,
  };
}

// ---------------------------------------------------------------------------
// S2 -- hasil pengiriman
// ---------------------------------------------------------------------------


export interface ItemOutcomeValues {
  receivedQuantity: number;
  rejectedQuantity: number;
  returnedQuantity: number;
  unresolvedQuantity: number;
}

export type ItemOutcomeBuildResult =
  | { ok: true; outcomes: Record<string, ItemOutcomeValues> }
  | { ok: false; error: string };

/**
 * Pemetaan hasil -> jumlah per barang (mirror alur Telegram, workflow.ts):
 * full = semua diterima; store_closed/failed = semua unresolved; rejected =
 * semua ditolak; partial = jumlah diterima per barang, sisanya unresolved.
 */
export function buildItemOutcomes(
  outcome: DeliveryOutcome,
  items: { id: string; dispatchedQuantity: number }[],
  receivedByItem: Record<string, number>,
): ItemOutcomeBuildResult {
  const outcomes: Record<string, ItemOutcomeValues> = {};
  for (const item of items) {
    const d = item.dispatchedQuantity;
    if (outcome === "full") {
      outcomes[item.id] = { receivedQuantity: d, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: 0 };
    } else if (outcome === "store_closed" || outcome === "failed") {
      outcomes[item.id] = { receivedQuantity: 0, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: d };
    } else if (outcome === "rejected") {
      outcomes[item.id] = { receivedQuantity: 0, rejectedQuantity: d, returnedQuantity: 0, unresolvedQuantity: 0 };
    } else {
      const received = receivedByItem[item.id];
      if (received === undefined || !Number.isFinite(received) || received < 0 || received > d || !Number.isInteger(received * 1000)) {
        return { ok: false, error: "Jumlah diterima tidak valid untuk salah satu barang." };
      }
      outcomes[item.id] = { receivedQuantity: received, rejectedQuantity: 0, returnedQuantity: 0, unresolvedQuantity: d - received };
    }
  }
  if (outcome === "partial") {
    const totalReceived = Object.values(outcomes).reduce((s, o) => s + o.receivedQuantity, 0);
    const totalDispatched = items.reduce((s, i) => s + i.dispatchedQuantity, 0);
    if (totalReceived <= 0) return { ok: false, error: "Diterima sebagian harus ada barang yang diterima. Pilih Ditolak bila semua ditolak." };
    if (totalReceived >= totalDispatched) return { ok: false, error: "Semua barang diterima penuh. Pilih Diterima penuh." };
  }
  return { ok: true, outcomes };
}

/** Path bukti harus berada di folder company+delivery ini (cegah memakai file milik pengiriman/tenant lain). */
export function isEvidencePathForDelivery(path: string, companyId: string, deliveryId: string): boolean {
  return (
    typeof path === "string" &&
    path.startsWith(`${companyId}/${deliveryId}/`) &&
    !path.includes("..") &&
    path.length < 300
  );
}

export const REASON_LABEL_ID: Record<ReasonCode, string> = {
  STORE_CLOSED: "Toko tutup",
  CUSTOMER_PARTIAL_ACCEPTANCE: "Toko hanya menerima sebagian",
  CUSTOMER_REJECTED: "Toko menolak barang",
  ITEM_DAMAGED: "Barang rusak",
  ITEM_MISMATCH: "Barang tidak sesuai pesanan",
  QUANTITY_MISMATCH: "Jumlah tidak sesuai pesanan",
  PRICE_OR_DISCOUNT_DISPUTE: "Sengketa harga/diskon",
  RECIPIENT_NOT_AUTHORIZED: "Penerima tidak berwenang",
  ADDRESS_NOT_FOUND: "Alamat tidak ditemukan",
  VEHICLE_OR_DRIVER_ISSUE: "Kendala kendaraan/pengantar",
  OTHER_REQUIRES_NOTE: "Lainnya (wajib catatan)",
};
