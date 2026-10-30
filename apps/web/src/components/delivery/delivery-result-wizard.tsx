"use client";

// Wizard hasil pengiriman (S2) untuk HP: pilih hasil -> isi detail -> foto &
// tanda tangan -> kirim. Validasi bukti otoritatif ada di server
// (submitDeliveryResultAction memakai lib/delivery/service.ts yang sama
// dengan jalur Telegram); di sini hanya UX cepat.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitDeliveryResultAction, uploadDeliveryEvidenceAction } from "@/lib/delivery/web-actions";
import { REASON_LABEL_ID, type GeoFix } from "@/lib/delivery/web-rules";
import type { DeliveryOutcome, ReasonCode } from "@/lib/delivery/types";

interface WizardItem {
  id: string;
  productName: string;
  unit: string | null;
  dispatchedQuantity: number;
}

const OUTCOMES: { value: DeliveryOutcome; label: string; hint: string }[] = [
  { value: "full", label: "Diterima penuh", hint: "Semua barang diterima toko" },
  { value: "partial", label: "Diterima sebagian", hint: "Sebagian barang diterima" },
  { value: "rejected", label: "Ditolak", hint: "Toko menolak semua barang" },
  { value: "store_closed", label: "Toko tutup", hint: "Tidak ada yang menerima" },
  { value: "failed", label: "Gagal antar", hint: "Kendala di jalan / alamat" },
];

const REASONS_BY_OUTCOME: Partial<Record<DeliveryOutcome, ReasonCode[]>> = {
  partial: ["CUSTOMER_PARTIAL_ACCEPTANCE", "ITEM_DAMAGED", "ITEM_MISMATCH", "QUANTITY_MISMATCH", "PRICE_OR_DISCOUNT_DISPUTE", "OTHER_REQUIRES_NOTE"],
  rejected: ["CUSTOMER_REJECTED", "ITEM_DAMAGED", "ITEM_MISMATCH", "PRICE_OR_DISCOUNT_DISPUTE", "RECIPIENT_NOT_AUTHORIZED", "OTHER_REQUIRES_NOTE"],
  failed: ["ADDRESS_NOT_FOUND", "VEHICLE_OR_DRIVER_ISSUE", "OTHER_REQUIRES_NOTE"],
};

function getPosition(): Promise<GeoFix | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    );
  });
}

/** Perkecil foto kamera HP (maks 1600px, JPEG) supaya hemat kuota & cepat terunggah. */
async function shrinkPhoto(file: File): Promise<File> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
    return blob ? new File([blob], "foto.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file; // format tak terbaca browser (mis. HEIC): kirim apa adanya
  }
}

function SignaturePad({ onChange }: { onChange: (blob: Blob | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width, y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height };
  }
  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = e.currentTarget.getContext("2d");
    const p = pos(e);
    ctx?.beginPath();
    ctx?.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#111827";
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    setHasInk(true);
    canvasRef.current?.toBlob((b) => onChange(b), "image/png");
  }
  function clear() {
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    onChange(null);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={600}
        height={240}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="w-full touch-none rounded-xl border border-gray-300 bg-white"
        aria-label="Area tanda tangan penerima"
      />
      <div className="mt-1 flex justify-between text-xs text-gray-500">
        <span>{hasInk ? "Tanda tangan terisi" : "Minta penerima tanda tangan di kotak ini"}</span>
        <button type="button" onClick={clear} className="font-semibold text-blue-600">Hapus</button>
      </div>
    </div>
  );
}

