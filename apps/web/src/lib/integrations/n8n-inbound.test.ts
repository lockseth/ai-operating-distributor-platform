// =============================================================================
// Test — n8n inbound webhook credential resolution & tenant isolation.
// Seluruhnya via InMemoryN8nInboundRepository — tidak butuh Supabase hidup.
// =============================================================================

import { describe, it, expect } from "vitest";
import { processN8nInboundEvent, InMemoryN8nInboundRepository } from "./n8n-inbound";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const TOKEN_A = "raw-token-company-a-xxxxxxxxxxxxxxxx";
const TOKEN_B = "raw-token-company-b-yyyyyyyyyyyyyyyy";

function makeRepo() {
  const repo = new InMemoryN8nInboundRepository();
  repo.seedCompany(COMPANY_A);
  repo.seedCompany(COMPANY_B);
  repo.seedCredential({ id: "cred-a", companyId: COMPANY_A, rawToken: TOKEN_A, scope: ["order_status_sync"] });
  repo.seedCredential({ id: "cred-b", companyId: COMPANY_B, rawToken: TOKEN_B, scope: ["order_status_sync"] });
  return repo;
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function body(input: Record<string, unknown>): string {
  return JSON.stringify({ event_id: "evt-1", event_type: "order_status_sync", data: {}, ...input });
}

describe("n8n inbound webhook — credential auth & tenant isolation", () => {
  it("1. request tanpa credential -> ditolak (unauthorized)", async () => {
    const repo = makeRepo();
    const result = await processN8nInboundEvent(null, body({}), repo);
    expect(result.outcome).toBe("unauthorized");
    expect(repo.automationLogs).toHaveLength(0);
  });

  it("2. credential salah -> ditolak (unauthorized)", async () => {
    const repo = makeRepo();
    const result = await processN8nInboundEvent(bearer("token-yang-tidak-pernah-terdaftar"), body({}), repo);
    expect(result.outcome).toBe("unauthorized");
    expect(repo.automationLogs).toHaveLength(0);
  });

  it("3. credential revoked -> ditolak (unauthorized)", async () => {
    const repo = makeRepo();
    repo.seedCredential({
      id: "cred-revoked",
      companyId: COMPANY_A,
      rawToken: "revoked-token",
      scope: ["order_status_sync"],
      status: "revoked",
    });
    const result = await processN8nInboundEvent(bearer("revoked-token"), body({}), repo);
    expect(result.outcome).toBe("unauthorized");
    expect(repo.automationLogs).toHaveLength(0);
  });

  it("4. credential company A tidak dapat menulis ke company B (payload company_id B ditolak)", async () => {
    const repo = makeRepo();
    const result = await processN8nInboundEvent(bearer(TOKEN_A), body({ company_id: COMPANY_B }), repo);
    expect(result.outcome).toBe("tenant_mismatch");
    expect(repo.automationLogs).toHaveLength(0);
  });

  it("5. company_id palsu di payload (perusahaan tidak dikenal) ditolak dengan aman", async () => {
    const repo = makeRepo();
    const result = await processN8nInboundEvent(bearer(TOKEN_A), body({ company_id: "company-tidak-ada" }), repo);
    expect(result.outcome).toBe("tenant_mismatch");
    expect(repo.automationLogs).toHaveLength(0);
  });

  it("6. request valid memakai company_id hasil server-side resolution, bukan payload", async () => {
    const repo = makeRepo();
    // payload tidak membawa company_id sama sekali — tetap harus resolve ke COMPANY_A dari credential.
    const result = await processN8nInboundEvent(bearer(TOKEN_A), body({}), repo);
    expect(result.outcome).toBe("accepted");
    expect(result.companyId).toBe(COMPANY_A);
    expect(repo.automationLogs).toHaveLength(1);
    expect(repo.automationLogs[0]!.companyId).toBe(COMPANY_A);
  });

  it("6b. request valid dengan payload company_id yang SAMA dengan credential -> diterima (bukan dianggap sumber kebenaran, hanya cocok)", async () => {
    const repo = makeRepo();
    const result = await processN8nInboundEvent(bearer(TOKEN_A), body({ company_id: COMPANY_A }), repo);
    expect(result.outcome).toBe("accepted");
    expect(result.companyId).toBe(COMPANY_A);
  });

  it("7. duplicate event_id (credential sama) -> tidak membuat automation_logs ganda", async () => {
    const repo = makeRepo();
    const first = await processN8nInboundEvent(bearer(TOKEN_A), body({ event_id: "evt-dup" }), repo);
    const second = await processN8nInboundEvent(bearer(TOKEN_A), body({ event_id: "evt-dup" }), repo);
    expect(first.outcome).toBe("accepted");
    expect(second.outcome).toBe("duplicate_event");
    expect(repo.automationLogs).toHaveLength(1);
  });

  it("7b. event_id sama tapi credential/tenant berbeda -> TIDAK dianggap duplicate (dedupe per-credential)", async () => {
    const repo = makeRepo();
    const a = await processN8nInboundEvent(bearer(TOKEN_A), body({ event_id: "evt-shared" }), repo);
    const b = await processN8nInboundEvent(bearer(TOKEN_B), body({ event_id: "evt-shared" }), repo);
    expect(a.outcome).toBe("accepted");
    expect(b.outcome).toBe("accepted");
    expect(repo.automationLogs).toHaveLength(2);
  });

  it("8. scope tidak mengizinkan event_type -> ditolak (scope_denied)", async () => {
    const repo = makeRepo();
    repo.seedCredential({ id: "cred-narrow", companyId: COMPANY_A, rawToken: "narrow-token", scope: ["daily_summary"] });
    const result = await processN8nInboundEvent(
      bearer("narrow-token"),
      body({ event_type: "order_status_sync" }),
      repo
    );
    expect(result.outcome).toBe("scope_denied");
    expect(repo.automationLogs).toHaveLength(0);
  });

  it("9. scope kosong -> fail closed, tidak ada event yang diizinkan", async () => {
    const repo = makeRepo();
    repo.seedCredential({ id: "cred-empty-scope", companyId: COMPANY_A, rawToken: "empty-scope-token", scope: [] });
    const result = await processN8nInboundEvent(bearer("empty-scope-token"), body({}), repo);
    expect(result.outcome).toBe("scope_denied");
  });

  it("10. body tanpa event_id / event_type -> invalid_body", async () => {
    const repo = makeRepo();
    const missingEventId = await processN8nInboundEvent(
      bearer(TOKEN_A),
      JSON.stringify({ event_type: "order_status_sync" }),
      repo
    );
    expect(missingEventId.outcome).toBe("invalid_body");

    const malformedJson = await processN8nInboundEvent(bearer(TOKEN_A), "{not json", repo);
    expect(malformedJson.outcome).toBe("invalid_body");
  });

  it("11. header Authorization bukan format 'Bearer <token>' -> unauthorized", async () => {
    const repo = makeRepo();
    const result = await processN8nInboundEvent(`Basic ${TOKEN_A}`, body({}), repo);
    expect(result.outcome).toBe("unauthorized");
  });
});
