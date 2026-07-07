"use client";

import { useState, useCallback, useTransition, useRef } from "react";
import { parseCSVText } from "@/lib/settings/csv-parser";
import { buildPreview } from "@/lib/settings/import-validator";
import { logImportPreviewAction } from "@/lib/settings/import-preview-actions";
import { ImportExecutionClient } from "./import-execution-client";
import type { ImportTemplate } from "@/lib/settings/import-preview-actions";
import type { PreviewResult, MappedRow } from "@/lib/settings/import-validator";
import type { EntityType } from "@/lib/settings/import-actions";
import {
  Upload, CheckCircle2, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, Info, RefreshCw,
} from "lucide-react";

interface Props {
  template: ImportTemplate;
}

const ENTITY_LABEL: Record<string, string> = {
  customer: "Pelanggan", product: "Produk", sales_order: "Sales Order",
};

export function ImportPreviewClient({ template }: Props) {
  const [isPending, startTransition] = useTransition();
  const [file,     setFile]          = useState<File | null>(null);
  const [preview,  setPreview]       = useState<PreviewResult | null>(null);
  const [parseErr, setParseErr]      = useState<string | null>(null);
  const [logged,   setLogged]        = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (selectedFile: File) => {
      setParseErr(null);
      setPreview(null);
      setLogged(false);
      setExpandedRows(new Set());

      if (!selectedFile.name.match(/\.(csv|tsv|txt)$/i)) {
        setParseErr("Hanya file CSV/TSV yang didukung.");
        return;
      }
      if (selectedFile.size > 5 * 1024 * 1024) {
        setParseErr("Ukuran file maksimal 5 MB.");
        return;
      }

      setFile(selectedFile);

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        try {
          const { headers, rows } = parseCSVText(
            text,
            template.delimiter === "\\t" ? "\t" : template.delimiter,
            template.file_has_header
          );

          if (rows.length === 0) {
            setParseErr("File tidak berisi data (kosong atau hanya header).");
            return;
          }

          const result = buildPreview(headers, rows, template.column_mappings);
          setPreview(result);

          // Audit log
          startTransition(async () => {
            await logImportPreviewAction(template.id, template.name, {
              total:  result.totalRows,
              valid:  result.validRows,
              errors: result.errorRows,
            });
            setLogged(true);
          });
        } catch {
          setParseErr("Gagal mem-parsing file. Pastikan format CSV valid.");
        }
      };
      reader.onerror = () => setParseErr("Gagal membaca file.");
      reader.readAsText(selectedFile, "UTF-8");
    },
    [template]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  function toggleRow(idx: number) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  const reset = () => {
    setFile(null);
    setPreview(null);
    setParseErr(null);
    setLogged(false);
    setExpandedRows(new Set());
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="space-y-5">
      {/* Template Info */}
      <div className="rounded-xl border bg-blue-50 border-blue-100 p-4 flex items-start gap-3">
        <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
        <div className="text-sm text-blue-700">
          <span className="font-semibold">{template.name}</span>
          {" · "}
          {ENTITY_LABEL[template.entity_type] ?? template.entity_type}
          {" · "}
          {template.column_mappings.length} kolom dimapping
          {" · "}
          Delimiter:{" "}
          <code className="font-mono text-xs">
            {template.delimiter === "\t" ? "Tab" : `"${template.delimiter}"`}
          </code>
          {template.file_has_header ? "" : " · Tanpa header"}
        </div>
      </div>

      {/* Upload Zone */}
      {!preview && (
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className="cursor-pointer rounded-xl border-2 border-dashed border-gray-200 bg-gray-50 p-10 text-center hover:border-blue-300 hover:bg-blue-50 transition-colors"
        >
          <Upload className="mx-auto h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-700">
            {file ? file.name : "Seret & lepas file CSV di sini, atau klik untuk pilih file"}
          </p>
          <p className="mt-1 text-xs text-gray-400">Format: CSV / TSV · Maks 5 MB · Maks 200 baris preview</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
        </div>
      )}

      {parseErr && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <XCircle className="h-4 w-4 shrink-0" />
          {parseErr}
        </div>
      )}

      {/* Preview Result */}
      {preview && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl border bg-white p-4 shadow-sm text-center">
              <p className="text-2xl font-bold text-gray-900">{preview.totalRows.toLocaleString("id-ID")}</p>
              <p className="text-xs text-gray-500 mt-1">Total Baris</p>
            </div>
            <div className="rounded-xl border bg-green-50 border-green-100 p-4 shadow-sm text-center">
              <p className="text-2xl font-bold text-green-700">{preview.validRows.toLocaleString("id-ID")}</p>
              <p className="text-xs text-green-600 mt-1">Baris Valid</p>
            </div>
            <div className={`rounded-xl border p-4 shadow-sm text-center ${preview.errorRows > 0 ? "bg-red-50 border-red-100" : "bg-gray-50"}`}>
              <p className={`text-2xl font-bold ${preview.errorRows > 0 ? "text-red-600" : "text-gray-400"}`}>
                {preview.errorRows.toLocaleString("id-ID")}
              </p>
              <p className={`text-xs mt-1 ${preview.errorRows > 0 ? "text-red-500" : "text-gray-400"}`}>
                Baris Error
              </p>
            </div>
          </div>

          {/* Unmapped columns warning */}
          {preview.unmappedSourceColumns.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-medium">Kolom tidak di-mapping: </span>
                {preview.unmappedSourceColumns.map((c) => (
                  <code key={c} className="mr-1 rounded bg-amber-100 px-1 text-xs">{c}</code>
                ))}
                <span className="text-xs ml-1 text-amber-600">(kolom ini akan diabaikan saat import)</span>
              </div>
            </div>
          )}

          {/* Truncation notice */}
          {preview.totalRows > 200 && (
            <div className="flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-4 py-2 text-xs text-blue-600">
              <Info className="h-3.5 w-3.5 shrink-0" />
              Menampilkan 200 baris pertama dari {preview.totalRows.toLocaleString("id-ID")} baris.
            </div>
          )}

          {/* Preview Table */}
          <PreviewTable
            rows={preview.mappedRows}
            expandedRows={expandedRows}
            onToggleRow={toggleRow}
          />

          {/* Execution panel */}
          {logged && (
            <ImportExecutionClient
              templateId={template.id}
              templateName={template.name}
              entityType={template.entity_type as EntityType}
              fileName={file?.name ?? "unknown.csv"}
              validRows={preview.mappedRows.filter((r) => r.isValid)}
              invalidRows={preview.mappedRows.filter((r) => !r.isValid)}
              totalRows={preview.totalRows}
            />
          )}

          {/* Reset */}
          <div className="flex justify-end">
            <button onClick={reset}
              className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
              <RefreshCw className="h-3.5 w-3.5" />
              Ganti File
            </button>
          </div>
        </>
      )}

      {isPending && (
        <p className="text-xs text-gray-400">Mencatat audit log...</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview Table
// ---------------------------------------------------------------------------

function PreviewTable({
  rows, expandedRows, onToggleRow,
}: {
  rows: MappedRow[];
  expandedRows: Set<number>;
  onToggleRow: (idx: number) => void;
}) {
  if (rows.length === 0) {
    return <div className="py-8 text-center text-sm text-gray-400">Tidak ada data untuk ditampilkan.</div>;
  }

  const fields = rows[0]?.mapped.map((m) => m.targetField) ?? [];

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-3 py-2.5 text-left font-medium text-gray-500 w-12">#</th>
              {fields.map((f) => (
                <th key={f} className="px-3 py-2.5 text-left font-medium text-gray-500 whitespace-nowrap">
                  <code className="font-mono text-blue-600">{f}</code>
                </th>
              ))}
              <th className="px-3 py-2.5 text-center font-medium text-gray-500 w-20">Status</th>
              <th className="px-3 py-2.5 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {rows.map((row) => (
              <>
                <tr
                  key={row.rowIndex}
                  onClick={() => onToggleRow(row.rowIndex)}
                  className={`cursor-pointer hover:bg-gray-50 ${!row.isValid ? "bg-red-50/40" : ""}`}
                >
                  <td className="px-3 py-2 text-gray-400">{row.rowIndex}</td>
                  {row.mapped.map((field) => (
                    <td key={field.targetField} className={`px-3 py-2 ${field.hasError ? "text-red-600" : "text-gray-800"}`}>
                      <span className="block max-w-[140px] truncate" title={field.transformedValue || "—"}>
                        {field.transformedValue || (
                          <span className="text-gray-300 italic">
                            {field.rawValue ? "(transform gagal)" : "—"}
                          </span>
                        )}
                      </span>
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center">
                    {row.isValid ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mx-auto" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-500 mx-auto" />
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-300">
                    {expandedRows.has(row.rowIndex)
                      ? <ChevronUp className="h-3.5 w-3.5" />
                      : <ChevronDown className="h-3.5 w-3.5" />}
                  </td>
                </tr>

                {expandedRows.has(row.rowIndex) && (
                  <tr key={`${row.rowIndex}-detail`} className="bg-gray-50/80">
                    <td colSpan={fields.length + 3} className="px-4 py-3">
                      <RowDetail row={row} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowDetail({ row }: { row: MappedRow }) {
  return (
    <div className="space-y-2">
      {row.errors.length > 0 && (
        <div className="mb-2">
          {row.errors.map((e, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs text-red-600">
              <XCircle className="h-3 w-3 shrink-0" />
              {e}
            </div>
          ))}
        </div>
      )}
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-left text-gray-400">
            <th className="pb-1 pr-3 font-normal">Kolom File</th>
            <th className="pb-1 pr-3 font-normal">Nilai Asli</th>
            <th className="pb-1 pr-3 font-normal">→ Nilai Setelah Transform</th>
            <th className="pb-1 pr-3 font-normal">Field Sistem</th>
            <th className="pb-1 font-normal">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {row.mapped.map((f) => (
            <tr key={f.targetField}>
              <td className="py-1 pr-3 font-mono text-gray-500">{f.sourceColumn}</td>
              <td className="py-1 pr-3 text-gray-600">{f.rawValue || <em className="text-gray-300">kosong</em>}</td>
              <td className={`py-1 pr-3 font-medium ${f.hasError ? "text-red-600" : "text-gray-800"}`}>
                {f.transformedValue || (f.defaultValue ? `(default: ${f.defaultValue})` : <em className="text-gray-300">kosong</em>)}
              </td>
              <td className="py-1 pr-3">
                <code className="rounded bg-blue-50 px-1 text-blue-700">{f.targetField}</code>
                {f.isRequired && <span className="ml-1 text-red-400">*</span>}
                {f.targetType === "custom" && <span className="ml-1 text-purple-500">(custom)</span>}
              </td>
              <td className="py-1">
                {f.hasError
                  ? <span className="text-red-500">{f.errorMessage}</span>
                  : <CheckCircle2 className="h-3 w-3 text-green-400" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
