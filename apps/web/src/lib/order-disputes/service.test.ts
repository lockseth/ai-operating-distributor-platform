import { describe, it, expect } from "vitest";
import {
  classifyRequest,
  mapResolutionToStatus,
  resolutionCancelsOrder,
  validateCreateDisputeInput,
  requiresOwnerAlertForDispute,
} from "./service";

describe("classifyRequest", () => {
  it("CUSTOMER_CANCELLED + NOT_DISPATCHED -> AUTO_CANCEL_SAFE, auto cancel", () => {
    const r = classifyRequest("CUSTOMER_CANCELLED", "NOT_DISPATCHED");
    expect(r).toEqual({ aiClassification: "AUTO_CANCEL_SAFE", initialStatus: "APPROVED", autoCancel: true });
  });

  it("CUSTOMER_CANCELLED + IN_DISPATCH_PLAN_NOT_DEPARTED -> NEEDS_REVIEW, tidak auto", () => {
    const r = classifyRequest("CUSTOMER_CANCELLED", "IN_DISPATCH_PLAN_NOT_DEPARTED");
    expect(r).toEqual({ aiClassification: "NEEDS_REVIEW", initialStatus: "REQUESTED", autoCancel: false });
  });

  it.each(["DEPARTED_IN_TRANSIT", "RECEIVED_PARTIAL", "RECEIVED_FULL", "DEPARTED_TERMINAL_OTHER"] as const)(
    "CUSTOMER_CANCELLED + %s -> HOLD_AND_ALERT, tidak auto",
    (stage) => {
      const r = classifyRequest("CUSTOMER_CANCELLED", stage);
      expect(r).toEqual({ aiClassification: "HOLD_AND_ALERT", initialStatus: "ON_HOLD", autoCancel: false });
    }
  );

  it.each(["NOT_DISPATCHED", "IN_DISPATCH_PLAN_NOT_DEPARTED", "DEPARTED_IN_TRANSIT", "RECEIVED_PARTIAL", "RECEIVED_FULL"] as const)(
    "CUSTOMER_DENIES_ORDER + %s -> selalu HOLD_AND_ALERT, tidak pernah auto (wajib Human Review)",
    (stage) => {
      const r = classifyRequest("CUSTOMER_DENIES_ORDER", stage);
      expect(r.aiClassification).toBe("HOLD_AND_ALERT");
      expect(r.autoCancel).toBe(false);
      expect(r.initialStatus).toBe("ON_HOLD");
    }
  );
});

describe("mapResolutionToStatus / resolutionCancelsOrder", () => {
  it("CANCEL_APPROVED -> APPROVED, cancels order", () => {
    expect(mapResolutionToStatus("CANCEL_APPROVED")).toBe("APPROVED");
    expect(resolutionCancelsOrder("CANCEL_APPROVED")).toBe(true);
  });
  it("CANCEL_REJECTED -> REJECTED, tidak cancel order", () => {
    expect(mapResolutionToStatus("CANCEL_REJECTED")).toBe("REJECTED");
    expect(resolutionCancelsOrder("CANCEL_REJECTED")).toBe(false);
  });
  it("CANCELLED_NOT_ORDERED -> RESOLVED, cancels order", () => {
    expect(mapResolutionToStatus("CANCELLED_NOT_ORDERED")).toBe("RESOLVED");
    expect(resolutionCancelsOrder("CANCELLED_NOT_ORDERED")).toBe(true);
  });
  it("ORDERED_BY_ANOTHER_PIC -> RESOLVED, tidak cancel order (order tetap jalan)", () => {
    expect(mapResolutionToStatus("ORDERED_BY_ANOTHER_PIC")).toBe("RESOLVED");
    expect(resolutionCancelsOrder("ORDERED_BY_ANOTHER_PIC")).toBe(false);
  });
  it("KEPT_ON_HOLD -> ON_HOLD, tidak cancel order", () => {
    expect(mapResolutionToStatus("KEPT_ON_HOLD")).toBe("ON_HOLD");
    expect(resolutionCancelsOrder("KEPT_ON_HOLD")).toBe(false);
  });
});

describe("validateCreateDisputeInput", () => {
  it("reason kosong ditolak", () => {
    expect(validateCreateDisputeInput({ reasonCode: "", notes: null, contactSource: "OTHER" })).not.toBeNull();
  });
  it("OTHER_REQUIRES_NOTE tanpa catatan ditolak", () => {
    expect(
      validateCreateDisputeInput({ reasonCode: "OTHER_REQUIRES_NOTE", notes: null, contactSource: "OTHER" })
    ).not.toBeNull();
    expect(
      validateCreateDisputeInput({ reasonCode: "OTHER_REQUIRES_NOTE", notes: "  ", contactSource: "OTHER" })
    ).not.toBeNull();
  });
  it("OTHER_REQUIRES_NOTE dengan catatan valid", () => {
    expect(
      validateCreateDisputeInput({ reasonCode: "OTHER_REQUIRES_NOTE", notes: "alasan lengkap", contactSource: "OTHER" })
    ).toBeNull();
  });
  it("reason biasa tanpa catatan valid", () => {
    expect(validateCreateDisputeInput({ reasonCode: "CHANGE_OF_MIND", notes: null, contactSource: "CUSTOMER_WHATSAPP" })).toBeNull();
  });
});

describe("requiresOwnerAlertForDispute", () => {
  const base = {
    requestType: "CUSTOMER_CANCELLED" as const,
    orderStage: "NOT_DISPATCHED" as const,
    orderValue: 100_000,
    highValueThreshold: null,
    recentDisputeCountForCustomer: 0,
    picChangedDuringDispute: false,
  };

  it("CUSTOMER_DENIES_ORDER selalu alert", () => {
    expect(requiresOwnerAlertForDispute({ ...base, requestType: "CUSTOMER_DENIES_ORDER" })).toBe(true);
  });

  it("CUSTOMER_CANCELLED sebelum dispatch tidak alert (kondisi aman default)", () => {
    expect(requiresOwnerAlertForDispute(base)).toBe(false);
  });

  it("CUSTOMER_CANCELLED setelah dispatch -> alert", () => {
    expect(requiresOwnerAlertForDispute({ ...base, orderStage: "DEPARTED_IN_TRANSIT" })).toBe(true);
  });

  it("order bernilai besar (melewati threshold tenant) -> alert, tanpa hardcode nominal", () => {
    expect(requiresOwnerAlertForDispute({ ...base, orderValue: 5_000_000, highValueThreshold: 3_000_000 })).toBe(true);
    expect(requiresOwnerAlertForDispute({ ...base, orderValue: 1_000_000, highValueThreshold: 3_000_000 })).toBe(false);
  });

  it("tenant tanpa threshold (null) tidak pernah alert karena nominal", () => {
    expect(requiresOwnerAlertForDispute({ ...base, orderValue: 999_999_999, highValueThreshold: null })).toBe(false);
  });

  it("pola dispute berulang (>=2) -> alert", () => {
    expect(requiresOwnerAlertForDispute({ ...base, recentDisputeCountForCustomer: 2 })).toBe(true);
    expect(requiresOwnerAlertForDispute({ ...base, recentDisputeCountForCustomer: 1 })).toBe(false);
  });

  it("perubahan PIC bersamaan dispute -> alert", () => {
    expect(requiresOwnerAlertForDispute({ ...base, picChangedDuringDispute: true })).toBe(true);
  });
});
