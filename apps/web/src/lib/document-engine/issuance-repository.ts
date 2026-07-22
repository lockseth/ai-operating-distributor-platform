// =============================================================================
// Document Engine -- issuance repository. Lapisan tipis di atas RPC Postgres
// dari migration 20260812000001/20260812000002 (allocate_document_number,
// issue_delivery_note, record_issued_document, companies.legal_address/dst).
// TIDAK ADA business logic/kalkulasi di sini -- alokasi nomor, immutability,
// versioning, dan tenant-validation SUDAH ditegakkan atomic di database
// (lihat komentar migration). Lapisan ini murni pemetaan TS<->RPC + error
// taxonomy (DocumentSourceError), sama seperti repository-adapter.ts murni
// memetakan OrderReader/DeliveryReader ke OrderSource/DeliverySource.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { DocumentSourceError, type DocumentSourceErrorCode } from "./errors";

export type IssuedDocumentType = "PURCHASE_ORDER" | "DELIVERY_NOTE" | "INVOICE";

export interface CompanyProfile {
  companyId: string;
  /** companies.name -- nama legal canonical, NOT NULL sejak awal. */
  name: string;
  legalAddress: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  /** Kode tenant terstruktur untuk format nomor dokumen (mis. "SWAS"). */
  documentNumberPrefix: string | null;
  logoUrl: string | null;
}

/** Field yang wajib lengkap sebelum tenant dapat menerbitkan dokumen apa pun (Target 3). */
const REQUIRED_PROFILE_FIELDS = ["legalAddress", "contactEmail", "contactPhone", "documentNumberPrefix"] as const;

/**
 * Validasi kelengkapan profil di sisi TS -- SELAIN validasi yang sudah
 * ditegakkan atomic di database (validate_company_profile_complete(),
 * dipanggil issue_delivery_note()/allocate_document_number()). Dipanggil di
 * awal alur issuance PO/Invoice di issuance.ts SEBELUM query lain
 * (fail-fast), supaya caller tidak perlu menunggu round-trip RPC untuk
 * error yang sudah bisa dideteksi dari profil yang baru dibaca.
 */
export function assertCompanyProfileComplete(profile: CompanyProfile): void {
  const missing = REQUIRED_PROFILE_FIELDS.filter((field) => !profile[field] || profile[field]!.trim().length === 0);
  if (missing.length > 0) {
    throw new DocumentSourceError(
      "COMPANY_PROFILE_INCOMPLETE",
      `Company ${profile.companyId} belum memiliki profil legal lengkap untuk menerbitkan dokumen: ${missing.join(", ")}.`,
    );
  }
}

export interface RecordIssuedDocumentInput {
  companyId: string;
  documentType: IssuedDocumentType;
  /** WAJIB sesuai chk_issued_documents_source (migration) -- PURCHASE_ORDER: order saja; DELIVERY_NOTE: delivery saja; INVOICE: keduanya. */
  sourceOrderId: string | null;
  sourceDeliveryId: string | null;
  documentNumber: string;
  snapshot: Record<string, unknown>;
  issuedBy: string | null;
  /** Bila diisi: revisi dokumen aktif ini (version+1, dokumen lama ditandai superseded). NULL untuk penerbitan pertama. */
  supersedesDocumentId: string | null;
}

export interface IssuedDocumentRecord {
  id: string;
  documentNumber: string;
  version: number;
  status: "active";
  issuedAt: string;
}

export interface DeliveryNoteIssuance {
  deliveryNumber: string;
  deliveryDate: string;
}

export interface DocumentIssuanceRepositoryInterface {
  getCompanyProfile(companyId: string): Promise<CompanyProfile | null>;

  /** businessDate: "YYYY-MM-DD". Atomic/concurrency-safe (allocate_document_number). */
  allocateDocumentNumber(companyId: string, documentType: IssuedDocumentType, businessDate: string): Promise<string>;

  /** Menerbitkan Surat Jalan: alokasi delivery_number/delivery_date (Target 2). Immutable setelahnya. */
  issueDeliveryNote(deliveryId: string): Promise<DeliveryNoteIssuance>;

  /** Satu-satunya jalur penulisan issued_documents (Target 4). */
  recordIssuedDocument(input: RecordIssuedDocumentInput): Promise<IssuedDocumentRecord>;
}

// ---------------------------------------------------------------------------
// Error mapping -- pesan RPC Postgres (lihat RAISE EXCEPTION di migration)
// SELALU diawali kode eksplisit; dipetakan ke DocumentSourceError supaya
// caller tidak pernah perlu mem-parsing pesan Postgres mentah.
// ---------------------------------------------------------------------------

