// =============================================================================
// Aturan murni alur pengiriman versi web (tanpa Telegram). Lihat
// docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md.
// Tanpa I/O supaya mudah diuji; dipakai web-actions.ts dan halaman Pengiriman.
// =============================================================================

import type { DeliveryEvidenceInput, DeliveryStatus } from "./types";

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
