// =============================================================================
// Document Engine -- issuance orchestration (Target 2/3/4, LOCKED 2026-07-22).
//
// Menyatukan alur: baca profil tenant (Target 3, gagal eksplisit bila belum
// lengkap) -> baca source lewat repository-adapter.ts yang sudah ada -> alokasi
// nomor dokumen (Target 2/4, atomic lewat issuance-repository.ts) -> build
// snapshot lewat po-builder.ts/invoice-builder.ts yang SUDAH ADA (tidak
// diduplikasi) -> persist immutable + versioned lewat record_issued_document
// (Target 4).
//
// TIDAK ADA kalkulasi uang di sini -- itu tetap tugas monetary.ts lewat
// po-builder.ts/invoice-builder.ts. Modul ini murni orkestrasi.
//
// DELIVERY_NOTE (Surat Jalan): issue_delivery_note() (migration
// 20260812000001) mengalokasikan delivery_number/delivery_date -- TIDAK
// dipersist ke issued_documents di sini. AODP_DOCUMENT_CONSTITUTION_v1.0
// (Standard Flow: "Sales Order -> Document Engine -> PO/Faktur -> Delivery
// Order -> ...") dan AODP_DOCUMENT_LAYOUT_GUIDE hanya mendefinisikan layout
// cetak untuk PO dan Faktur/Invoice -- belum ada spesifikasi konten/layout
// Surat Jalan sebagai DocumentSnapshot bercetak. Skema issued_documents
// SUDAH mendukung document_type='DELIVERY_NOTE' (Target 4, migration
// 20260812000002) untuk saat spesifikasi tsb tersedia; menyusun snapshot-nya
// di luar cakupan gate ini supaya tidak mengarang layout yang belum dikunci.
// =============================================================================

import { buildInvoiceSnapshot } from "./invoice-builder";
import type { DeliveryReader, OrderReader } from "./repository-adapter";
import { loadInvoiceSource, loadPurchaseOrderSource } from "./repository-adapter";
import { buildPurchaseOrderSnapshot } from "./po-builder";
import { DocumentSourceError } from "./errors";
import type { CompanyProfile, DocumentIssuanceRepositoryInterface, IssuedDocumentRecord } from "./issuance-repository";
import { assertCompanyProfileComplete } from "./issuance-repository";
import type { DocumentSnapshot, TenantIdentity } from "./types";

/** Tanggal bisnis Asia/Jakarta (YYYY-MM-DD) pada saat issuance -- SELALU dipakai sebagai documentDate, tidak pernah dihitung ulang saat dibaca. */
export function jakartaBusinessDate(now: () => Date = () => new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function toTenantIdentity(profile: CompanyProfile): TenantIdentity {
  assertCompanyProfileComplete(profile);
  return {
    companyId: profile.companyId,
    companyName: profile.name,
    companyAddress: profile.legalAddress as string,
    companyEmail: profile.contactEmail as string,
    companyPhone: profile.contactPhone as string,
    logoUrl: profile.logoUrl,
  };
}

async function loadTenantIdentity(issuance: DocumentIssuanceRepositoryInterface, companyId: string): Promise<TenantIdentity> {
  const profile = await issuance.getCompanyProfile(companyId);
  if (!profile) {
    throw new DocumentSourceError("COMPANY_MISMATCH", `Company ${companyId} tidak ditemukan.`);
  }
  return toTenantIdentity(profile);
}

export interface IssuedDocumentResult {
  record: IssuedDocumentRecord;
  snapshot: DocumentSnapshot;
}

export interface IssuePurchaseOrderParams {
  companyId: string;
  orderId: string;
  issuedBy: string | null;
  delivererName?: string;
  /** Revisi dokumen aktif ini -- version+1, dokumen lama ditandai superseded. Default: penerbitan pertama. */
  supersedesDocumentId?: string | null;
  now?: () => Date;
}

export async function issuePurchaseOrderDocument(
  repos: { issuance: DocumentIssuanceRepositoryInterface; orderReader: OrderReader },
  params: IssuePurchaseOrderParams,
): Promise<IssuedDocumentResult> {
  const tenant = await loadTenantIdentity(repos.issuance, params.companyId);
  const order = await loadPurchaseOrderSource(repos.orderReader, { companyId: params.companyId, orderId: params.orderId });

  const businessDate = jakartaBusinessDate(params.now);
  const documentNumber = await repos.issuance.allocateDocumentNumber(params.companyId, "PURCHASE_ORDER", businessDate);

  const snapshot = buildPurchaseOrderSnapshot({
    order,
    tenant,
    documentNumber,
    documentDate: businessDate,
    delivererName: params.delivererName,
    now: params.now,
  });

  const record = await repos.issuance.recordIssuedDocument({
    companyId: params.companyId,
    documentType: "PURCHASE_ORDER",
    sourceOrderId: order.orderId,
    sourceDeliveryId: null,
    documentNumber,
    snapshot: snapshot as unknown as Record<string, unknown>,
    issuedBy: params.issuedBy,
    supersedesDocumentId: params.supersedesDocumentId ?? null,
  });

  return { record, snapshot };
}

export interface IssueInvoiceParams {
  companyId: string;
  orderId: string;
  deliveryId: string;
  issuedBy: string | null;
  delivererName?: string;
  supersedesDocumentId?: string | null;
  now?: () => Date;
}

export async function issueInvoiceDocument(
  repos: { issuance: DocumentIssuanceRepositoryInterface; orderReader: OrderReader; deliveryReader: DeliveryReader },
  params: IssueInvoiceParams,
): Promise<IssuedDocumentResult> {
  const tenant = await loadTenantIdentity(repos.issuance, params.companyId);
  const { order, delivery } = await loadInvoiceSource(
    { orderReader: repos.orderReader, deliveryReader: repos.deliveryReader },
    { companyId: params.companyId, orderId: params.orderId, deliveryId: params.deliveryId },
  );

  const businessDate = jakartaBusinessDate(params.now);
  const documentNumber = await repos.issuance.allocateDocumentNumber(params.companyId, "INVOICE", businessDate);

  const snapshot = buildInvoiceSnapshot({
    order,
    delivery,
    tenant,
    documentNumber,
    documentDate: businessDate,
    delivererName: params.delivererName,
    now: params.now,
  });

  const record = await repos.issuance.recordIssuedDocument({
    companyId: params.companyId,
    documentType: "INVOICE",
    sourceOrderId: order.orderId,
    sourceDeliveryId: delivery.deliveryId,
    documentNumber,
    snapshot: snapshot as unknown as Record<string, unknown>,
    issuedBy: params.issuedBy,
    supersedesDocumentId: params.supersedesDocumentId ?? null,
  });

  return { record, snapshot };
}
