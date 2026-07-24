// =============================================================================
// Gate 1D-A -- format & safety helper untuk halaman Owner "Activity & Audit Log".
//
// Timezone helper LOKAL ke modul ini (bukan reuse lib/n8n-automation/timezone.ts
// -- file itu eksplisit mendokumentasikan dirinya "HANYA dipakai kode automation
// baru", jadi audit-log punya instance sendiri, teknik sama: Intl.DateTimeFormat
// dengan timeZone eksplisit, bukan offset manual).
//
// redactSensitive() adalah defense-in-depth di sisi READ: kontrak Gate 1D
// mewajibkan writer TIDAK PERNAH mencatat token/password/session/api key/
// credential/authorization header, tapi karena retrofit writer existing baru
// terjadi di Gate 1D-B/C, halaman ini memfilter field bernama sensitif dari
// old_data/new_data/metadata SEBELUM dirender -- bukan pengganti kepatuhan
// writer, hanya lapisan aman tambahan supaya field yang lolos tidak pernah
// sampai ke UI.
// =============================================================================

const AUDIT_LOG_TIMEZONE = "Asia/Jakarta";

export function formatJakartaDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const formatted = new Intl.DateTimeFormat("id-ID", {
    timeZone: AUDIT_LOG_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${formatted} WIB`;
}

const SENSITIVE_KEY_PATTERN =
  /token|password|passwd|secret|session|api[_-]?key|authorization|credential|pairing[_-]?secret/i;

/** Menghapus field dengan nama sensitif dari objek JSON secara rekursif, aman untuk dirender. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1));
  if (typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "••••••" : redactSensitive(val, depth + 1);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "kosong";
  if (typeof value === "boolean") return value ? "ya" : "tidak";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Ringkasan perubahan before/after yang aman dibaca -- BUKAN dump JSON mentah.
 * Deteksi "apakah berubah" memakai nilai MENTAH (sebelum redaksi) supaya field
 * sensitif yang benar-benar berubah tetap terlihat sebagai perubahan (nilai
 * tampilan tetap di-mask) -- bukan malah tersembunyi total seolah tidak
 * berubah karena mask sebelum/sesudahnya kebetulan sama ("••••••").
 */
export function summarizeChange(oldData: unknown, newData: unknown): string[] {
  if (!isPlainObject(oldData) && !isPlainObject(newData)) return [];

  const rawBefore = isPlainObject(oldData) ? oldData : {};
  const rawAfter = isPlainObject(newData) ? newData : {};
  const displayBefore = redactSensitive(oldData) as Record<string, unknown>;
  const displayAfter = redactSensitive(newData) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(rawBefore), ...Object.keys(rawAfter)])];

  const lines: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(rawBefore[key]) === JSON.stringify(rawAfter[key])) continue;
    if (key in rawBefore && key in rawAfter) {
      lines.push(`${key}: ${formatScalar(displayBefore[key])} → ${formatScalar(displayAfter[key])}`);
    } else if (key in rawAfter) {
      lines.push(`${key}: ditambahkan (${formatScalar(displayAfter[key])})`);
    } else {
      lines.push(`${key}: dihapus (sebelumnya ${formatScalar(displayBefore[key])})`);
    }
  }
  return lines;
}

export const ACTOR_TYPE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  admin: "Admin",
  sales: "Sales",
  finance: "Finance",
  warehouse: "Warehouse",
  driver: "Driver",
  super_admin: "Super Admin",
  ai: "AI",
  system: "Sistem",
};

export const EVENT_CATEGORY_LABELS: Record<string, string> = {
  audit: "Audit (perubahan data)",
  activity: "Aktivitas",
  security: "Keamanan",
};

export const SOURCE_LABELS: Record<string, string> = {
  web: "Web",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  ai: "AI",
  automation: "Automation",
  rpc: "RPC",
};

export const OUTCOME_LABELS: Record<string, string> = {
  success: "Berhasil",
  rejected: "Ditolak",
  unchanged: "Tidak berubah",
  failed: "Gagal",
};
