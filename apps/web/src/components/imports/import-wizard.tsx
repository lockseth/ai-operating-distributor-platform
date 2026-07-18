"use client";

// =============================================================================
// Wizard Tambah Import -- satu halaman, step internal (bukan multi-route)
// supaya state (batchId, mapping, preview) gampang dikelola tanpa
// round-trip URL. Mengikuti alur LANGKAH 13: pilih jenis -> download
// template -> upload -> mapping -> preview -> validasi -> reconciliation ->
// commit -> hasil.
// =============================================================================

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Download, CheckCircle2, AlertTriangle, XCircle, Loader2, ArrowRight, Save } from "lucide-react";
import { IMPORT_TYPES, IMPORT_TYPE_LABEL, DOMAIN_FIELDS, type ImportType, type ColumnMapping, type ImportBatchStatus, type ReconciliationSummary } from "@/lib/imports/types";
import { uploadImportFileAction, validateImportBatchAction, commitImportBatchAction, saveMappingProfileAction, listMappingProfilesAction } from "@/lib/imports/actions";
import type { MappingProfile } from "@/lib/data-onboarding/core/types";
import { deriveImportStatusLabel, IMPORT_STATUS_TONE_CLASSES } from "@/lib/data-onboarding/core/status-label";

type Step = "select" | "upload" | "sheet-select" | "mapping" | "validated" | "committed";

