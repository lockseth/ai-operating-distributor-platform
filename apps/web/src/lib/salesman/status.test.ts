import { describe, it, expect } from "vitest";
import { resolveSalesmanTelegramStatus } from "./status";

const NOW = new Date("2026-07-17T10:00:00Z");

describe("resolveSalesmanTelegramStatus", () => {
  it("Belum Terhubung: tidak ada identity aktif, tidak ada token pending, tidak pernah connect", () => {
    expect(
      resolveSalesmanTelegramStatus({
        hasActiveIdentity: false,
        hadPreviousIdentity: false,
        pendingToken: null,
        now: NOW,
      })
    ).toBe("not_connected");
  });

  it("Pairing Code Aktif: token pending belum kedaluwarsa, belum diklaim/dicabut", () => {
    expect(
      resolveSalesmanTelegramStatus({
        hasActiveIdentity: false,
        hadPreviousIdentity: false,
        pendingToken: {
          expiresAt: "2026-07-17T10:30:00Z",
          claimedAt: null,
          revokedAt: null,
        },
        now: NOW,
      })
    ).toBe("pairing_active");
  });

  it("Pairing Kedaluwarsa: token pending sudah lewat expires_at", () => {
    expect(
      resolveSalesmanTelegramStatus({
        hasActiveIdentity: false,
        hadPreviousIdentity: false,
        pendingToken: {
          expiresAt: "2026-07-17T09:00:00Z",
          claimedAt: null,
          revokedAt: null,
        },
        now: NOW,
      })
    ).toBe("pairing_expired");
  });

  it("Terhubung: ada identity aktif (mengalahkan status token apa pun)", () => {
    expect(
      resolveSalesmanTelegramStatus({
        hasActiveIdentity: true,
        hadPreviousIdentity: false,
        pendingToken: {
          expiresAt: "2026-07-17T09:00:00Z",
          claimedAt: null,
          revokedAt: null,
        },
        now: NOW,
      })
    ).toBe("connected");
  });

  it("Diputuskan/Dicabut: tidak ada identity aktif tapi pernah ada identity sebelumnya", () => {
    expect(
      resolveSalesmanTelegramStatus({
        hasActiveIdentity: false,
        hadPreviousIdentity: true,
        pendingToken: null,
        now: NOW,
      })
    ).toBe("disconnected");
  });

  it("token yang sudah diklaim atau dicabut tidak dihitung sebagai pending", () => {
    expect(
      resolveSalesmanTelegramStatus({
        hasActiveIdentity: false,
        hadPreviousIdentity: true,
        pendingToken: {
          expiresAt: "2026-07-17T10:30:00Z",
          claimedAt: "2026-07-17T09:30:00Z",
          revokedAt: null,
        },
        now: NOW,
      })
    ).toBe("disconnected");
  });
});
