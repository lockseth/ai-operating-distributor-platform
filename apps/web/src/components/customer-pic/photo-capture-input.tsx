"use client";

// =============================================================================
// Input foto opsional (ambil dari kamera HP) -- dipakai untuk foto depan
// toko & foto PIC. Ketiadaan foto TIDAK PERNAH menghalangi submit form
// (keputusan Pak Waluyo, toko yang mau transaksi CASH cepat tidak wajib
// isi ini). Upload terjadi saat file dipilih (bukan saat submit form),
// hasilnya (path storage) dilaporkan ke parent lewat onUploaded.
// =============================================================================

import { useState, useRef } from "react";
import { Camera, Loader2, CheckCircle2, X } from "lucide-react";
import { uploadStorePhotoAction } from "@/lib/customer-pic/actions";

interface PhotoCaptureInputProps {
  label: string;
  onUploaded: (path: string | null) => void;
}

export function PhotoCaptureInput({ label, onUploaded }: PhotoCaptureInputProps) {
  const [status, setStatus] = useState<"idle" | "uploading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setStatus("uploading");
    setPreviewUrl(URL.createObjectURL(file));

    const formData = new FormData();
    formData.append("file", file);
    const result = await uploadStorePhotoAction(formData);

    if (!result.ok || !result.path) {
      setStatus("error");
      setError(result.error ?? "Gagal mengunggah foto.");
      onUploaded(null);
      return;
    }
    setStatus("done");
    onUploaded(result.path);
  }

  function reset() {
    setStatus("idle");
    setError(null);
    setPreviewUrl(null);
    onUploaded(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        {label} <span className="text-gray-400 font-normal">(opsional)</span>
      </label>

      {previewUrl ? (
        <div className="flex items-center gap-3 rounded-lg border border-gray-200 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={label} className="h-14 w-14 rounded object-cover" />
          <div className="flex-1 text-xs">
            {status === "uploading" && (
              <span className="flex items-center gap-1.5 text-gray-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Mengunggah...
              </span>
            )}
            {status === "done" && (
              <span className="flex items-center gap-1.5 text-green-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> Foto tersimpan
              </span>
            )}
            {status === "error" && <span className="text-red-600">{error}</span>}
          </div>
          <button type="button" onClick={reset} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <label className="flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2.5 text-xs text-gray-500 hover:bg-gray-50 cursor-pointer">
          <Camera className="h-4 w-4" />
          Ambil / pilih foto
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
      )}
    </div>
  );
}
