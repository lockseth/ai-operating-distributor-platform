import { describe, it, expect } from "vitest";
import {
  isEffectiveVisit,
  isValidLatitude,
  isValidLongitude,
  validateCompleteVisitInput,
  validateStartVisitInput,
} from "./service";

describe("Gate 3E-D5-B -- sales-visits validation", () => {
  describe("validateStartVisitInput", () => {
    it("customer wajib dipilih", () => {
      expect(
        validateStartVisitInput({
          customerId: "",
          visitPurpose: "OFFER_PRODUCT",
          planNotes: "",
          startLatitude: -6.2,
          startLongitude: 106.8,
        }),
      ).toBe("customer_required");
    });

    it("tujuan kunjungan harus salah satu enum resmi", () => {
      expect(
        validateStartVisitInput({
          customerId: "c1",
          visitPurpose: "SOMETHING_ELSE",
          planNotes: "",
          startLatitude: -6.2,
          startLongitude: 106.8,
        }),
      ).toBe("invalid_purpose");
    });

    it("lokasi wajib berupa lat/lng valid", () => {
      expect(
        validateStartVisitInput({
          customerId: "c1",
          visitPurpose: "OFFER_PRODUCT",
          planNotes: "",
          startLatitude: null,
          startLongitude: 106.8,
        }),
      ).toBe("invalid_location");
      expect(
        validateStartVisitInput({
          customerId: "c1",
          visitPurpose: "OFFER_PRODUCT",
          planNotes: "",
          startLatitude: 999,
          startLongitude: 106.8,
        }),
      ).toBe("invalid_location");
    });

    it("input lengkap dan valid lolos", () => {
      expect(
        validateStartVisitInput({
          customerId: "c1",
          visitPurpose: "OFFER_PRODUCT",
          planNotes: "",
          startLatitude: -6.2,
          startLongitude: 106.8,
        }),
      ).toBeNull();
    });
  });

  describe("validateCompleteVisitInput", () => {
    const base = {
      visitResult: "MET_STORE",
      metWith: "OWNER",
      activities: ["OFFER_PRODUCT"],
      resultNotes: "Toko ramai, minat besar",
      followUpNeeded: false,
      followUpPlan: null,
      followUpDate: null,
      endLatitude: -6.2,
      endLongitude: 106.8,
    };

    it("met_with wajib bila hasil MET_STORE", () => {
      expect(
        validateCompleteVisitInput({ ...base, metWith: null }),
      ).toBe("met_with_required");
    });

    it("met_with tidak wajib bila hasil bukan MET_STORE", () => {
      expect(
        validateCompleteVisitInput({
          ...base,
          visitResult: "STORE_CLOSED",
          metWith: null,
          activities: [],
        }),
      ).toBeNull();
    });

    it("catatan hasil wajib minimal 3 karakter", () => {
      expect(
        validateCompleteVisitInput({ ...base, resultNotes: "ok" }),
      ).toBe("result_notes_required");
    });

    it("follow up wajib rencana + tanggal bila follow_up_needed", () => {
      expect(
        validateCompleteVisitInput({
          ...base,
          followUpNeeded: true,
          followUpPlan: null,
          followUpDate: null,
        }),
      ).toBe("follow_up_required");
      expect(
        validateCompleteVisitInput({
          ...base,
          followUpNeeded: true,
          followUpPlan: "Follow up minggu depan",
          followUpDate: "2026-10-10",
        }),
      ).toBeNull();
    });

    it("aktivitas di luar enum resmi ditolak", () => {
      expect(
        validateCompleteVisitInput({ ...base, activities: ["BOGUS"] }),
      ).toBe("invalid_activity");
    });

    it("lokasi akhir wajib valid", () => {
      expect(
        validateCompleteVisitInput({ ...base, endLatitude: null }),
      ).toBe("invalid_location");
    });
  });

  describe("isEffectiveVisit -- matriks CALL/EC", () => {
    it("MET_STORE + met_with + aktivitas substantif -> efektif", () => {
      expect(isEffectiveVisit("MET_STORE", "OWNER", ["OFFER_PRODUCT"])).toBe(true);
    });
    it("MET_STORE tanpa aktivitas -> tidak efektif", () => {
      expect(isEffectiveVisit("MET_STORE", "OWNER", [])).toBe(false);
    });
    it("bukan MET_STORE -> tidak pernah efektif walau ada aktivitas", () => {
      expect(isEffectiveVisit("STORE_CLOSED", null, ["OFFER_PRODUCT"])).toBe(false);
    });
    it("VISIT_CANCELLED -> tidak efektif", () => {
      expect(isEffectiveVisit("VISIT_CANCELLED", null, [])).toBe(false);
    });
  });

  describe("isValidLatitude/isValidLongitude", () => {
    it("menolak nilai di luar rentang", () => {
      expect(isValidLatitude(91)).toBe(false);
      expect(isValidLatitude(-91)).toBe(false);
      expect(isValidLongitude(181)).toBe(false);
      expect(isValidLongitude(-181)).toBe(false);
    });
    it("menerima nilai wajar", () => {
      expect(isValidLatitude(-6.2)).toBe(true);
      expect(isValidLongitude(106.8)).toBe(true);
    });
  });
});
