// =============================================================================
// Coverage Area (Wilayah Kerja) — kontrak tipe.
//
// Reuse penuh companies.settings.coverage_areas (JSONB array of string,
// migration 20260724000001) sebagai sumber kebenaran. Modul ini hanya
// menambah kemampuan "buat wilayah baru" (append, bukan replace/hapus —
// lihat migration 20260813000001).
// =============================================================================

export interface CreateCoverageAreaInput {
  companyId: string;
  actorId: string;
  name: string;
  description: string | null;
}

export type CreateCoverageAreaResult =
  | { outcome: "created"; areas: string[] }
  | { outcome: "invalid_name"; error: string }
  | { outcome: "duplicate_area" }
  | { outcome: "forbidden" }
  | { outcome: "unexpected_error"; error: string };
