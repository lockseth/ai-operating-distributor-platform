import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyCronSecret } from "./cron";

describe("verifyCronSecret", () => {
  const originalSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret";
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
  });

  it("header cocok persis -> true", () => {
    const req = new Request("https://example.com/api/cron/x", {
      headers: { authorization: "Bearer test-cron-secret" },
    });
    expect(verifyCronSecret(req)).toBe(true);
  });

  it("header salah -> false", () => {
    const req = new Request("https://example.com/api/cron/x", {
      headers: { authorization: "Bearer salah" },
    });
    expect(verifyCronSecret(req)).toBe(false);
  });

  it("tidak ada header -> false", () => {
    const req = new Request("https://example.com/api/cron/x");
    expect(verifyCronSecret(req)).toBe(false);
  });

  it("CRON_SECRET belum diset di environment -> selalu false (fail closed)", () => {
    delete process.env.CRON_SECRET;
    const req = new Request("https://example.com/api/cron/x", {
      headers: { authorization: "Bearer apapun" },
    });
    expect(verifyCronSecret(req)).toBe(false);
  });
});
