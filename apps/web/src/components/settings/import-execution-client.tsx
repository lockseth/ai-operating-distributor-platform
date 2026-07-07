"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { executeImportAction } from "@/lib/settings/import-execution";
import type { ExecutionResult } from "@/lib/settings/import-execution";
import type { EntityType } from "@/lib/settings/import-actions";
import type { MappedRow } from "@/lib/settings/import-validator";
import {
  PlayCircle, Loader2, CheckCircle2, XCircle,
  AlertTriangle, SkipForward, Info,
} from "lucide-react";

interface Props {
  templateId:  string;
  templateName: string;
  entityType:  EntityType;
  fileName:    string;
  validRows:   MappedRow[];
  invalidRows: MappedRow[];
  totalRows:   number;
}

const ENTITY_LABEL: Record<string, string> = {
  customer: "Pelanggan", product: "Produk", sales_order: "Sales Order",
};

export function ImportExecutionClient({
  templateId, entityType, fileName,
  validRows, invalidRows, totalRows,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [result,   setResult]        = useState<ExecutionResult | null>(null);
  const [execErr,  setExecErr]       = useState<string | null>(null);
  const [confirmed, setConfirmed]    = useState(false);

  function handleExecute() {
    setExecErr(null);

    // Prepare rows to send: rowIndex + flat fields map
    const rows = [
      ...validRows.map((r) => ({
        rowIndex: r.rowIndex,
        fields:   Object.fromEntries(r.mapped.map((m) => [m.targetField, m.transformedValue])),
        isValid:  true,
        errors:   [],
      })),
      ...invalidRows.map((r) => ({
        rowIndex: r.rowIndex,
        fields:   Object.fromEntries(r.mapped.map((m) => [m.targetField, m.transformedValue])),
        isValid:  false,
        errors:   r.errors,
      })),
    ];

    startTransition(async () => {
      try {
        const res = await executeImportAction({
          templateId,
          fileName,
          entityType,
          rows,
        });
        setResult(res);
      } catch (err) {
        setExecErr(err instanceof Error ? err.message : "Terjadi kesalahan saat import");
      }
    });
  }

  if (result) {
    return <ImportResultCard result={result} entityType={entityType} />;
  }

  const willSkip  = invalidRows.length;
  const willImport = validRows.length;

  if (willImport === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-amber-800">Tidak Ada Baris yang Bisa Diimpor</p>
          <p className="text-xs text-amber-600 mt-1">
            Semua {totalRows} baris memiliki error validasi. Perbaiki data di file CSV dan coba lagi.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-white p-5 shadow-sm space-y-4">
      <div className="flex items-center gap-2">
        <PlayCircle className="h-5 w-5 text-green-500" />
        <h3 className="text-sm font-semibold text-gray-900">Siap Diimport</h3>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-green-50 p-3 text-center">
          <p className="text-lg font-bold text-green-700">{willImport}</p>
          <p className="text-xs text-green-600">Akan diimport</p>
        </div>
        <div className={`rounded-lg p-3 text-center ${willSkip > 0 ? "bg-amber-50" : "bg-gray-50"}`}>
          <p className={`text-lg font-bold ${willSkip > 0 ? "text-amber-700" : "text-gray-400"}`}>{willSkip}</p>
          <p className={`text-xs ${willSkip > 0 ? "text-amber-600" : "text-gray-400"}`}>Dilewati (error)</p>
        </div>
        <div className="rounded-lg bg-gray-50 p-3 text-center">
          <p className="text-lg font-bold text-gray-700">{totalRows}</p>
          <p className="text-xs text-gray-500">Total baris</p>
        </div>
      </div>

      {willSkip > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <SkipForward className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {willSkip} baris tidak valid akan dilewati (tidak dimasukkan ke database).
          Kamu bisa melanjutkan mengimport {willImport} baris valid.
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
        <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
        Data duplikat (kode/SKU/nomor order yang sudah ada) akan dilewati secara otomatis.
        Tidak ada data yang ditimpa.
      </div>

      {execErr && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          <XCircle className="h-4 w-4 shrink-0" />
          {execErr}
        </div>
      )}

      {/* Confirmation + Execute */}
      {!confirmed ? (
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <p className="text-xs text-gray-500">
            Import <strong>{willImport}</strong> data {ENTITY_LABEL[entityType] ?? entityType} ke sistem?
          </p>
          <button
            onClick={() => setConfirmed(true)}
            className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            <PlayCircle className="h-4 w-4" />
            Jalankan Import
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          <p className="text-xs font-medium text-amber-700">
            Konfirmasi: import <strong>{willImport}</strong> baris ke database. Tindakan ini tidak bisa di-undo.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConfirmed(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Batal
            </button>
            <button
              onClick={handleExecute}
              disabled={isPending}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-5 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              {isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Mengimport...</>
              ) : (
                <><CheckCircle2 className="h-4 w-4" /> Ya, Impor Sekarang</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result Card
// ---------------------------------------------------------------------------

function ImportResultCard({
  result, entityType,
}: {
  result: ExecutionResult;
  entityType: EntityType;
}) {
  const [showErrors, setShowErrors] = useState(false);
  const success = result.importedRows > 0;

  return (
    <div className={`rounded-xl border p-5 shadow-sm ${success ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
      <div className="flex items-center gap-3 mb-4">
        {success ? (
          <CheckCircle2 className="h-6 w-6 text-green-500" />
        ) : (
          <AlertTriangle className="h-6 w-6 text-amber-500" />
        )}
        <h3 className="text-base font-semibold text-gray-900">
          {success ? "Import Selesai" : "Import Selesai dengan Peringatan"}
        </h3>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-4">
        {[
          { label: "Total Baris",   value: result.totalRows,    color: "gray" },
          { label: "Berhasil Diimpor", value: result.importedRows, color: "green" },
          { label: "Dilewati",      value: result.skippedRows,  color: "amber" },
          { label: "Error",         value: result.errorRows,    color: "red" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg bg-white p-3 text-center shadow-sm">
            <p className={`text-xl font-bold ${
              s.color === "green" ? "text-green-700" :
              s.color === "amber" ? "text-amber-600" :
              s.color === "red"   ? "text-red-600" :
              "text-gray-800"
            }`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span>
          {result.importedRows} data {ENTITY_LABEL[entityType] ?? entityType} berhasil masuk ke sistem.
        </span>
        {result.skippedRows > 0 && (
          <span className="text-amber-600">
            {result.skippedRows} baris dilewati (duplikat atau error).
          </span>
        )}
        <span className="font-mono text-[10px] text-gray-300">Job ID: {result.jobId}</span>
      </div>

      {result.errors.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowErrors(!showErrors)}
            className="text-xs font-medium text-gray-600 hover:text-gray-800 underline"
          >
            {showErrors ? "Sembunyikan" : "Tampilkan"} detail error ({result.errors.length})
          </button>
          {showErrors && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-100 bg-white">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b">
                    <th className="px-3 py-2 text-left font-medium text-gray-500 w-20">Baris</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">Keterangan Error</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {result.errors.map((e, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-gray-500">{e.row}</td>
                      <td className="px-3 py-2 text-red-600">{e.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="mt-4 pt-3 border-t border-gray-100 flex gap-3">
        <Link href="/dashboard/settings/import"
          className="text-xs font-medium text-blue-600 hover:underline">
          ← Kembali ke Template Import
        </Link>
        <span className="text-gray-300">|</span>
        <Link href="/dashboard/settings/import/jobs"
          className="text-xs font-medium text-blue-600 hover:underline">
          Lihat Riwayat Import →
        </Link>
      </div>
    </div>
  );
}
