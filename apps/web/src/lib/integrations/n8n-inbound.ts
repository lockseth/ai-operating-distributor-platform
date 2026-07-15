// =============================================================================
// n8n Inbound Webhook — credential resolution + event processing.
//
// Route ini SENGAJA tipis (lihat apps/web/src/app/api/webhooks/n8n/route.ts).
// Seluruh identity resolution & tenant-scoping ada di sini supaya bisa diuji
// tanpa Supabase (lihat n8n-inbound.test.ts, memakai InMemoryN8nInboundRepository).
//
// PRINSIP KUNCI: company_id SELALU berasal dari credential yang di-resolve
// server-side lewat hash lookup, TIDAK PERNAH dari field company_id di
// payload. Jika payload membawa company_id yang berbeda dari credential,
// request ditolak (tenant mismatch) — bukan diam-diam ditimpa/diabaikan.
// =============================================================================

import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function hashN8nCredential(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) return null;
  const token = authorizationHeader.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

export interface N8nCredentialRecord {
  id: string;
  companyId: string;
  scope: string[];
  status: "active" | "revoked";
}

export interface N8nInboundRepository {
  /** Hanya mengembalikan credential dengan status 'active'. Revoked/tidak ditemukan -> null. */
  findActiveCredentialByHash(hash: string): Promise<N8nCredentialRecord | null>;
  companyExists(companyId: string): Promise<boolean>;
  /** isNew=false berarti (credentialId, eventId) ini sudah pernah tercatat -> duplicate, jangan proses ulang. */
  recordEvent(input: {
    credentialId: string;
    companyId: string;
    eventId: string;
    eventType: string;
  }): Promise<{ isNew: boolean }>;
  insertAutomationLog(input: {
    companyId: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<void>;
}

export interface InboundN8nPayload {
  event_id?: unknown;
  event_type?: unknown;
  company_id?: unknown;
  data?: unknown;
}

export type N8nInboundOutcome =
  | "unauthorized"
  | "invalid_body"
  | "tenant_mismatch"
  | "scope_denied"
  | "duplicate_event"
  | "accepted";

export interface N8nInboundResult {
  outcome: N8nInboundOutcome;
  companyId?: string;
  eventType?: string;
}

export async function processN8nInboundEvent(
  authorizationHeader: string | null,
  rawBody: string,
  repository: N8nInboundRepository
): Promise<N8nInboundResult> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) return { outcome: "unauthorized" };

  const credential = await repository.findActiveCredentialByHash(hashN8nCredential(token));
  if (!credential) return { outcome: "unauthorized" };

  let body: InboundN8nPayload;
  try {
    body = JSON.parse(rawBody) as InboundN8nPayload;
  } catch {
    return { outcome: "invalid_body" };
  }

  if (typeof body.event_id !== "string" || body.event_id.trim() === "") {
    return { outcome: "invalid_body" };
  }
  if (typeof body.event_type !== "string" || body.event_type.trim() === "") {
    return { outcome: "invalid_body" };
  }

  // company_id di payload TIDAK PERNAH dipakai sebagai sumber kebenaran —
  // kalau ada, hanya dicocokkan untuk mendeteksi n8n workflow yang salah
  // konfigurasi atau upaya menulis ke tenant lain (spoofing).
  if (typeof body.company_id === "string" && body.company_id !== credential.companyId) {
    return { outcome: "tenant_mismatch" };
  }

  // Scope kosong = tidak ada event yang diizinkan (fail closed).
  if (!credential.scope.includes(body.event_type)) {
    return { outcome: "scope_denied" };
  }

  const { isNew } = await repository.recordEvent({
    credentialId: credential.id,
    companyId: credential.companyId,
    eventId: body.event_id,
    eventType: body.event_type,
  });

  if (!isNew) {
    return { outcome: "duplicate_event", companyId: credential.companyId, eventType: body.event_type };
  }

  const exists = await repository.companyExists(credential.companyId);
  if (!exists) {
    // Kredensial mengarah ke company yang sudah tidak ada — tidak seharusnya
    // terjadi jika FK dijaga, tapi fail closed untuk jaga-jaga.
    return { outcome: "unauthorized" };
  }

