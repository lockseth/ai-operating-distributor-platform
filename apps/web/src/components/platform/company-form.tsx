"use client";

import { useState, useTransition } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import type { CompanyFormData, SubscriptionPlan } from "@/lib/platform/tenant-actions";

interface CompanyFormProps {
  initialData?: CompanyFormData;
  action: (data: CompanyFormData) => Promise<void>;
  submitLabel?: string;
  cancelHref?: string;
}

const PLANS: { value: SubscriptionPlan; label: string; desc: string }[] = [
  { value: "trial",        label: "Trial",        desc: "30 hari gratis, fitur terbatas" },
  { value: "starter",      label: "Starter",      desc: "Hingga 3 user, 500 pelanggan" },
  { value: "professional", label: "Professional", desc: "Hingga 20 user, unlimited pelanggan" },
  { value: "enterprise",   label: "Enterprise",   desc: "Unlimited, SLA, dedicated support" },
];

const TIMEZONES = [
  "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura",
  "Asia/Singapore", "Asia/Kuala_Lumpur",
];
const CURRENCIES = ["IDR", "USD", "MYR", "SGD"];
const LANGUAGES  = [{ value: "id", label: "Bahasa Indonesia" }, { value: "en", label: "English" }];

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function CompanyForm({ initialData, action, submitLabel = "Simpan", cancelHref }: CompanyFormProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError]           = useState<string | null>(null);

  const [name,       setName]       = useState(initialData?.name ?? "");
  const [slug,       setSlug]       = useState(initialData?.slug ?? "");
  const [domain,     setDomain]     = useState(initialData?.domain ?? "");
  const [plan,       setPlan]       = useState<SubscriptionPlan>(initialData?.subscription_plan ?? "trial");
  const [brandColor, setBrandColor] = useState(initialData?.settings?.brand_color ?? "#2563EB");
  const [timezone,   setTimezone]   = useState(initialData?.settings?.timezone ?? "Asia/Jakarta");
  const [currency,   setCurrency]   = useState(initialData?.settings?.currency ?? "IDR");
  const [language,   setLanguage]   = useState(initialData?.settings?.language ?? "id");
  const [slugManual, setSlugManual] = useState(Boolean(initialData?.slug));

  function handleNameChange(v: string) {
    setName(v);
    if (!slugManual) setSlug(slugify(v));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError("Nama perusahaan wajib diisi"); return; }
    if (!slug.trim())  { setError("Slug wajib diisi"); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) { setError("Slug hanya boleh huruf kecil, angka, dan tanda hubung"); return; }

    const data: CompanyFormData = {
      name, slug, domain: domain || null, subscription_plan: plan,
      settings: { brand_color: brandColor, timezone, currency, language },
    };

    startTransition(async () => {
      try { await action(data); }
      catch (err) { setError(err instanceof Error ? err.message : "Terjadi kesalahan"); }
    });
  }

  const inputCls = "w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
  const labelCls = "block text-xs font-medium text-gray-700 mb-1";
  const section  = "rounded-xl border bg-white p-5 shadow-sm space-y-4";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Identitas Perusahaan */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Identitas Perusahaan</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelCls}>Nama Perusahaan <span className="text-red-500">*</span></label>
            <input type="text" value={name} onChange={(e) => handleNameChange(e.target.value)}
              placeholder="PT Distribusi Nusantara" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>
              Slug (URL identifier) <span className="text-red-500">*</span>
              <span className="ml-1 text-gray-400 font-normal">— unik, tidak bisa diubah sembarangan</span>
            </label>
            <div className="flex items-center gap-0">
              <span className="flex items-center rounded-l-lg border border-r-0 border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-400">
                aodp/
              </span>
              <input type="text" value={slug}
                onChange={(e) => { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")); setSlugManual(true); }}
                placeholder="nama-perusahaan"
                className="flex-1 rounded-r-lg border border-gray-200 px-3 py-2 text-sm font-mono text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Domain Kustom</label>
            <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)}
              placeholder="app.perusahaan.com" className={inputCls} />
            <p className="mt-1 text-xs text-gray-400">Opsional — untuk whitelabel</p>
          </div>
        </div>
      </div>

      {/* Subscription */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Subscription Plan</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PLANS.map((p) => (
            <label key={p.value}
              className={`flex flex-col gap-1 rounded-xl border-2 p-3 cursor-pointer transition-colors ${
                plan === p.value ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-gray-300"
              }`}>
              <input type="radio" name="plan" value={p.value} checked={plan === p.value}
                onChange={() => setPlan(p.value)} className="sr-only" />
              <span className={`text-sm font-semibold ${plan === p.value ? "text-blue-700" : "text-gray-800"}`}>
                {p.label}
              </span>
              <span className="text-xs text-gray-500">{p.desc}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Branding & Settings */}
      <div className={section}>
        <h2 className="text-sm font-semibold text-gray-900">Branding & Pengaturan</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls}>Warna Brand</label>
            <div className="flex items-center gap-3">
              <input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)}
                className="h-9 w-16 cursor-pointer rounded-lg border border-gray-200 p-1" />
              <input type="text" value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Zona Waktu</label>
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={inputCls}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Mata Uang</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Bahasa Interface</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
              {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {cancelHref && (
          <a href={cancelHref}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Batal
          </a>
        )}
        <button type="submit" disabled={isPending}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {isPending ? "Menyimpan..." : submitLabel}
        </button>
      </div>
    </form>
  );
}