const ERROR_CODE_PREFIXES: [string, DocumentSourceErrorCode][] = [
  ["COMPANY_PROFILE_INCOMPLETE", "COMPANY_PROFILE_INCOMPLETE"],
  ["DELIVERY_NUMBER_ALREADY_ISSUED", "DELIVERY_ALREADY_ISSUED"],
  ["DELIVERY_NOT_ISSUABLE", "DELIVERY_NOT_ISSUABLE"],
  ["DELIVERY_NOT_FOUND", "DELIVERY_NOT_FOUND"],
  ["DELIVERY_ORDER_MISMATCH", "DELIVERY_ORDER_MISMATCH"],
  ["TENANT_CONTEXT_MISMATCH", "TENANT_CONTEXT_MISMATCH"],
  ["DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE", "DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE"],
  ["SUPERSEDES_DOCUMENT_NOT_FOUND", "SUPERSEDES_DOCUMENT_NOT_FOUND"],
  ["SUPERSEDES_DOCUMENT_NOT_ACTIVE", "SUPERSEDES_DOCUMENT_NOT_ACTIVE"],
  ["VERSION_SOURCE_MISMATCH", "VERSION_SOURCE_MISMATCH"],
];

function mapIssuanceError(error: { message: string }): Error {
  for (const [prefix, code] of ERROR_CODE_PREFIXES) {
    if (error.message.includes(prefix)) return new DocumentSourceError(code, error.message);
  }
  return new Error(error.message);
}

// ---------------------------------------------------------------------------
// Supabase-backed implementation.
// ---------------------------------------------------------------------------

export class SupabaseDocumentIssuanceRepository implements DocumentIssuanceRepositoryInterface {
  constructor(private readonly supabase: SupabaseClient) {}

  async getCompanyProfile(companyId: string): Promise<CompanyProfile | null> {
    const { data, error } = await this.supabase
      .from("companies")
      .select("id, name, legal_address, contact_email, contact_phone, document_number_prefix, logo_url")
      .eq("id", companyId)
      .maybeSingle();
    if (error) throw new Error(`getCompanyProfile failed: ${error.message}`);
    if (!data) return null;
    const row = data as {
      id: string;
      name: string;
      legal_address: string | null;
      contact_email: string | null;
      contact_phone: string | null;
      document_number_prefix: string | null;
      logo_url: string | null;
    };
    return {
      companyId: row.id,
      name: row.name,
      legalAddress: row.legal_address,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      documentNumberPrefix: row.document_number_prefix,
      logoUrl: row.logo_url,
    };
  }

  async allocateDocumentNumber(companyId: string, documentType: IssuedDocumentType, businessDate: string): Promise<string> {
    const { data, error } = await this.supabase.rpc("allocate_document_number", {
      p_company_id: companyId,
      p_document_type: documentType,
      p_business_date: businessDate,
    });
    if (error) throw mapIssuanceError(error);
    return data as string;
  }

  async issueDeliveryNote(deliveryId: string): Promise<DeliveryNoteIssuance> {
    const { data, error } = await this.supabase.rpc("issue_delivery_note", { p_delivery_id: deliveryId });
    if (error) throw mapIssuanceError(error);
    const row = ((data ?? []) as { delivery_number: string; delivery_date: string }[])[0];
    if (!row) throw new Error("issueDeliveryNote: RPC tidak mengembalikan baris");
    return { deliveryNumber: row.delivery_number, deliveryDate: row.delivery_date };
  }

