import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CoverageArea,
  CreateCoverageAreaResult,
  UpdateCoverageAreaResult,
  SetCoverageAreaActiveStatusResult,
} from "./types";

export interface CoverageAreaRepository {
  listAreas(companyId: string): Promise<CoverageArea[]>;

  createArea(input: {
    companyId: string;
    actorId: string;
    name: string;
    description: string | null;
  }): Promise<CreateCoverageAreaResult>;

  updateArea(input: {
    companyId: string;
    actorId: string;
    areaId: string;
    name: string;
    description: string | null;
  }): Promise<UpdateCoverageAreaResult>;

  setActiveStatus(input: {
    companyId: string;
    actorId: string;
    areaId: string;
    isActive: boolean;
  }): Promise<SetCoverageAreaActiveStatusResult>;
}

type AreaRow = {
  result_outcome: string;
  area_id: string | null;
  area_name: string | null;
  area_description: string | null;
  area_is_active: boolean | null;
};

function toArea(companyId: string, row: AreaRow): CoverageArea {
  return {
    id: row.area_id as string,
    companyId,
    name: row.area_name as string,
    description: row.area_description,
    isActive: row.area_is_active as boolean,
    createdAt: "",
    updatedAt: "",
  };
}

export class SupabaseCoverageAreaRepository implements CoverageAreaRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async listAreas(companyId: string): Promise<CoverageArea[]> {
    const { data, error } = await this.supabase
      .from("coverage_areas")
      .select("id, company_id, name, description, is_active, created_at, updated_at")
      .eq("company_id", companyId)
      .order("name");

    if (error || !data) return [];

