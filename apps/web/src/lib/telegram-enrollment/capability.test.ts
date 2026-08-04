import { describe, expect, it } from "vitest";
import {
  hasTelegramCapability,
  TELEGRAM_PAIRING_ELIGIBLE_ROLES,
} from "./capability";

describe("Gate 3E-D1-R1: hasTelegramCapability (fail-closed)", () => {
  it("password.reset.self mengizinkan owner, admin, dan sales", () => {
    expect(hasTelegramCapability(["owner"], "password.reset.self")).toBe(true);
    expect(hasTelegramCapability(["admin"], "password.reset.self")).toBe(true);
    expect(hasTelegramCapability(["sales"], "password.reset.self")).toBe(true);
  });

  it("sales.order.telegram HANYA mengizinkan sales -- owner/admin ditolak meski paired", () => {
    expect(hasTelegramCapability(["sales"], "sales.order.telegram")).toBe(true);
    expect(hasTelegramCapability(["owner"], "sales.order.telegram")).toBe(false);
    expect(hasTelegramCapability(["admin"], "sales.order.telegram")).toBe(false);
  });

  it("fail-closed: role kosong/null/undefined selalu ditolak, tidak pernah default mengizinkan", () => {
    expect(hasTelegramCapability([], "password.reset.self")).toBe(false);
    expect(hasTelegramCapability(null, "password.reset.self")).toBe(false);
    expect(hasTelegramCapability(undefined, "password.reset.self")).toBe(false);
  });

  it("fail-closed: role tidak dikenal (mis. role dihapus/di-rename) ditolak, bukan lolos default", () => {
    expect(hasTelegramCapability(["some_unknown_role"], "password.reset.self")).toBe(
      false,
    );
    expect(hasTelegramCapability(["super_admin"], "sales.order.telegram")).toBe(
      false,
    );
  });

  it("multi-role: cukup salah satu role user yang eligible untuk lolos", () => {
    expect(
      hasTelegramCapability(["manager", "sales"], "sales.order.telegram"),
    ).toBe(true);
    expect(
      hasTelegramCapability(["manager", "owner"], "sales.order.telegram"),
    ).toBe(false);
  });

  it("TELEGRAM_PAIRING_ELIGIBLE_ROLES persis {owner, admin, sales} -- sumber kebenaran generalisasi Gate 3E-D1-R1", () => {
    expect([...TELEGRAM_PAIRING_ELIGIBLE_ROLES].sort()).toEqual([
      "admin",
      "owner",
      "sales",
    ]);
  });
});
