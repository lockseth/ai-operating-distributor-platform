"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

// Next.js App Router error boundary untuk /dashboard/dispatch. Pesan generik
// saja -- detail internal (error.message/stack) sengaja tidak ditampilkan
// ke UI, hanya dicatat ke console untuk observability developer.
export default function DispatchPlannerError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[DispatchPlannerPage]", error);
  }, [error]);

  return (
    <div className="p-6">
      <div className="flex flex-col items-center justify-center rounded-xl border bg-white p-10 text-center shadow-sm">
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 border border-red-100 text-red-400">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <h3 className="text-sm font-semibold text-gray-700">Gagal memuat AI Dispatch Planner</h3>
        <p className="mt-1 text-xs text-gray-400 max-w-xs leading-relaxed">
          Terjadi kesalahan saat mengambil data rencana pengiriman. Coba muat ulang halaman.
        </p>
        <button
          onClick={reset}
          className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
        >
          Coba Lagi
        </button>
      </div>
    </div>
  );
}
