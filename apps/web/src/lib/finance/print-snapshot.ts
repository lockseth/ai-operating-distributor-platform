// =============================================================================
// Assembling invoice print view models -- dipakai halaman print single
// ([id]/print) dan batch (print-batch). RPC issue_invoice_atomic (jalur
// transaksional, LOCKED/gate-tested) menulis snapshot "tipis" -- lines/totals/
// nomor dokumen saja, TANPA tenant/store/salesman. 3 bagian yang hilang
// dilengkapi di sini dari tabel yang sudah ada -- TIDAK mengubah
// issued_documents/snapshot tersimpan.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPrintViewModel, type PrintDocumentViewModel } from "@/lib/document-engine/print-view-model";
import type { DocumentSnapshot } from "@/lib/document-engine/types";

async function fillMissingIdentities(
  supabase: SupabaseClient,
  companyId: string,
  salesOrderId: string,
  snapshot: DocumentSnapshot,
): Promise<DocumentSnapshot> {
  const [{ data: company }, { data: order }, { data: delivery }] = await Promise.all([
    supabase
      .from("companies")
      .select("id, name, legal_address, contact_email, contact_phone, logo_url")
      .eq("id", companyId)
      .maybeSingle(),
    supabase
      .from("sales_orders")
      .select(
        "customer:customers!customer_id(id, code, name, address, phone), sales:users!sales_id(id, full_name)"
      )
      .eq("id", salesOrderId)
      .maybeSingle(),
    snapshot.deliveryReference
      ? supabase
          .from("deliveries")
          .select("driver:users!assigned_driver_id(full_name)")
          .eq("id", snapshot.deliveryReference)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const c = company as unknown as {
    id: string; name: string; legal_address: string | null;
    contact_email: string | null; contact_phone: string | null; logo_url: string | null;
  } | null;
  const o = order as unknown as {
    customer: { id: string; code: string | null; name: string; address: string | null; phone: string | null } | null;
    sales: { id: string; full_name: string } | null;
  } | null;
  const d = delivery as unknown as { driver: { full_name: string } | null } | null;

  return {
    ...snapshot,
    tenant: snapshot.tenant ?? {
      companyId,
      companyName: c?.name ?? "-",
      companyAddress: c?.legal_address ?? "-",
      companyEmail: c?.contact_email ?? "-",
      companyPhone: c?.contact_phone ?? "-",
      logoUrl: c?.logo_url ?? null,
    },
    store: snapshot.store ?? {
      customerId: o?.customer?.id ?? "",
      storeCode: o?.customer?.code ?? null,
      storeName: o?.customer?.name ?? "-",
      storeAddress: o?.customer?.address ?? null,
      storePhone: o?.customer?.phone ?? null,
      picName: null,
    },
    salesman: snapshot.salesman ?? {
      salesmanId: o?.sales?.id ?? "",
      salesmanName: o?.sales?.full_name ?? "-",
    },
    signatures: snapshot.signatures ?? {
      salesmanName: o?.sales?.full_name ?? "-",
      delivererName: d?.driver?.full_name ?? o?.sales?.full_name ?? "-",
    },
  };
}

/** Invoice tanpa issued_documents aktif (mis. data korup/dihapus manual) -> null, bukan throw -- pemanggil (batch) perlu bisa skip satu dokumen tanpa menggagalkan seluruh batch. */
export async function getInvoicePrintViewModel(
  supabase: SupabaseClient,
  companyId: string,
  salesOrderId: string,
): Promise<PrintDocumentViewModel | null> {
  const { data: docRow } = await supabase
    .from("issued_documents")
    .select("snapshot, version")
    .eq("company_id", companyId)
    .eq("document_type", "INVOICE")
    .eq("source_order_id", salesOrderId)
    .eq("status", "active")
    .maybeSingle();
  if (!docRow) return null;

  const rawSnapshot = docRow.snapshot as unknown as DocumentSnapshot;
  const snapshot = await fillMissingIdentities(supabase, companyId, salesOrderId, rawSnapshot);
  return buildPrintViewModel(snapshot);
}