  const data =
    body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};

  await repository.insertAutomationLog({
    companyId: credential.companyId,
    eventType: body.event_type,
    data,
  });

  return { outcome: "accepted", companyId: credential.companyId, eventType: body.event_type };
}

// ---------------------------------------------------------------------------
// Supabase-backed implementation
// ---------------------------------------------------------------------------

export class SupabaseN8nInboundRepository implements N8nInboundRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async findActiveCredentialByHash(hash: string): Promise<N8nCredentialRecord | null> {
    const { data } = await this.supabase
      .from("n8n_inbound_credentials")
      .select("id, company_id, scope, status")
      .eq("credential_hash", hash)
      .eq("status", "active")
      .maybeSingle();
    if (!data) return null;
    const row = data as { id: string; company_id: string; scope: string[] | null; status: "active" | "revoked" };
    return {
      id: row.id,
      companyId: row.company_id,
      scope: row.scope ?? [],
      status: row.status,
    };
  }

  async companyExists(companyId: string): Promise<boolean> {
    const { data } = await this.supabase.from("companies").select("id").eq("id", companyId).maybeSingle();
    return !!data;
  }

  async recordEvent(input: {
    credentialId: string;
    companyId: string;
    eventId: string;
    eventType: string;
  }): Promise<{ isNew: boolean }> {
    const { error } = await this.supabase.from("n8n_inbound_events").insert({
      credential_id: input.credentialId,
      company_id: input.companyId,
      event_id: input.eventId,
      event_type: input.eventType,
    });
    if (error) {
      // 23505 = unique_violation -> (credential_id, event_id) sudah pernah tercatat.
      if (error.code === "23505") return { isNew: false };
      throw new Error(`recordEvent failed: ${error.message}`);
    }
    return { isNew: true };
  }

  async insertAutomationLog(input: {
    companyId: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    await this.supabase.from("automation_logs").insert({
      company_id: input.companyId,
      rule_id: null,
      rule_name: "n8n Inbound",
      trigger_type: "manual",
      trigger_data: {
        source: "n8n",
        event_type: input.eventType,
        ...input.data,
      },
      status: "success",
      actions_executed: [
        { type: "inbound_webhook", status: "success", message: `Event '${input.eventType}' diterima dari n8n` },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation — untuk test (mencakup seluruh skenario tanpa
// memerlukan Supabase hidup).
// ---------------------------------------------------------------------------

interface StoredCredential extends N8nCredentialRecord {
  hash: string;
}

export class InMemoryN8nInboundRepository implements N8nInboundRepository {
  private credentials: StoredCredential[] = [];
  private companies = new Set<string>();
  private events = new Set<string>(); // key = `${credentialId}:${eventId}`
  public automationLogs: { companyId: string; eventType: string; data: Record<string, unknown> }[] = [];

  seedCompany(companyId: string): void {
    this.companies.add(companyId);
  }

  seedCredential(input: {
    id: string;
    companyId: string;
    rawToken: string;
    scope: string[];
    status?: "active" | "revoked";
  }): void {
    this.companies.add(input.companyId);
    this.credentials.push({
      id: input.id,
      companyId: input.companyId,
      scope: input.scope,
      status: input.status ?? "active",
      hash: hashN8nCredential(input.rawToken),
    });
  }

  async findActiveCredentialByHash(hash: string): Promise<N8nCredentialRecord | null> {
    const found = this.credentials.find((c) => c.hash === hash && c.status === "active");
    return found ? { id: found.id, companyId: found.companyId, scope: found.scope, status: found.status } : null;
  }

  async companyExists(companyId: string): Promise<boolean> {
    return this.companies.has(companyId);
  }

  async recordEvent(input: {
    credentialId: string;
    companyId: string;
    eventId: string;
    eventType: string;
  }): Promise<{ isNew: boolean }> {
    const key = `${input.credentialId}:${input.eventId}`;
    if (this.events.has(key)) return { isNew: false };
    this.events.add(key);
    return { isNew: true };
  }

  async insertAutomationLog(input: {
    companyId: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    this.automationLogs.push(input);
  }
}
