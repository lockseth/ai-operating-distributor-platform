import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateCoverageAreaResult } from "./types";

export interface CoverageAreaRepository {
  createArea(input: {
    companyId: string;
    actorId: string;
    name: string;
    description: string | null;
  }): Promise<CreateCoverageAreaResult>;
}

export class SupabaseCoverageAreaRepository implements CoverageAreaRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async createArea(input: {
    companyId: string;
    actorId: string;
    name: string;
    description: string | null;
  }): Promise<CreateCoverageAreaResult> {
    const { data, error } = await this.supabase.rpc("add_company_coverage_area", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_name: input.name,
      p_description: input.description,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = (
      (data ?? []) as { result_outcome: string; updated_areas: string[] | null }[]
    )[0];

    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    switch (row.result_outcome) {
      case "created":
        return { outcome: "created", areas: row.updated_areas ?? [] };
      case "forbidden":
        return { outcome: "forbidden" };
      case "invalid_name":
        return { outcome: "invalid_name", error: "Nama wilayah tidak valid." };
      case "duplicate_area":
        return { outcome: "duplicate_area" };
      default:
        return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
    }
  }
}

// -----------------------------------------------------------------------
// InMemory — untuk test. Mensimulasikan owner-only gate dan uniqueness
// case-insensitive dari RPC add_company_coverage_area tanpa Postgres.
// -----------------------------------------------------------------------

export class InMemoryCoverageAreaRepository implements CoverageAreaRepository {
  private tenantAreas = new Map<string, string[]>();
  private ownerActors = new Set<string>();

  seedOwner(companyId: string, actorId: string): void {
    this.ownerActors.add(`${companyId}:${actorId}`);
  }

  setAreas(companyId: string, areas: string[]): void {
    this.tenantAreas.set(companyId, [...areas]);
  }

  getAreas(companyId: string): string[] {
    return this.tenantAreas.get(companyId) ?? [];
  }

  async createArea(input: {
    companyId: string;
    actorId: string;
    name: string;
    description: string | null;
  }): Promise<CreateCoverageAreaResult> {
    if (!this.ownerActors.has(`${input.companyId}:${input.actorId}`)) {
      return { outcome: "forbidden" };
    }

    const trimmed = input.name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      return { outcome: "invalid_name", error: "Nama wilayah tidak valid." };
    }

    const current = this.tenantAreas.get(input.companyId) ?? [];
    const isDuplicate = current.some((a) => a.trim().toLowerCase() === trimmed.toLowerCase());
    if (isDuplicate) return { outcome: "duplicate_area" };

    const updated = [...current, trimmed];
    this.tenantAreas.set(input.companyId, updated);
    return { outcome: "created", areas: updated };
  }
}
