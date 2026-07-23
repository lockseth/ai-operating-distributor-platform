// =============================================================================
// Admin Tambah Salesman — kontrak tipe.
//
// Field sengaja terbatas pada apa yang sudah didukung schema public.users
// (id, company_id, email, full_name, phone, is_active) ditambah wilayah
// kerja (relasi many-to-many salesman_coverage_areas, migration
// 20260724000001). Tidak ada field target/achievement — belum dikerjakan
// (Configurable KPI Foundation terpisah). Non-biometric: tidak ada field
// KTP/selfie/foto identitas.
// =============================================================================

export interface CreateSalesmanInput {
  companyId: string;
  actorId: string;
  fullName: string;
  email: string;
  phone: string | null;
  tempPassword: string;
  /** Wilayah kerja — wajib coverage_area_id anggota master coverage_areas tenant. Minimal satu. */
  areaIds: string[];
}

export type CreateSalesmanResult =
  | { outcome: "created"; userId: string }
  | { outcome: "invalid_input"; error: string }
  | { outcome: "duplicate_email" }
  | { outcome: "role_not_found" }
  | { outcome: "no_areas_provided" }
  | { outcome: "no_coverage_configured" }
  | { outcome: "invalid_area" }
  | { outcome: "partial_failure_rolled_back"; error: string }
  | { outcome: "unexpected_error"; error: string };

export type AssignCoverageAreasResult =
  | { outcome: "assigned"; assignedCount: number }
  | { outcome: "forbidden" }
  | { outcome: "not_eligible" }
  | { outcome: "no_areas_provided" }
  | { outcome: "no_coverage_configured" }
  | { outcome: "invalid_area" }
  | { outcome: "unexpected_error"; error: string };

/**
 * Gate 1B — hasil set_salesman_active_status. "unchanged" adalah outcome
 * eksplisit untuk repeated request terhadap status yang sama (idempotent,
 * bukan error, tidak menulis audit baru).
 */
export type SetSalesmanActiveStatusResult =
  | { outcome: "activated" }
  | { outcome: "deactivated" }
  | { outcome: "unchanged" }
  | { outcome: "forbidden" }
  | { outcome: "not_eligible" }
  | { outcome: "not_found" }
  | { outcome: "unexpected_error"; error: string };
