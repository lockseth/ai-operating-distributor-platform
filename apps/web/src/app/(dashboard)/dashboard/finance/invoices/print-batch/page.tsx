// =============================================================================
// Cetak Invoice sekaligus (batch) -- Founder konfirmasi (2026-08-17) invoice
// dicetak sekaligus ke printer continuous form 3 ply, bukan satu-satu
// real-time. buildPrintSheets() sudah didesain untuk ini sejak awal (pairing
// panel lintas dokumen, guard CrossTenantBatchError) -- halaman ini murni
// entry point baru, tidak ada perubahan pada Document Engine sendiri.
// READ-ONLY, sama seperti [id]/print -- hanya membaca snapshot yang sudah
// tersimpan di issued_documents.
// =============================================================================

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { getInvoicePrintViewModel } from "@/lib/finance/print-snapshot";
import { buildPrintSheets } from "@/lib/document-engine/print-batch";
import type { PrintDocumentViewModel } from "@/lib/document-engine/print-view-model";
import { PhysicalPrintSheet } from "@/components/document-engine/PhysicalPrintSheet";
import { PrintNowButton } from "@/components/document-engine/print-now-button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { FileX } from "lucide-react";

export const metadata = { title: "Cetak Invoice (Batch) — AODP" };

interface SearchParams {
  ids?: string;
}

export default async function InvoiceBatchPrintPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
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

  const ids = (params.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return (
      <EmptyState
        icon={<FileX className="h-6 w-6" />}
        title="Tidak ada invoice dipilih"
        description="Kembali ke daftar Invoice & Piutang, pilih invoice yang mau dicetak, lalu klik “Cetak Terpilih”."
      />
    );
  }

  const supabase = await createClient();

  // Urutan dikunci dari nomor invoice (bukan urutan klik user) supaya batch
  // yang sama selalu menghasilkan susunan lembar fisik yang sama persis.
  const { data: invoiceRows } = await supabase
    .from("invoices")
    .select("id, invoice_number, sales_order_id")
    .eq("company_id", user.company_id)
    .in("id", ids)
    .order("invoice_number", { ascending: true });

  const rows = (invoiceRows ?? []) as { id: string; invoice_number: string; sales_order_id: string }[];

  const viewModels: PrintDocumentViewModel[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const vm = await getInvoicePrintViewModel(supabase, user.company_id, row.sales_order_id);
    if (vm) {
      viewModels.push(vm);
    } else {
      skipped.push(row.invoice_number);
    }
  }

  if (viewModels.length === 0) {
    return (
      <EmptyState
        icon={<FileX className="h-6 w-6" />}
        title="Dokumen invoice tidak ditemukan"
        description="Invoice yang dipilih belum memiliki dokumen resmi yang tercatat di issued_documents."
      />
    );
  }

  const sheets = buildPrintSheets(viewModels);

  return (
    <div className="space-y-4 bg-gray-100 p-4 print:space-y-0 print:bg-white print:p-0">
      <PrintNowButton />
      {skipped.length > 0 && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 print:hidden">
          {skipped.length} invoice dilewati (belum punya dokumen resmi di issued_documents): {skipped.join(", ")}
        </div>
      )}
      {sheets.map((sheet, i) => (
        <PhysicalPrintSheet key={i} sheet={sheet} />
      ))}
    </div>
  );
}