    return (
      data as {
        id: string;
        company_id: string;
        name: string;
        description: string | null;
        is_active: boolean;
        created_at: string;
        updated_at: string;
      }[]
    ).map((r) => ({
      id: r.id,
      companyId: r.company_id,
      name: r.name,
      description: r.description,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async createArea(input: {
    companyId: string;
    actorId: string;
    name: string;
    description: string | null;
  }): Promise<CreateCoverageAreaResult> {
    const { data, error } = await this.supabase.rpc("create_coverage_area", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_name: input.name,
      p_description: input.description,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = ((data ?? []) as AreaRow[])[0];
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    switch (row.result_outcome) {
      case "created":
        return { outcome: "created", area: toArea(input.companyId, row) };
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

  async updateArea(input: {
    companyId: string;
    actorId: string;
    areaId: string;
    name: string;
    description: string | null;
  }): Promise<UpdateCoverageAreaResult> {
    const { data, error } = await this.supabase.rpc("update_coverage_area", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_area_id: input.areaId,
      p_name: input.name,
      p_description: input.description,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = ((data ?? []) as AreaRow[])[0];
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    switch (row.result_outcome) {
      case "updated":
        return { outcome: "updated", area: toArea(input.companyId, row) };
      case "forbidden":
        return { outcome: "forbidden" };
      case "not_found":
        return { outcome: "not_found" };
      case "invalid_name":
        return { outcome: "invalid_name", error: "Nama wilayah tidak valid." };
      case "duplicate_area":
        return { outcome: "duplicate_area" };
      default:
        return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
    }
  }

  async setActiveStatus(input: {
    companyId: string;
    actorId: string;
    areaId: string;
    isActive: boolean;
  }): Promise<SetCoverageAreaActiveStatusResult> {
    const { data, error } = await this.supabase.rpc("set_coverage_area_active_status", {
      p_company_id: input.companyId,
      p_actor_id: input.actorId,
      p_area_id: input.areaId,
      p_is_active: input.isActive,
    });

    if (error) return { outcome: "unexpected_error", error: error.message };

    const row = ((data ?? []) as { result_outcome: string }[])[0];
    if (!row) return { outcome: "unexpected_error", error: "empty RPC result" };

    switch (row.result_outcome) {
      case "activated":
        return { outcome: "activated" };
      case "deactivated":
        return { outcome: "deactivated" };
      case "unchanged":
        return { outcome: "unchanged" };
      case "forbidden":
        return { outcome: "forbidden" };
      case "not_found":
        return { outcome: "not_found" };
      default:
        return { outcome: "unexpected_error", error: `unknown outcome: ${row.result_outcome}` };
    }
  }
}

// -----------------------------------------------------------------------
// InMemory — untuk test. Mensimulasikan owner-only gate, uniqueness
// case-insensitive, dan aturan "wilayah nonaktif tidak bisa dihapus/di-
// hardcode-hapus" dari RPC create/update/set_active_status tanpa Postgres.
// -----------------------------------------------------------------------

interface InMemoryAreaRow {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

export class InMemoryCoverageAreaRepository implements CoverageAreaRepository {
  private areas = new Map<string, InMemoryAreaRow>();
  private ownerActors = new Set<string>();
  private nextId = 1;

  seedOwner(companyId: string, actorId: string): void {
    this.ownerActors.add(`${companyId}:${actorId}`);
  }

  /** Simulasi wilayah yang sudah ada (mis. hasil backfill). */
  seedArea(companyId: string, name: string, opts: { isActive?: boolean; description?: string | null } = {}): string {
    const id = `area-${this.nextId++}`;
    this.areas.set(id, {
      id,
      companyId,
      name,
      description: opts.description ?? null,
      isActive: opts.isActive ?? true,
    });
    return id;
  }

  getAreas(companyId: string): string[] {
    return [...this.areas.values()]
      .filter((a) => a.companyId === companyId)
      .map((a) => a.name);
  }

  getArea(areaId: string): InMemoryAreaRow | undefined {
    return this.areas.get(areaId);
  }

  async listAreas(companyId: string): Promise<CoverageArea[]> {
    return [...this.areas.values()]
      .filter((a) => a.companyId === companyId)
      .map((a) => ({
        id: a.id,
        companyId: a.companyId,
        name: a.name,
        description: a.description,
        isActive: a.isActive,
        createdAt: "",
        updatedAt: "",
      }));
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

    const isDuplicate = [...this.areas.values()].some(
      (a) => a.companyId === input.companyId && a.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (isDuplicate) return { outcome: "duplicate_area" };

    const id = `area-${this.nextId++}`;
    const row: InMemoryAreaRow = {
      id,
      companyId: input.companyId,
      name: trimmed,
      description: input.description?.trim() || null,
      isActive: true,
    };
    this.areas.set(id, row);

    return {
      outcome: "created",
      area: {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description,
        isActive: row.isActive,
        createdAt: "",
        updatedAt: "",
      },
    };
  }

  async updateArea(input: {
    companyId: string;
    actorId: string;
    areaId: string;
    name: string;
    description: string | null;
  }): Promise<UpdateCoverageAreaResult> {
    if (!this.ownerActors.has(`${input.companyId}:${input.actorId}`)) {
      return { outcome: "forbidden" };
    }

    const trimmed = input.name.trim();
    if (trimmed.length === 0 || trimmed.length > 100) {
      return { outcome: "invalid_name", error: "Nama wilayah tidak valid." };
    }

    const row = this.areas.get(input.areaId);
    if (!row || row.companyId !== input.companyId) {
      return { outcome: "not_found" };
    }

    const isDuplicate = [...this.areas.values()].some(
      (a) =>
        a.companyId === input.companyId &&
        a.id !== input.areaId &&
        a.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (isDuplicate) return { outcome: "duplicate_area" };

    row.name = trimmed;
    row.description = input.description?.trim() || null;

    return {
      outcome: "updated",
      area: {
        id: row.id,
        companyId: row.companyId,
        name: row.name,
        description: row.description,
        isActive: row.isActive,
        createdAt: "",
        updatedAt: "",
      },
    };
  }

  async setActiveStatus(input: {
    companyId: string;
    actorId: string;
    areaId: string;
    isActive: boolean;
  }): Promise<SetCoverageAreaActiveStatusResult> {
    if (!this.ownerActors.has(`${input.companyId}:${input.actorId}`)) {
      return { outcome: "forbidden" };
    }

    const row = this.areas.get(input.areaId);
    if (!row || row.companyId !== input.companyId) {
      return { outcome: "not_found" };
    }

    if (row.isActive === input.isActive) return { outcome: "unchanged" };

    row.isActive = input.isActive;
    return { outcome: input.isActive ? "activated" : "deactivated" };
  }
}
