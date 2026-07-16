// =============================================================================
// FlowSales AI — Shared Utilities
// Product-agnostic helpers reusable across all packages and apps.
// =============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SYSTEM_ROLES = [
  "super_admin",
  "owner",
  "manager",
  "sales",
  "admin",
  "warehouse",
  "finance",
  "driver",
] as const;

export const ORDER_STATUSES = [
  "draft",
  "confirmed",
  "processing",
  "delivering",
  "delivered",
  "invoiced",
  "paid",
  "cancelled",
] as const;

export const PERMISSION_MODULES = [
  "companies",
  "users",
  "products",
  "customers",
  "orders",
  "reports",
  "settings",
  "ai",
  "automation",
] as const;

export const PERMISSION_ACTIONS = [
  "view",
  "create",
  "update",
  "delete",
  "export",
  "manage",
] as const;

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatCurrency(
  amount: number,
  currency = "IDR",
  locale = "id-ID"
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(
  date: string | Date,
  locale = "id-ID",
  options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, options).format(d);
}

export function formatRelativeDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Hari ini";
  if (diffDays === 1) return "Kemarin";
  if (diffDays < 7) return `${diffDays} hari lalu`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} minggu lalu`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} bulan lalu`;
  return `${Math.floor(diffDays / 365)} tahun lalu`;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidPhone(phone: string): boolean {
  return /^(\+62|62|0)[0-9]{8,13}$/.test(phone.replace(/\s/g, ""));
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug);
}

// ---------------------------------------------------------------------------
// String Utilities
// ---------------------------------------------------------------------------

export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-");
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

export function generateOrderNumber(prefix = "SO"): string {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${year}${month}${day}-${random}`;
}

// ---------------------------------------------------------------------------
// RBAC Utilities
// ---------------------------------------------------------------------------

export function buildPermissionKey(module: string, action: string): string {
  return `${module}.${action}`;
}

export function hasPermission(
  userPermissions: string[],
  module: string,
  action: string
): boolean {
  const key = buildPermissionKey(module, action);
  return (
    userPermissions.includes(key) ||
    userPermissions.includes(buildPermissionKey(module, "manage")) ||
    userPermissions.includes("*")
  );
}

// ---------------------------------------------------------------------------
// Tenant Policy — typed reader (AI Decision Kernel Foundation Gate)
//
// Pure, tanpa I/O — domain tetap bertanggung jawab query ke tabel `settings`
// sendiri (tenant/company scoping adalah keputusan domain, bukan shared
// helper). Ini hanya menstandardisasi KEY NAMING (namespace.key, pola sama
// seperti buildPermissionKey) dan FALLBACK EXTRACTION agar tidak setiap
// domain menulis logic cast/fallback-nya sendiri.
// ---------------------------------------------------------------------------

import type { JsonValue, TenantPolicySettings } from "@flowsales/types";

export function buildPolicyKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

/**
 * Ekstrak satu nilai typed dari map settings (hasil query `settings` table
 * yang sudah di-load domain). Key tidak ditemukan / null -> fallback.
 * Tidak melakukan validasi tipe runtime (caller yang tahu bentuk aslinya) —
 * ini murni standarisasi lookup+fallback, bukan schema validator.
 */
export function readTenantPolicy<T extends JsonValue>(
  settings: TenantPolicySettings,
  key: string,
  fallback: T
): T {
  const value = settings[key];
  return value === undefined || value === null ? fallback : (value as T);
}
