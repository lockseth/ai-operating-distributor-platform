// =============================================================================
// Automation Engine -- test terisolasi untuk action "call_bablast" (notifikasi
// WA real-time ke Owner). Fokus: (1) susun teks pesan per trigger_type benar,
// (2) pagar keamanan (dry-run gate + resolveWhatsAppTarget override) BENAR
// dipanggil sebelum kirim nyata -- ini regression test paling penting, bukan
// cuma happy path (lihat insiden 2026-08-22 di dispatch-target.ts).
// =============================================================================

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AutomationEvent, AutomationRule } from "./types";

const findActiveOwnerRecipient = vi.fn();
vi.mock("@/lib/n8n-automation/salesman-directory", () => ({
  SupabaseSalesmanDirectory: vi.fn().mockImplementation(() => ({
    findActiveOwnerRecipient,
  })),
}));

const isBablastLiveSendEnabled = vi.fn();
const sendBablastMessage = vi.fn();
vi.mock("@/lib/integrations/bablast", () => ({
  isBablastLiveSendEnabled: (...args: unknown[]) => isBablastLiveSendEnabled(...args),
  normalizeIndonesianPhone: (raw: string) => {
    let digits = raw.replace(/[^0-9]/g, "");
    if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
    return digits.length >= 10 ? digits : null;
  },
  sendBablastMessage: (...args: unknown[]) => sendBablastMessage(...args),
}));

const resolveWhatsAppTarget = vi.fn((phone: string) => phone);
vi.mock("@/lib/n8n-automation/dispatch-target", () => ({
  resolveWhatsAppTarget: (...args: [string]) => resolveWhatsAppTarget(...args),
}));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: vi.fn(() => ({})),
}));

function buildEvent(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  return {
    trigger_type: "special_price_proposal_submitted",
    company_id: "company-1",
    data: {
      order_number: "SO-001",
      customer_name: "Toko Sumber Rejeki",
      requested_by_email: "sales@aodp.test",
      reason: "Pelanggan lama",
      approval_link: "https://aodp.example/dashboard/orders/approvals",
    },
    fired_at: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

const dummyRule: AutomationRule = {
  id: "rule-1",
  company_id: "company-1",
  name: "notify owner via whatsapp",
  description: null,
  trigger_type: "special_price_proposal_submitted",
  trigger_config: {},
  conditions: [],
  actions: [{ type: "call_bablast" }],
  is_active: true,
  priority: 0,
  run_count: 0,
  last_run_at: null,
};

describe("executeAction -- call_bablast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWhatsAppTarget.mockImplementation((phone: string) => phone);
  });

  it("Owner belum punya nomor WA -> skipped, TIDAK pernah panggil sendBablastMessage", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: null });
    const { executeAction } = await import("./engine");

    const result = await executeAction({ type: "call_bablast" }, buildEvent(), dummyRule);

    expect(result.status).toBe("skipped");
    expect(sendBablastMessage).not.toHaveBeenCalled();
  });

  it("BABLAST_DRY_RUN aktif (isBablastLiveSendEnabled false) -> skipped, TIDAK pernah panggil sendBablastMessage", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: "087778404085" });
    isBablastLiveSendEnabled.mockReturnValue(false);
    const { executeAction } = await import("./engine");

    const result = await executeAction({ type: "call_bablast" }, buildEvent(), dummyRule);

    expect(result.status).toBe("skipped");
    expect(sendBablastMessage).not.toHaveBeenCalled();
  });

  it("live send aktif -> resolveWhatsAppTarget WAJIB dipanggil sebelum sendBablastMessage (pagar keamanan)", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: "087778404085" });
    isBablastLiveSendEnabled.mockReturnValue(true);
    sendBablastMessage.mockResolvedValue({ providerMessageId: null, raw: {} });
    const { executeAction } = await import("./engine");

    const result = await executeAction({ type: "call_bablast" }, buildEvent(), dummyRule);

    expect(result.status).toBe("success");
    expect(resolveWhatsAppTarget).toHaveBeenCalledWith("6287778404085");
    expect(sendBablastMessage).toHaveBeenCalledTimes(1);
    const [targetArg] = sendBablastMessage.mock.calls[0] as [string, string];
    expect(targetArg).toBe("6287778404085");
  });

  it("override test-phone aktif -> nomor override yang benar-benar dipakai kirim, BUKAN nomor Owner asli", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: "087778404085" });
    isBablastLiveSendEnabled.mockReturnValue(true);
    sendBablastMessage.mockResolvedValue({ providerMessageId: null, raw: {} });
    resolveWhatsAppTarget.mockImplementation(() => "6283823034645"); // simulasi override aktif
    const { executeAction } = await import("./engine");

    await executeAction({ type: "call_bablast" }, buildEvent(), dummyRule);

    const [targetArg] = sendBablastMessage.mock.calls[0] as [string, string];
    expect(targetArg).toBe("6283823034645");
    expect(targetArg).not.toBe("6287778404085");
  });

  it("sendBablastMessage melempar error -> status failed, bukan exception tidak tertangani", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: "087778404085" });
    isBablastLiveSendEnabled.mockReturnValue(true);
    sendBablastMessage.mockRejectedValue(new Error("Bablast /send gagal (500)"));
    const { executeAction } = await import("./engine");

    const result = await executeAction({ type: "call_bablast" }, buildEvent(), dummyRule);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Bablast /send gagal");
  });

  it("teks pesan special_price_proposal_submitted memuat order, toko, dan link approval", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: "087778404085" });
    isBablastLiveSendEnabled.mockReturnValue(true);
    sendBablastMessage.mockResolvedValue({ providerMessageId: null, raw: {} });
    const { executeAction } = await import("./engine");

    await executeAction({ type: "call_bablast" }, buildEvent(), dummyRule);

    const [, textArg] = sendBablastMessage.mock.calls[0] as [string, string];
    expect(textArg).toContain("SO-001");
    expect(textArg).toContain("Toko Sumber Rejeki");
    expect(textArg).toContain("https://aodp.example/dashboard/orders/approvals");
  });

  it("teks pesan store_unlock_requested memuat toko dan link review", async () => {
    findActiveOwnerRecipient.mockResolvedValue({ userId: "u1", fullName: "Owner", phone: "087778404085" });
    isBablastLiveSendEnabled.mockReturnValue(true);
    sendBablastMessage.mockResolvedValue({ providerMessageId: null, raw: {} });
    const { executeAction } = await import("./engine");

    await executeAction(
      { type: "call_bablast" },
      buildEvent({
        trigger_type: "store_unlock_requested",
        data: {
          customer_name: "Toko Makmur Jaya",
          requested_by_email: "sales@aodp.test",
          reason: "Sudah bayar sebagian",
          review_link: "https://aodp.example/dashboard/customers/unlock-requests",
        },
      }),
      dummyRule,
    );

    const [, textArg] = sendBablastMessage.mock.calls[0] as [string, string];
    expect(textArg).toContain("Toko Makmur Jaya");
    expect(textArg).toContain("https://aodp.example/dashboard/customers/unlock-requests");
  });
});