  async recordIssuedDocument(input: RecordIssuedDocumentInput): Promise<IssuedDocumentRecord> {
    const { data, error } = await this.supabase.rpc("record_issued_document", {
      p_company_id: input.companyId,
      p_document_type: input.documentType,
      p_source_order_id: input.sourceOrderId,
      p_source_delivery_id: input.sourceDeliveryId,
      p_document_number: input.documentNumber,
      p_snapshot: input.snapshot,
      p_issued_by: input.issuedBy,
      p_supersedes_document_id: input.supersedesDocumentId,
    });
    if (error) throw mapIssuanceError(error);
    const row = ((data ?? []) as {
      out_id: string;
      out_document_number: string;
      out_version: number;
      out_status: "active";
      out_issued_at: string;
    }[])[0];
    if (!row) throw new Error("recordIssuedDocument: RPC tidak mengembalikan baris");
    return { id: row.out_id, documentNumber: row.out_document_number, version: row.out_version, status: row.out_status, issuedAt: row.out_issued_at };
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation -- untuk unit test lib/document-engine/issuance.ts
// tanpa database. Meniru SEMANTIK bisnis (validasi, versioning, single-active-
// per-source), BUKAN concurrency Postgres sungguhan -- pembuktian concurrency
// tetap lewat integration test terhadap Supabase lokal (issuance-repository.
// integration.test.ts), sama seperti pola finalize_delivery_item_quantities.
// ---------------------------------------------------------------------------

export class InMemoryDocumentIssuanceRepository implements DocumentIssuanceRepositoryInterface {
  companies = new Map<string, CompanyProfile>();
  deliveries = new Map<string, { companyId: string; status: string; deliveryNumber: string | null; deliveryDate: string | null }>();
  private counters = new Map<string, number>(); // `${companyId}:${type}:${date}` -> last sequence
  private documents: {
    id: string;
    documentNumber: string;
    version: number;
    status: "active" | "superseded";
    issuedAt: string;
    companyId: string;
    documentType: IssuedDocumentType;
    sourceKey: string;
  }[] = [];
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private typeCode(documentType: IssuedDocumentType): string {
    return documentType === "PURCHASE_ORDER" ? "PO" : documentType === "DELIVERY_NOTE" ? "SJ" : "INV";
  }

  async getCompanyProfile(companyId: string): Promise<CompanyProfile | null> {
    return this.companies.get(companyId) ?? null;
  }

  async allocateDocumentNumber(companyId: string, documentType: IssuedDocumentType, businessDate: string): Promise<string> {
    const profile = this.companies.get(companyId);
    if (!profile) throw new Error(`COMPANY_NOT_FOUND: ${companyId}`);
    if (!profile.documentNumberPrefix || profile.documentNumberPrefix.trim().length === 0) {
      throw new DocumentSourceError("COMPANY_PROFILE_INCOMPLETE", `Company ${companyId} belum memiliki document_number_prefix.`);
    }
    const key = `${companyId}:${documentType}:${businessDate}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    const dateCompact = businessDate.replaceAll("-", "");
    return `${profile.documentNumberPrefix}-${this.typeCode(documentType)}-${dateCompact}-${String(next).padStart(6, "0")}`;
  }

  async issueDeliveryNote(deliveryId: string): Promise<DeliveryNoteIssuance> {
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery) throw new DocumentSourceError("DELIVERY_NOT_FOUND", `Delivery ${deliveryId} tidak ditemukan.`);
    if (delivery.deliveryNumber !== null) {
      throw new DocumentSourceError("DELIVERY_ALREADY_ISSUED", `Delivery ${deliveryId} sudah memiliki delivery_number ${delivery.deliveryNumber}.`);
    }
    if (delivery.status !== "planned") {
      throw new DocumentSourceError("DELIVERY_NOT_ISSUABLE", `Delivery ${deliveryId} berstatus ${delivery.status}, bukan planned.`);
    }
    const profile = this.companies.get(delivery.companyId);
    if (!profile) throw new Error(`COMPANY_NOT_FOUND: ${delivery.companyId}`);
    assertCompanyProfileComplete(profile);

    const businessDate = "1970-01-01"; // deterministik untuk test -- caller InMemory tidak menyentuh jam nyata.
    const deliveryNumber = await this.allocateDocumentNumber(delivery.companyId, "DELIVERY_NOTE", businessDate);
    delivery.deliveryNumber = deliveryNumber;
    delivery.deliveryDate = businessDate;
    return { deliveryNumber, deliveryDate: businessDate };
  }

  async recordIssuedDocument(input: RecordIssuedDocumentInput): Promise<IssuedDocumentRecord> {
    const sourceKey = input.sourceDeliveryId ?? input.sourceOrderId;
    if (!sourceKey) throw new Error(`SOURCE_REQUIRED: dokumen ${input.documentType} wajib memiliki source_order_id atau source_delivery_id`);

    let version = 1;
    if (input.supersedesDocumentId) {
      const old = this.documents.find((d) => d.id === input.supersedesDocumentId);
      if (!old) throw new DocumentSourceError("SUPERSEDES_DOCUMENT_NOT_FOUND", `Dokumen ${input.supersedesDocumentId} tidak ditemukan.`);
      if (old.companyId !== input.companyId || old.documentType !== input.documentType) {
        throw new DocumentSourceError("TENANT_CONTEXT_MISMATCH", `Dokumen ${input.supersedesDocumentId} bukan milik company/tipe yang sama.`);
      }
      if (old.status !== "active") {
        throw new DocumentSourceError("SUPERSEDES_DOCUMENT_NOT_ACTIVE", `Dokumen ${input.supersedesDocumentId} berstatus ${old.status}, bukan active.`);
      }
      if (old.sourceKey !== sourceKey) {
        throw new DocumentSourceError("VERSION_SOURCE_MISMATCH", `Revisi wajib merujuk source yang sama dengan dokumen sebelumnya.`);
      }
      version = old.version + 1;
      old.status = "superseded";
    } else {
      const existingActive = this.documents.find(
        (d) => d.companyId === input.companyId && d.documentType === input.documentType && d.sourceKey === sourceKey && d.status === "active",
      );
      if (existingActive) {
        throw new DocumentSourceError("DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE", `Sudah ada dokumen ${input.documentType} aktif untuk source ini.`);
      }
    }

    const record = {
      id: this.nextId("doc"),
      documentNumber: input.documentNumber,
      version,
      status: "active" as const,
      issuedAt: new Date(0).toISOString(),
      companyId: input.companyId,
      documentType: input.documentType,
      sourceKey,
    };
    this.documents.push(record);
    return { id: record.id, documentNumber: record.documentNumber, version: record.version, status: record.status, issuedAt: record.issuedAt };
  }
}
