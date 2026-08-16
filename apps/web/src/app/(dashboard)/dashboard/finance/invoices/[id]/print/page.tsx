// =============================================================================
// Halaman Lihat/Cetak Invoice -- wiring Document Engine yang sudah teruji
// (PrintDocumentPanel, buildPrintViewModel, paginatePrintDocument) ke route
// aplikasi. Sebelumnya komponen ini hanya dipakai di
// full-path-demo.integration.test.ts (render ke file HTML statis di
// scratchpad), belum pernah bisa dilihat lewat aplikasi -- lihat TRACKER.md.
// READ-ONLY: tidak menerbitkan/mengubah dokumen apa pun, hanya membaca
// snapshot yang sudah tersimpan di issued_documents.
// =============================================================================

import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { getInvoiceDetail, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { buildPrintViewModel } from "@/lib/document-engine/print-view-model";
import { paginatePrintDocument } from "@/lib/document-engine/print-pagination";
import { PrintDocumentPanel } from "@/components/document-engine/PrintDocumentPanel";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { FileX } from "lucide-react";
import type { DocumentSnapshot } from "@/lib/document-engine/types";

// RPC issue_invoice_atomic (jalur transaksional, LOCKED/gate-tested) menulis
// snapshot "tipis" -- lines/totals/nomor dokumen saja, TANPA tenant/store/
// salesman. Builder TypeScript terpisah (dipakai full-path-demo test) yang
// menghasilkan snapshot lengkap tidak dipanggil oleh jalur produksi manapun
// saat ini. Supaya halaman ini tetap bisa render tanpa menyentuh RPC yang
// sudah locked, 3 bagian yang hilang dilengkapi di sini dari tabel yang
// sudah ada -- TIDAK mengubah issued_documents/snapshot tersimpan.
async function fillMissingIdentities(
  supabase: Awaited<ReturnType<typeof createClient>>,
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

export const metadata = { title: "Cetak Invoice — AODP" };

export default async function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  if (user.isDemo) {
    return (
      <AlertCard
        type="info"
        title="Fitur ini belum tersedia pada mode demo"
        message="Dokumen invoice membaca data finansial nyata perusahaan dan belum didukung pada sesi demo."
      />
    );
  }

  const invoice = await getInvoiceDetail(user.company_id, id);
  if (!invoice) notFound();

  const supabase = await createClient();
  const { data: docRow } = await supabase
    .from("issued_documents")
    .select("snapshot, version")
    .eq("company_id", user.company_id)
    .eq("document_type", "INVOICE")
    .eq("source_order_id", invoice.salesOrderId)
    .eq("status", "active")
    .maybeSingle();

  if (!docRow) {
    return (
      <EmptyState
        icon={<FileX className="h-6 w-6" />}
        title="Dokumen invoice tidak ditemukan"
        description="Invoice ini belum memiliki dokumen resmi yang tercatat di issued_documents."
      />
    );
  }

  const rawSnapshot = docRow.snapshot as unknown as DocumentSnapshot;
  const snapshot = await fillMissingIdentities(supabase, user.company_id, invoice.salesOrderId, rawSnapshot);
  const viewModel = buildPrintViewModel(snapshot);
  const panels = paginatePrintDocument(viewModel, undefined, docRow.version as number);

  return (
    <div className="space-y-4 bg-gray-100 p-4 print:space-y-0 print:bg-white print:p-0">
      {panels.map((panel) => (
        <PrintDocumentPanel key={panel.pageIndex} panel={panel} />
      ))}
    </div>
  );
}
