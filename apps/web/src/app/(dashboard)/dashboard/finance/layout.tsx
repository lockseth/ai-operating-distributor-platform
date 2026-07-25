// =============================================================================
// Gate 2I.1 -- Finance Operations Workspace shell (kontrak §2.2/§2.3, GAP G3).
//
// Guard permission SERVER-SIDE (bukan hanya penyembunyian menu sidebar) --
// company/tenant context berasal dari getAuthUser() (session tepercaya),
// bukan query param. Berlaku untuk seluruh sub-route /dashboard/finance/*
// karena Next.js layout membungkus semua children route di bawahnya.
//
// Hanya "Ringkasan" yang punya destination nyata pada Gate 2I.1 -- tab
// lain SENGAJA dirender non-aktif (bukan Link ke route yang belum ada)
// sesuai instruksi gate: jangan membuat tautan berakhir 404, jangan
// membuat halaman placeholder massal hanya untuk memenuhi link.
// =============================================================================

import type { ReactNode } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasFinanceWorkspaceAccess } from "@/lib/finance/queries";
import { TableSkeleton } from "@/components/ui/loading-state";

interface FinanceSection {
  label: string;
  href?: string;
}

const FINANCE_SECTIONS: FinanceSection[] = [
  { label: "Ringkasan / Perlu Tindakan", href: "/dashboard/finance" },
  { label: "Invoice & Piutang" },
  { label: "Collection & Janji Bayar" },
  { label: "Pembayaran & Verifikasi" },
  { label: "Exception Rekonsiliasi" },
  { label: "Retur & Credit Note" },
  { label: "Customer Credit & Refund" },
  { label: "Cancellation & Invoice Void" },
  { label: "Riwayat Audit" },
];

export default async function FinanceWorkspaceLayout({ children }: { children: ReactNode }) {
  const user = await getAuthUser();

  if (!hasFinanceWorkspaceAccess(user.permissions)) {
    redirect("/dashboard");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gray-200 bg-white px-4 sm:px-6">
        <h1 className="pt-4 text-lg font-semibold text-gray-900">Finance Operations</h1>
        <nav aria-label="Navigasi Finance Operations" className="mt-3 -mb-px flex gap-1 overflow-x-auto">
          {FINANCE_SECTIONS.map((section) =>
            section.href ? (
              <Link
                key={section.label}
                href={section.href}
                className="whitespace-nowrap border-b-2 border-blue-600 px-3 py-2 text-sm font-medium text-blue-700"
              >
                {section.label}
              </Link>
            ) : (
              <span
                key={section.label}
                aria-disabled="true"
                title="Tersedia pada tahap implementasi berikutnya"
                className="whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-300"
              >
                {section.label}
              </span>
            )
          )}
        </nav>
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