export function DeliveryResultWizard({ deliveryId, items }: { deliveryId: string; items: WizardItem[] }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<DeliveryOutcome | null>(null);
  const [received, setReceived] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<ReasonCode | "">("");
  const [note, setNote] = useState("");
  const [recipient, setRecipient] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [signature, setSignature] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const needsRecipient = outcome === "full" || outcome === "partial";
  const needsSignature = needsRecipient;
  const needsPhoto = outcome !== "failed";
  const reasons = outcome ? REASONS_BY_OUTCOME[outcome] : undefined;

  async function upload(file: File | Blob, name: string): Promise<string> {
    const fd = new FormData();
    fd.set("deliveryId", deliveryId);
    fd.set("file", file instanceof File ? file : new File([file], name, { type: file.type || "image/png" }));
    const res = await uploadDeliveryEvidenceAction(fd);
    if (!res.ok || !res.path) throw new Error(res.error ?? "Gagal mengunggah bukti.");
    return res.path;
  }

  function submit() {
    if (!outcome) return;
    setError(null);
    startTransition(async () => {
      try {
        const fix = await getPosition();
        const photoPaths: string[] = [];
        for (const f of photos) photoPaths.push(await upload(await shrinkPhoto(f), "foto.jpg"));
        const signaturePath = needsSignature && signature ? await upload(signature, "ttd.png") : null;
        const receivedByItem: Record<string, number> = {};
        if (outcome === "partial") for (const it of items) receivedByItem[it.id] = Number(received[it.id] ?? "");

        const result = await submitDeliveryResultAction({
          deliveryId,
          outcome,
          receivedByItem,
          reasonCode: outcome === "store_closed" ? "STORE_CLOSED" : reason || null,
          reasonNote: note || null,
          recipientName: needsRecipient ? recipient || null : null,
          photoPaths,
          signaturePath,
          fix,
        });
        if (!result.ok) {
          setError(result.error ?? "Gagal mengirim hasil.");
          return;
        }
        router.push("/dashboard/deliveries");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Terjadi kesalahan.");
      }
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-semibold text-gray-900">Bagaimana hasil pengirimannya?</p>
        <div className="grid grid-cols-1 gap-2">
          {OUTCOMES.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { setOutcome(o.value); setReason(""); setError(null); }}
              className={`rounded-xl border p-3 text-left ${outcome === o.value ? "border-blue-600 bg-blue-50" : "border-gray-200 bg-white"}`}
            >
              <p className="font-semibold text-gray-900">{o.label}</p>
              <p className="text-xs text-gray-500">{o.hint}</p>
            </button>
          ))}
        </div>
      </div>

      {outcome === "partial" && (
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <p className="mb-2 text-sm font-semibold text-gray-900">Jumlah yang diterima toko</p>
          {items.map((it) => (
            <label key={it.id} className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="text-gray-800">{it.productName} <span className="text-xs text-gray-500">(dikirim {it.dispatchedQuantity} {it.unit ?? ""})</span></span>
              <input
                type="number" inputMode="decimal" min={0} max={it.dispatchedQuantity}
                value={received[it.id] ?? ""}
                onChange={(e) => setReceived((p) => ({ ...p, [it.id]: e.target.value }))}
                className="w-24 rounded-lg border border-gray-300 px-2 py-2 text-right"
              />
            </label>
          ))}
        </div>
      )}

      {reasons && (
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-gray-900">Alasan</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as ReasonCode)} className="w-full rounded-xl border border-gray-300 bg-white px-3 py-3">
            <option value="">Pilih alasan…</option>
            {reasons.map((r) => <option key={r} value={r}>{REASON_LABEL_ID[r]}</option>)}
          </select>
        </label>
      )}

      {outcome && (reasons || outcome === "store_closed") && (
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-gray-900">Catatan {reason === "OTHER_REQUIRES_NOTE" ? "(wajib)" : "(opsional)"}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="w-full rounded-xl border border-gray-300 px-3 py-2" />
        </label>
      )}

      {needsRecipient && (
        <label className="block text-sm">
          <span className="mb-1 block font-semibold text-gray-900">Nama penerima di toko</span>
          <input value={recipient} onChange={(e) => setRecipient(e.target.value)} className="w-full rounded-xl border border-gray-300 px-3 py-3" placeholder="mis. Bu Sari" />
        </label>
      )}

      {outcome && needsPhoto && (
        <div className="text-sm">
          <span className="mb-1 block font-semibold text-gray-900">Foto bukti {photos.length > 0 && `(${photos.length})`}</span>
          <input
            type="file" accept="image/*" capture="environment" multiple
            onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-blue-600 file:px-4 file:py-3 file:font-semibold file:text-white"
          />
        </div>
      )}

      {outcome && needsSignature && (
        <div className="text-sm">
          <span className="mb-1 block font-semibold text-gray-900">Tanda tangan penerima</span>
          <SignaturePad onChange={setSignature} />
        </div>
      )}

      {outcome === "store_closed" && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          Toko tutup wajib disertai lokasi. Izinkan akses lokasi di browser saat menekan Kirim.
        </p>
      )}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {outcome && (
        <button
          type="button" disabled={isPending} onClick={submit}
          className="w-full rounded-xl bg-green-600 px-4 py-3 text-base font-semibold text-white disabled:opacity-60"
        >
          {isPending ? "Mengirim hasil…" : "Kirim Hasil Pengiriman"}
        </button>
      )}
    </div>
  );
}
