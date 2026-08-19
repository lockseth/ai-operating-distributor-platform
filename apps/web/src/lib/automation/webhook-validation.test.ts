import { describe, it, expect } from "vitest";
import { validateWebhookInput, canManageWebhooks, type WebhookInput } from "./webhook-validation";

function input(overrides: Partial<WebhookInput> = {}): WebhookInput {
  return {
    name: "Bablast WA Notif",
    eventType: "special_price_proposal_submitted",
    webhookUrl: "https://n8n.example.com/webhook/abc123",
    ...overrides,
  };
}

describe("validateWebhookInput", () => {
  it("input valid -> null (tidak ada error)", () => {
    expect(validateWebhookInput(input())).toBeNull();
  });

  it("nama kosong -> error", () => {
    expect(validateWebhookInput(input({ name: "" }))).toBe("Nama webhook wajib diisi.");
  });

  it("nama cuma spasi -> error (di-trim dulu)", () => {
    expect(validateWebhookInput(input({ name: "   " }))).toBe("Nama webhook wajib diisi.");
  });

  it("event type kosong -> error", () => {
    expect(validateWebhookInput(input({ eventType: "" }))).toBe("Event type wajib dipilih.");
  });

  it("URL kosong -> error", () => {
    expect(validateWebhookInput(input({ webhookUrl: "" }))).toBe("URL webhook wajib diisi.");
  });

  it("URL format tidak valid -> error", () => {
    expect(validateWebhookInput(input({ webhookUrl: "bukan-url" }))).toBe("URL webhook tidak valid.");
  });

  it("URL http:// (bukan https) -> ditolak", () => {
    expect(validateWebhookInput(input({ webhookUrl: "http://n8n.example.com/webhook/abc" }))).toBe(
      "URL webhook wajib pakai https:// (bukan http://).",
    );
  });
});

describe("canManageWebhooks", () => {
  it("owner -> true", () => {
    expect(canManageWebhooks({ roles: ["owner"] })).toBe(true);
  });

  it("admin -> true", () => {
    expect(canManageWebhooks({ roles: ["admin"] })).toBe(true);
  });

  it("super_admin -> true", () => {
    expect(canManageWebhooks({ roles: ["super_admin"] })).toBe(true);
  });

  it("manager -> false (beda dari automation_rules, sesuai RLS nw_manage)", () => {
    expect(canManageWebhooks({ roles: ["manager"] })).toBe(false);
  });

  it("sales -> false", () => {
    expect(canManageWebhooks({ roles: ["sales"] })).toBe(false);
  });
});
