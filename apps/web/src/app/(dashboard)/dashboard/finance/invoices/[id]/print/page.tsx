// =============================================================================
// Halaman Lihat/Cetak Invoice (satu dokumen) -- wiring Document Engine yang
// sudah teruji (PhysicalPrintSheet, buildPrintViewModel, buildPrintSheets) ke
// route aplikasi. Untuk cetak beberapa invoice sekaligus (batch, 2 dokumen
// pendek berbagi 1 lembar fisik continuous form), lihat
// print-batch/page.tsx -- assembly snapshot dipakai bersama lewat
// lib/finance/print-snapshot.ts supaya tidak duplikasi.
// READ-ONLY: tidak menerbitkan/mengubah dokumen apa pun, hanya membaca
// snapshot yang sudah tersimpan di issued_documents.
// =============================================================================

import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { createClient } from "@/lib/supabase/server";
import { getInvoiceDetail, hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { getInvoicePrintViewModel } from "@/lib/finance/print-snapshot";
import { buildPrintSheets } from "@/lib/document-engine/print-batch";
import { PhysicalPrintSheet } from "@/components/document-engine/PhysicalPrintSheet";
import { PrintNowButton } from "@/components/document-engine/print-now-button";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCard } from "@/components/layout/dashboard-shell";
import { FileX } from "lucide-react";

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
  const viewModel = await getInvoicePrintViewModel(supabase, user.company_id, invoice.salesOrderId);

  if (!viewModel) {
    return (
      <EmptyState
        icon={<FileX className="h-6 w-6" />}
        title="Dokumen invoice tidak ditemukan"
        description="Invoice ini belum memiliki dokumen resmi yang tercatat di issued_documents."
      />
    );
  }

  // Continuous form 3-ply dot-matrix (LOCKED Founder 23 Juli 2026): SATU
  // lembar fisik 9.5x11in = DUA panel 5.5in. Invoice tunggal mengisi panel
  // atas; panel bawah kosong (BUKAN dummy document) bila hanya 1 dokumen
  // di-print sendirian -- lihat PhysicalPrintSheet.tsx.
  const sheets = buildPrintSheets([viewModel]);

  return (
    <div className="space-y-4 bg-gray-100 p-4 print:space-y-0 print:bg-white print:p-0">
      <PrintNowButton />
      {sheets.map((sheet, i) => (
        <PhysicalPrintSheet key={i} sheet={sheet} />
      ))}
    </div>
  );
}
