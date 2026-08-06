// =============================================================================
// Feature flags — platform-level (global, lintas tenant) kill switch.
//
// Gate 3E-D4-C6: dibaca HANYA lewat service-role admin client dari server
// (Supabase RLS pada platform_feature_flags menolak akses non-super_admin,
// lihat migration 20260928000001). Fail-closed: baris tidak ada, kolom
// bukan boolean, atau query gagal (network/DB error) SELALU dianggap OFF --
// tidak pernah default ON pada kondisi tak terduga apa pun.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type PlatformFeatureFlagKey = "telegram_sales_orders";

export interface FeatureFlagRepository {
  isEnabled(key: PlatformFeatureFlagKey): Promise<boolean>;
}

export class SupabaseFeatureFlagRepository implements FeatureFlagRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async isEnabled(key: PlatformFeatureFlagKey): Promise<boolean> {
    try {
      const { data, error } = await this.supabase
        .from("platform_feature_flags")
        .select("enabled")
        .eq("key", key)
        .maybeSingle();

      if (error) {
        console.error(`[FeatureFlag] gagal membaca '${key}':`, error);
        return false;
      }
      if (!data) return false;

      const enabled = (data as { enabled: unknown }).enabled;
      if (typeof enabled !== "boolean") {
        console.error(`[FeatureFlag] nilai '${key}' malformed (bukan boolean):`, enabled);
        return false;
      }
      return enabled;
    } catch (err) {
      console.error(`[FeatureFlag] exception membaca '${key}':`, err);
      return false;
    }
  }
}

/** Test-only: seedable in-memory implementation. Default OFF -- fail-closed juga di fixture test. */
export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  private overrides = new Map<PlatformFeatureFlagKey, boolean>();

  seedFlag(key: PlatformFeatureFlagKey, enabled: boolean): void {
    this.overrides.set(key, enabled);
  }

  async isEnabled(key: PlatformFeatureFlagKey): Promise<boolean> {
    return this.overrides.get(key) ?? false;
  }
}
