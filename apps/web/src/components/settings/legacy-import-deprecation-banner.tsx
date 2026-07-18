import Link from "next/link";
import { ArrowRight, Info } from "lucide-react";

/**
 * Modul settings/import (import_templates/import_jobs) digantikan oleh
 * Universal Data Onboarding (/dashboard/imports) untuk domain customer/
 * product/sales_order. Halaman ini TETAP bisa dilihat (riwayat/template lama
 * tidak dihapus), tapi tidak lagi jadi jalur utama membuat import baru.
 */
export function LegacyImportDeprecationBanner() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <Info className="h-4 w-4 shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="font-medium">Modul ini sudah digantikan.</p>
        <p className="text-xs text-amber-700 mt-0.5">
          Riwayat/template lama tetap bisa dilihat di sini, tapi untuk import data baru gunakan Import Data
          yang mendukung staging, mapping tersimpan, validasi, reconciliation, dan rollback.
        </p>
      </div>
      <Link
        href="/dashboard/imports"
        className="flex shrink-0 items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
      >
        Buka Import Data <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
