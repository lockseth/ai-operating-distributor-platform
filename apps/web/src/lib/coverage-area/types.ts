// =============================================================================
// Wilayah Penjualan (Coverage Area) — kontrak tipe.
//
// Satu-satunya master resmi (public.coverage_areas, migration 20260816000001).
// Toko (customers.coverage_area_id) dan Salesman (salesman_coverage_areas.
// coverage_area_id) WAJIB mereferensikan baris di sini lewat id -- tidak lagi
// companies.settings.coverage_areas (JSONB) atau customers.area (free text).
// =============================================================================

export interface CoverageArea {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCoverageAreaInput {
  companyId: string;
  actorId: string;
  name: string;
  description: string | null;
}

export type CreateCoverageAreaResult =
  | { outcome: "created"; area: CoverageArea }
  | { outcome: "invalid_name"; error: string }
  | { outcome: "duplicate_area" }
  | { outcome: "forbidden" }
  | { outcome: "unexpected_error"; error: string };

export interface UpdateCoverageAreaInput {
  companyId: string;
  actorId: string;
  areaId: string;
  name: string;
  description: string | null;
}

export type UpdateCoverageAreaResult =
  | { outcome: "updated"; area: CoverageArea }
  | { outcome: "invalid_name"; error: string }
  | { outcome: "duplicate_area" }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "unexpected_error"; error: string };

export type SetCoverageAreaActiveStatusResult =
  | { outcome: "activated" }
  | { outcome: "deactivated" }
  | { outcome: "unchanged" }
  | { outcome: "not_found" }
  | { outcome: "forbidden" }
  | { outcome: "unexpected_error"; error: string };
