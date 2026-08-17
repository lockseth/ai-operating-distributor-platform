// =============================================================================
// Gate 2I.1/2I.2 -- Finance Operations Workspace shell (kontrak §2.2/§2.3, GAP G3).
//
// Guard permission SERVER-SIDE (bukan hanya penyembunyian menu sidebar) --
// company/tenant context berasal dari getAuthUser() (session tepercaya),
// bukan query param. Berlaku untuk seluruh sub-route /dashboard/finance/*
// karena Next.js layout membungkus semua children route di bawahnya.
//
// Ringkasan (2I.1) + Invoice & Piutang/Collection & Janji Bayar/Pembayaran &
// Verifikasi/Exception Rekonsiliasi (2I.2) + Retur & Credit Note/Customer
// Credit & Refund (2I.3) + Cancellation & Invoice Void/Riwayat Audit (2I.4)
// punya destination nyata. Riwayat Audit Owner-only (RLS audit_logs_select,
// 20260819000001) -- non-owner melihat tab non-aktif dengan disabledReason
// eksplisit, BUKAN 404/tautan disembunyikan (kontrak Gate 2I.4 §B.1/§H).
// =============================================================================

import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { TableSkeleton } from "@/components/ui/loading-state";
import { FinanceTabNav, type FinanceSection } from "@/components/finance/finance-tab-nav";

function buildFinanceSections(roles: string[]): FinanceSection[] {
  return [
    { label: "Ringkasan / Perlu Tindakan", href: "/dashboard/finance" },
    { label: "Invoice & Piutang", href: "/dashboard/finance/invoices" },
    { label: "Collection & Janji Bayar", href: "/dashboard/finance/collection" },
    { label: "Pembayaran & Verifikasi", href: "/dashboard/finance/payments" },
    { label: "Klaim Pembayaran", href: "/dashboard/finance/payment-claims" },
    { label: "Exception Rekonsiliasi", href: "/dashboard/finance/reconciliation" },
    { label: "Retur & Credit Note", href: "/dashboard/finance/returns" },
    { label: "Customer Credit & Refund", href: "/dashboard/finance/credit" },
    { label: "Cancellation & Invoice Void", href: "/dashboard/finance/cancellations" },
    roles.includes("owner")
      ? { label: "Riwayat Audit", href: "/dashboard/finance/audit" }
      : { label: "Riwayat Audit", disabledReason: "Hanya Owner yang dapat membuka Riwayat Audit" },
  ];
}

export default async function FinanceWorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-4 sm:px-6">
        <h1 className="pt-4 text-lg font-semibold text-gray-900">Finance Operations</h1>
        <FinanceTabNav sections={buildFinanceSections(user.roles)} />
      </div>
      {/* Suspense di sini (bukan loading.tsx terpisah) supaya boundary ini
          otomatis dipakai ulang oleh seluruh sub-route workspace masa depan
          (2I.2-2I.4), bukan hanya Ringkasan -- reuse TableSkeleton existing,
          bukan skeleton baru per domain (FIN-12-01: skeleton, bukan blank). */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <Suspense fallback={<TableSkeleton />}>{children}</Suspense>
      </div>
    </div>
  );
}
