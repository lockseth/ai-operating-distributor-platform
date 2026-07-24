// =============================================================================
// Payment & Invoiced Status Integrity Containment Gate -- membuktikan
// TRANSITIONS di status-updater.tsx tidak lagi menawarkan "paid" maupun
// "invoiced" sebagai target transisi apa pun (UI tidak boleh merender tombol
// "Tandai Lunas" atau "Tagih"). Environment test repo ini Node-only
// (vitest.config.ts: environment "node", tidak ada
// jsdom/@testing-library/react) -- jadi pembuktian "tidak merender tombol"
// dilakukan lewat data murni yang menentukan rendering (TRANSITIONS),
// bukan render DOM, konsisten dengan pola test lain di repo ini.
// =============================================================================

import { describe, expect, it } from "vitest";
import { TRANSITIONS } from "./status-updater";

describe("Payment & Invoiced Status Integrity Containment -- status-updater TRANSITIONS", () => {
  it("tidak ada status apa pun yang menawarkan transisi ke 'paid'", () => {
    for (const [status, nextStatuses] of Object.entries(TRANSITIONS)) {
      expect(nextStatuses, `status "${status}" tidak boleh menawarkan transisi ke paid`).not.toContain("paid");
    }
  });

  it("tidak ada status apa pun yang menawarkan transisi ke 'invoiced'", () => {
    for (const [status, nextStatuses] of Object.entries(TRANSITIONS)) {
      expect(nextStatuses, `status "${status}" tidak boleh menawarkan transisi ke invoiced`).not.toContain("invoiced");
    }
  });

  it("delivered tidak lagi punya transisi apa pun (dulu delivered -> invoiced)", () => {
    expect(TRANSITIONS.delivered).toEqual([]);
  });

  it("invoiced tidak lagi punya transisi apa pun (dulu invoiced -> paid)", () => {
    expect(TRANSITIONS.invoiced).toEqual([]);
  });

  it("paid tetap tidak punya transisi keluar (dibekukan dua arah)", () => {
    expect(TRANSITIONS.paid).toEqual([]);
  });

  it("transisi legal non-payment/non-invoice lain tidak rusak", () => {
    expect(TRANSITIONS.draft).toEqual(["confirmed", "cancelled"]);
    expect(TRANSITIONS.confirmed).toEqual(["processing", "cancelled"]);
    expect(TRANSITIONS.processing).toEqual(["delivering", "cancelled"]);
    expect(TRANSITIONS.delivering).toEqual(["delivered"]);
    expect(TRANSITIONS.cancelled).toEqual([]);
  });
});
