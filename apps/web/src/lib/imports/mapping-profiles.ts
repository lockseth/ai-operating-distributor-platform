// =============================================================================
// AODP adapter -- Saved Import Mapping Profiles (addendum "SAVED IMPORT
// PROFILE"). Implementasi konkret dari MappingProfileStore (Universal Core)
// untuk domain AODP: tabel Supabase `import_mapping_profiles`, di-scope
// `import_type: ImportType`. Core sendiri tidak tahu apa pun soal tabel ini.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MappingProfile, MappingProfileInput, MappingProfileStore } from "@/lib/data-onboarding/core/types";

interface ProfileRow {
  id: string;
  company_id: string;
  import_type: string;
  source_system: string;
  profile_name: string;
  column_mappings: unknown;
  template_version: string;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToProfile(r: ProfileRow): MappingProfile {
  return {
    id: r.id, companyId: r.company_id, domain: r.import_type, sourceSystem: r.source_system,
    profileName: r.profile_name, columnMappings: r.column_mappings as MappingProfile["columnMappings"],
    templateVersion: r.template_version, version: r.version,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class SupabaseMappingProfileStore implements MappingProfileStore {
  constructor(private readonly client: SupabaseClient) {}

  async saveProfile(input: MappingProfileInput): Promise<MappingProfile> {
    const { data: existing } = await this.client
      .from("import_mapping_profiles")
      .select("id, version")
      .eq("company_id", input.companyId)
      .eq("import_type", input.domain)
      .eq("source_system", input.sourceSystem)
      .eq("profile_name", input.profileName)
      .maybeSingle();

    if (existing) {
      const { data, error } = await this.client
        .from("import_mapping_profiles")
        .update({
          column_mappings: input.columnMappings, template_version: input.templateVersion,
          version: (existing as { version: number }).version + 1,
        })
        .eq("id", (existing as { id: string }).id)
        .select()
        .single();
      if (error) throw error;
      return rowToProfile(data as ProfileRow);
    }

    const { data, error } = await this.client
      .from("import_mapping_profiles")
      .insert({
        company_id: input.companyId, import_type: input.domain, source_system: input.sourceSystem,
        profile_name: input.profileName, column_mappings: input.columnMappings,
        template_version: input.templateVersion, created_by: input.createdBy,
      })
      .select()
      .single();
    if (error) throw error;
    return rowToProfile(data as ProfileRow);
  }

  async listProfiles(companyId: string, domain: string): Promise<MappingProfile[]> {
    const { data, error } = await this.client
      .from("import_mapping_profiles")
      .select("*")
      .eq("company_id", companyId)
      .eq("import_type", domain)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data as ProfileRow[]).map(rowToProfile);
  }

  async getProfile(companyId: string, id: string): Promise<MappingProfile | null> {
    const { data } = await this.client
      .from("import_mapping_profiles")
      .select("*")
      .eq("company_id", companyId)
      .eq("id", id)
      .maybeSingle();
    return data ? rowToProfile(data as ProfileRow) : null;
  }
}

/** In-memory mirror untuk test -- logika versioning identik dengan store Supabase di atas. */
export class InMemoryMappingProfileStore implements MappingProfileStore {
  private profiles = new Map<string, MappingProfile>();
  private seq = 0;

  private key(companyId: string, domain: string, sourceSystem: string, profileName: string): string {
    return `${companyId}::${domain}::${sourceSystem}::${profileName}`;
  }

  async saveProfile(input: MappingProfileInput): Promise<MappingProfile> {
    const k = this.key(input.companyId, input.domain, input.sourceSystem, input.profileName);
    const existing = this.profiles.get(k);
    const now = new Date().toISOString();
    const profile: MappingProfile = {
      id: existing?.id ?? `profile-${++this.seq}`,
      companyId: input.companyId, domain: input.domain, sourceSystem: input.sourceSystem,
      profileName: input.profileName, columnMappings: input.columnMappings,
      templateVersion: input.templateVersion, version: (existing?.version ?? 0) + 1,
      createdBy: existing?.createdBy ?? input.createdBy, createdAt: existing?.createdAt ?? now, updatedAt: now,
    };
    this.profiles.set(k, profile);
    return profile;
  }

  async listProfiles(companyId: string, domain: string): Promise<MappingProfile[]> {
    return [...this.profiles.values()]
      .filter((p) => p.companyId === companyId && p.domain === domain)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProfile(companyId: string, id: string): Promise<MappingProfile | null> {
    const found = [...this.profiles.values()].find((p) => p.companyId === companyId && p.id === id);
    return found ?? null;
  }
}