export function ImportWizard() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("select");
  const [importType, setImportType] = useState<ImportType>("CUSTOMER_PIC");
  const [sourceSystem, setSourceSystem] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [batchId, setBatchId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);

  // File dipegang di browser (bukan server) supaya bisa dikirim ulang dengan
  // sheetName setelah admin memilih worksheet -- tidak ada state file di server.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheetPreviews, setSheetPreviews] = useState<Record<string, { headers: string[]; previewRows: string[][] }>>({});

  const [summary, setSummary] = useState<{
    totalRows: number; validRows: number; warningRows: number; errorRows: number; duplicateRows: number; readyToCommit: boolean;
    status: ImportBatchStatus; reconciliation: ReconciliationSummary | Record<string, never>;
  } | null>(null);
  const [commitResult, setCommitResult] = useState<{ createdCount: number; updatedCount: number } | null>(null);
  const [duplicateFileWarning, setDuplicateFileWarning] = useState<string | null>(null);

  // Saved mapping profile (addendum "SAVED IMPORT PROFILE") -- tenant bisa
  // menyimpan/menerapkan ulang mapping kolom per (jenis import, sumber data),
  // supaya tidak perlu mapping ulang tiap kali import dari sumber yang sama.
  const [savedProfiles, setSavedProfiles] = useState<MappingProfile[]>([]);
  const [profileName, setProfileName] = useState("");
  const [profileMessage, setProfileMessage] = useState<string | null>(null);

  useEffect(() => {
    if (step !== "mapping") return;
    listMappingProfilesAction(importType).then((result) => {
      if (result.ok && result.data) setSavedProfiles(result.data.filter((p) => p.sourceSystem === sourceSystem));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, importType]);

  function applyProfile(profileId: string) {
    const profile = savedProfiles.find((p) => p.id === profileId);
    if (profile) setMapping(profile.columnMappings);
  }

  function handleSaveProfile() {
    if (!profileName.trim()) { setProfileMessage("Nama profil wajib diisi."); return; }
    setProfileMessage(null);
    startTransition(async () => {
      const result = await saveMappingProfileAction({ importType, sourceSystem, profileName, columnMappings: mapping });
      if (!result.ok) { setProfileMessage(result.error ?? "Gagal menyimpan profil."); return; }
      setProfileMessage(`Profil "${profileName}" tersimpan (v${result.data?.version}).`);
      const list = await listMappingProfilesAction(importType);
      if (list.ok && list.data) setSavedProfiles(list.data.filter((p) => p.sourceSystem === sourceSystem));
    });
  }

  function targetFieldFor(sourceColumn: string): string {
    return mapping.find((m) => m.sourceColumn === sourceColumn)?.targetField ?? "";
  }

  function setTargetField(sourceColumn: string, targetField: string) {
    setMapping((prev) => {
      const next = prev.filter((m) => m.sourceColumn !== sourceColumn);
      if (targetField) next.push({ sourceColumn, targetField });
      return next;
    });
  }

  function submitUpload(file: File, sheetName?: string) {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("importType", importType);
      fd.set("sourceSystem", sourceSystem);
      if (sheetName) fd.set("sheetName", sheetName);
      const result = await uploadImportFileAction(fd);
      if (!result.ok || !result.data) {
        setError(result.error ?? "Gagal mengupload file.");
        return;
      }
      if (result.data.needsSheetSelection) {
        setPendingFile(file);
        setSheetNames(result.data.sheetNames);
        setSheetPreviews(result.data.sheetPreviews);
        setStep("sheet-select");
        return;
      }
      setBatchId(result.data.batchId);
      setHeaders(result.data.headers);
      setMapping(result.data.suggestedMapping);
      setPreviewRows(result.data.previewRows);
      setTotalRows(result.data.totalRows);
      setSelectedSheet(result.data.selectedSheet);
      setStep("mapping");
    });
  }

  function handleUpload(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const form = formEvent.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) { setError("Pilih file terlebih dahulu."); return; }
    if (!sourceSystem.trim()) { setError("Sistem sumber wajib diisi."); return; }
    submitUpload(file);
  }

  function handleSelectSheet(sheetName: string) {
    if (!pendingFile) return;
    submitUpload(pendingFile, sheetName);
  }

  function handleValidate() {
    if (!batchId) return;
    setError(null);
    startTransition(async () => {
      const result = await validateImportBatchAction({ batchId, columnMappings: mapping });
      if (!result.ok) { setError(result.error ?? "Validasi gagal."); return; }
      const detail = await import("@/lib/imports/actions").then((m) => m.getImportBatchDetailAction(batchId));
      if (detail.ok && detail.data) {
        setSummary({
          totalRows: detail.data.batch.totalRows, validRows: detail.data.batch.validRows,
          warningRows: detail.data.batch.warningRows, errorRows: detail.data.batch.errorRows,
          duplicateRows: detail.data.batch.duplicateRows, readyToCommit: result.data!.readyToCommit,
          status: detail.data.batch.status, reconciliation: detail.data.batch.reconciliation,
        });
      }
      setStep("validated");
    });
  }

  function handleCommit(acknowledgeDuplicateFile = false) {
    if (!batchId) return;
    setError(null);
    setDuplicateFileWarning(null);
    startTransition(async () => {
      const result = await commitImportBatchAction({ batchId, acknowledgeDuplicateFile });
      if (!result.ok) {
        if (result.error?.includes("sudah pernah di-commit")) {
          setDuplicateFileWarning(result.error);
          return;
        }
        setError(result.error ?? "Commit gagal.");
        return;
      }
      setCommitResult(result.data ?? null);
      setStep("committed");
      router.refresh();
    });
  }

  const fields = DOMAIN_FIELDS[importType];

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <XCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Step 1: pilih jenis + source system + template (opsional) */}
      {step === "select" && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">1. Pilih Jenis Data</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {IMPORT_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => setImportType(t)}
                className={`rounded-lg border p-3 text-left text-sm transition ${importType === t ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-200 hover:bg-gray-50"}`}
              >
                <div className="font-medium">{IMPORT_TYPE_LABEL[t]}</div>
              </button>
            ))}
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Sistem sumber (nama software/CRM lama)</label>
            <input
              value={sourceSystem}
              onChange={(e) => setSourceSystem(e.target.value)}
              placeholder="mis. Excel Manual, SIMS, MyDistributor"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>

          <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-2">
            <p className="text-xs font-medium text-gray-700">Template Import (Opsional)</p>
            <p className="text-xs text-gray-500">
              Gunakan template jika data Anda belum memiliki format yang rapi. Jika sudah mempunyai file CSV/XLSX
              dari sistem lama, langsung lanjutkan ke upload dan cocokkan kolom pada tahap mapping.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={`/api/imports/templates/${importType}?format=csv`}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Download className="h-3.5 w-3.5" />
                Unduh Contoh CSV
              </a>
              <a
                href={`/api/imports/templates/${importType}?format=xlsx`}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Download className="h-3.5 w-3.5" />
                Unduh Contoh XLSX
              </a>
            </div>
            <p className="text-[11px] text-gray-400">XLSX cocok untuk pengguna Excel. CSV cocok untuk export dari aplikasi lama.</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => sourceSystem.trim() ? setStep("upload") : setError("Sistem sumber wajib diisi.")}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
            >
              Lanjut ke Upload <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Step 2: upload */}
      {step === "upload" && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">2. Upload File CSV/XLSX -- {IMPORT_TYPE_LABEL[importType]}</h2>
          <form onSubmit={handleUpload} className="space-y-3">
            <input type="file" name="file" accept=".csv,.xlsx" className="block w-full text-sm" />
            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={isPending}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Upload
              </button>
              <button type="button" onClick={() => setStep("select")} className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
                Kembali
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Step 2b: pilih worksheet (hanya jika XLSX >1 sheet) */}
      {step === "sheet-select" && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">Pilih Worksheet ({sheetNames.length} sheet ditemukan)</h2>
          <p className="text-xs text-gray-500">File Excel ini punya lebih dari satu sheet. Pilih SATU sheet yang berisi data {IMPORT_TYPE_LABEL[importType]} -- sheet tidak digabung otomatis.</p>
          <div className="space-y-2">
            {sheetNames.map((name) => (
              <button
                key={name}
                onClick={() => handleSelectSheet(name)}
                disabled={isPending}
                className="block w-full rounded-lg border border-gray-200 p-3 text-left text-sm hover:border-blue-300 hover:bg-blue-50 disabled:opacity-60"
              >
                <div className="font-medium text-gray-900">{name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Kolom: {sheetPreviews[name]?.headers.slice(0, 5).join(", ")}{(sheetPreviews[name]?.headers.length ?? 0) > 5 ? ", ..." : ""}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step 3: mapping + preview */}
      {step === "mapping" && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-gray-900">
            3. Mapping Kolom ({totalRows} baris terbaca{selectedSheet ? ` -- sheet "${selectedSheet}"` : ""})
          </h2>

          {savedProfiles.length > 0 && (
            <div>
              <label className="mb-1 block text-xs text-gray-500">Terapkan profil mapping tersimpan (sumber: {sourceSystem || "-"})</label>
              <select
                defaultValue=""
                onChange={(e) => e.target.value && applyProfile(e.target.value)}
                className="w-full max-w-sm rounded-lg border border-gray-200 px-3 py-2 text-xs"
              >
                <option value="">-- pilih profil --</option>
                {savedProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.profileName} (v{p.version})</option>
                ))}
              </select>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-1.5 pr-3">Kolom di File</th>
                  <th className="py-1.5">Dipetakan ke</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h} className="border-b border-gray-50">
                    <td className="py-1.5 pr-3 font-mono">{h}</td>
                    <td className="py-1.5">
                      <select
                        value={targetFieldFor(h)}
                        onChange={(e) => setTargetField(h, e.target.value)}
                        className="w-full rounded border border-gray-200 px-2 py-1 text-xs"
                      >
                        <option value="">-- lewati --</option>
                        {fields.map((f) => (
                          <option key={f.key} value={f.key}>{f.label}{f.required ? " *" : ""}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">Preview {Math.min(previewRows.length, 5)} dari {totalRows} baris:</p>
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-xs">
                <thead><tr className="bg-gray-50">{headers.map((h) => <th key={h} className="px-2 py-1 text-left font-medium text-gray-500">{h}</th>)}</tr></thead>
                <tbody>
                  {previewRows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-t border-gray-50">{r.map((c, j) => <td key={j} className="px-2 py-1 text-gray-700">{c}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <input
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="Nama profil mapping (mis. Excel Toko Pak Waluyo v1)"
              className="w-64 rounded-lg border border-gray-200 px-3 py-2 text-xs"
            />
            <button
              type="button"
              onClick={handleSaveProfile}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              <Save className="h-3.5 w-3.5" />
              Simpan Mapping Ini
            </button>
            {profileMessage && <span className="text-xs text-gray-500">{profileMessage}</span>}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleValidate}
              disabled={isPending}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Validasi
            </button>
          </div>
        </div>
      )}

      {/* Step 4: hasil validasi + reconciliation + commit */}
      {step === "validated" && summary && (
        <div className="rounded-xl border bg-white p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">4. Hasil Validasi</h2>
            {(() => {
              const status = deriveImportStatusLabel({
                status: summary.status, errorRows: summary.errorRows, warningRows: summary.warningRows, reconciliation: summary.reconciliation,
              });
              return <span className={`rounded-full px-3 py-1 text-xs font-medium ${IMPORT_STATUS_TONE_CLASSES[status.tone]}`}>{status.label}</span>;
            })()}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Total" value={summary.totalRows} />
            <Stat label="Valid" value={summary.validRows} icon={<CheckCircle2 className="h-3.5 w-3.5 text-green-500" />} />
            <Stat label="Warning" value={summary.warningRows} icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />} />
            <Stat label="Duplicate" value={summary.duplicateRows} />
            <Stat label="Error" value={summary.errorRows} icon={<XCircle className="h-3.5 w-3.5 text-red-500" />} />
          </div>

          {!summary.readyToCommit && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
              Batch belum siap di-commit -- ada error kritikal atau reconciliation tidak seimbang. Lihat detail baris di halaman batch setelah ini.
            </div>
          )}

          {duplicateFileWarning && (
            <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <p>{duplicateFileWarning}</p>
              <button
                onClick={() => handleCommit(true)}
                className="rounded-lg border border-amber-300 px-3 py-1.5 text-xs font-medium hover:bg-amber-100"
              >
                Tetap Commit (Saya Sengaja)
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleCommit(false)}
              disabled={isPending || !summary.readyToCommit}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-60"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Commit Import
            </button>
            {batchId && (
              <a href={`/dashboard/imports/${batchId}`} className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
                Lihat Detail Baris
              </a>
            )}
          </div>
        </div>
      )}

      {/* Step 5: hasil commit */}
      {step === "committed" && commitResult && batchId && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-6 shadow-sm space-y-2">
          <div className="flex items-center gap-2 text-green-700">
            <CheckCircle2 className="h-5 w-5" />
            <h2 className="text-sm font-semibold">Import berhasil di-commit</h2>
          </div>
          <p className="text-xs text-green-700">{commitResult.createdCount} data baru dibuat, {commitResult.updatedCount} data diperbarui.</p>
          <a href={`/dashboard/imports/${batchId}`} className="inline-block rounded-lg bg-green-600 px-4 py-2 text-xs font-medium text-white hover:bg-green-700">
            Lihat Detail Batch
          </a>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, icon }: { label: string; value: number; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-100 p-2.5">
      <div className="flex items-center gap-1 text-[11px] text-gray-500">{icon}{label}</div>
      <div className="text-base font-semibold text-gray-900">{value}</div>
    </div>
  );
}
