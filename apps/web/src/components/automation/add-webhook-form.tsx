"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createN8nWebhookAction } from "@/lib/automation/actions";
import { TRIGGER_LABELS } from "@/lib/automation/trigger-labels";
import { Plus, Loader2, X } from "lucide-react";

interface AddWebhookFormProps {
  canManage: boolean;
}

export function AddWebhookForm({ canManage }: AddWebhookFormProps) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!canManage) return null;

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await createN8nWebhookAction({ name, eventType, webhookUrl, secretKey });
      if (!result.ok) {
        setError(result.error ?? "Gagal menyimpan webhook.");
        return;
      }
      setName("");
      setEventType("");
      setWebhookUrl("");
      setSecretKey("");
      setIsOpen(false);
      router.refresh();
    });
  }

  if (!isOpen) {
    return (
      <div className="flex justify-end">
        <button
          onClick={() => setIsOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
        >
          <Plus className="h-3.5 w-3.5" /> Tambah Webhook
        </button>
      </div>
    );
  }

  return (
    <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900">Tambah Webhook Baru</p>
        <button
          onClick={() => setIsOpen(false)}
          className="text-gray-400 hover:text-gray-600"
          disabled={isPending}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-gray-600">Nama Webhook</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="mis. Bablast WA Notif"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            disabled={isPending}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Event Type</label>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            disabled={isPending}
          >
            <option value="">Pilih event…</option>
            {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs font-medium text-gray-600">URL Webhook (n8n)</label>
          <input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://n8n.domain.com/webhook/xxx"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
            disabled={isPending}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-xs font-medium text-gray-600">Secret Key (opsional)</label>
          <input
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder="Untuk verifikasi HMAC, kosongkan kalau tidak perlu"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono"
            disabled={isPending}
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button
        onClick={handleSubmit}
        disabled={isPending}
        className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        Simpan Webhook
      </button>
    </div>
  );
}
