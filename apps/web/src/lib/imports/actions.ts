"use server";

// =============================================================================
// Server actions -- Legacy Data Import. HANYA admin/owner/manager/super_admin
// (permission imports.*, tidak pernah diberikan ke role sales -- LANGKAH 15 +
// BATASAN "Salesman tidak boleh menjalankan bulk import").
// =============================================================================

import { revalidatePath } from "next/cache";
import { getAdminClient } from "@/lib/supabase/admin";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { logAuditEvent } from "@/lib/actions/audit";
import { SupabaseImportRepository } from "./repository";
import { stageUploadedFile, validateStagedBatch } from "./service";
import { SupabaseMappingProfileStore } from "./mapping-profiles";
import type { ColumnMapping, ImportType } from "./types";
import { IMPORT_TYPES } from "./types";
import type { MappingProfile } from "@/lib/data-onboarding/core/types";
import { getTemplateVersionInfo } from "./templates";

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

export type UploadImportFileData =
  | { needsSheetSelection: true; sheetNames: string[]; sheetPreviews: Record<string, { headers: string[]; previewRows: string[][] }> }
  | { needsSheetSelection: false; batchId: string; headers: string[]; suggestedMapping: ColumnMapping[]; previewRows: string[][]; totalRows: number; selectedSheet: string };

export async function uploadImportFileAction(formData: FormData): Promise<ActionResult<UploadImportFileData>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.execute")) {
    return { ok: false, error: "Tidak berwenang melakukan import." };
  }

  const file = formData.get("file");
  const importType = formData.get("importType") as string | null;
  const sourceSystem = formData.get("sourceSystem") as string | null;
  const sheetName = formData.get("sheetName") as string | null;

  if (!(file instanceof File)) return { ok: false, error: "File tidak ditemukan." };
  if (!importType || !IMPORT_TYPES.includes(importType as ImportType)) return { ok: false, error: "Jenis import tidak valid." };
  if (!sourceSystem || !sourceSystem.trim()) return { ok: false, error: "Sistem sumber wajib diisi." };

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const supabase = getAdminClient();
  const repository = new SupabaseImportRepository(supabase);

  const result = await stageUploadedFile({ repository }, {
    companyId: user.company_id, actorId: user.id, importType: importType as ImportType,
    sourceSystem: sourceSystem.trim(), filename: file.name, fileBytes,
    sheetName: sheetName ?? undefined,
  });

  if (!result.ok) return { ok: false, error: result.error };

  if (result.needsSheetSelection) {
    return { ok: true, data: result };
  }

  await logAuditEvent({
    company_id: user.company_id, user_id: user.id, action: "import.uploaded",
    entity_type: "import_batches", entity_id: result.batchId,
    new_data: { importType, totalRows: result.totalRows, filename: file.name, sheet: result.selectedSheet },
    module: "imports",
  });

  revalidatePath("/dashboard/imports");
  return { ok: true, data: result };
}

export async function validateImportBatchAction(input: { batchId: string; columnMappings: ColumnMapping[] }): Promise<ActionResult<{ readyToCommit: boolean }>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.execute")) {
    return { ok: false, error: "Tidak berwenang melakukan import." };
  }

  const supabase = getAdminClient();
  const repository = new SupabaseImportRepository(supabase);

  const result = await validateStagedBatch({ repository }, {
    companyId: user.company_id, batchId: input.batchId, columnMappings: input.columnMappings,
  });
  if (!result.ok) return { ok: false, error: result.error };

  await logAuditEvent({
    company_id: user.company_id, user_id: user.id, action: "import.validated",
    entity_type: "import_batches", entity_id: input.batchId,
    new_data: { totalRows: result.summary.totalRows, validRows: result.summary.validRows, errorRows: result.summary.errorRows, readyToCommit: result.summary.readyToCommit },
    module: "imports",
  });

  revalidatePath(`/dashboard/imports/${input.batchId}`);
  return { ok: true, data: { readyToCommit: result.summary.readyToCommit } };
}

export async function commitImportBatchAction(input: { batchId: string; acknowledgeDuplicateFile?: boolean }): Promise<ActionResult<{ createdCount: number; updatedCount: number }>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.commit")) {
    return { ok: false, error: "Tidak berwenang melakukan commit import." };
  }

  const supabase = getAdminClient();
  const repository = new SupabaseImportRepository(supabase);

  const batch = await repository.getBatch(user.company_id, input.batchId);
  if (!batch) return { ok: false, error: "Batch tidak ditemukan." };

  if (!input.acknowledgeDuplicateFile) {
    const existingCommitted = await repository.findCommittedBatchByHash(user.company_id, batch.importType, batch.fileHash);
    if (existingCommitted && existingCommitted.id !== batch.id) {
      return { ok: false, error: `File yang sama persis sudah pernah di-commit sebelumnya (batch ${existingCommitted.id}, ${existingCommitted.committedAt}). Konfirmasi ulang jika ini memang disengaja (mis. koreksi).` };
    }
  }

  const result = await repository.commitBatch(user.company_id, input.batchId, user.id);

  if (result.outcome === "committed" || result.outcome === "already_committed") {
    const updated = await repository.getBatch(user.company_id, input.batchId);
    revalidatePath("/dashboard/imports");
    revalidatePath(`/dashboard/imports/${input.batchId}`);
    return { ok: true, data: { createdCount: (updated?.commitResult as { createdCount?: number })?.createdCount ?? 0, updatedCount: (updated?.commitResult as { updatedCount?: number })?.updatedCount ?? 0 } };
  }
  if (result.outcome === "forbidden") return { ok: false, error: "Tidak berwenang." };
  if (result.outcome === "not_found") return { ok: false, error: "Batch tidak ditemukan." };
  if (result.outcome === "invalid_status") return { ok: false, error: "Batch belum siap di-commit (harus READY_TO_COMMIT)." };
  return { ok: false, error: `Commit gagal: ${result.detail ?? "unknown error"}` };
}

export async function rollbackImportBatchAction(input: { batchId: string; reason: string }): Promise<ActionResult<{ blockers?: { rowNumber: number; entityTable: string; entityId: string; reason: string }[] }>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.rollback")) {
    return { ok: false, error: "Tidak berwenang melakukan rollback import." };
  }
  if (!input.reason.trim()) return { ok: false, error: "Alasan rollback wajib diisi." };

  const supabase = getAdminClient();
  const repository = new SupabaseImportRepository(supabase);
  const result = await repository.rollbackBatch(user.company_id, input.batchId, user.id, input.reason.trim());

  if (result.outcome === "rolled_back" || result.outcome === "already_rolled_back") {
    revalidatePath("/dashboard/imports");
    revalidatePath(`/dashboard/imports/${input.batchId}`);
    return { ok: true };
  }
  if (result.outcome === "blocked") return { ok: false, error: "Rollback ditolak -- ada data yang sudah dirujuk transaksi live.", data: { blockers: result.blockers } };
  if (result.outcome === "forbidden") return { ok: false, error: "Tidak berwenang." };
  if (result.outcome === "not_found") return { ok: false, error: "Batch tidak ditemukan." };
  if (result.outcome === "invalid_status") return { ok: false, error: "Hanya batch COMMITTED yang bisa di-rollback." };
  return { ok: false, error: "Data tidak valid." };
}

export async function listImportBatchesAction(): Promise<ActionResult<Awaited<ReturnType<SupabaseImportRepository["listBatches"]>>>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.view")) return { ok: false, error: "Tidak berwenang." };
  const repository = new SupabaseImportRepository(getAdminClient());
  const data = await repository.listBatches(user.company_id);
  return { ok: true, data };
}

export async function saveMappingProfileAction(input: {
  importType: ImportType; sourceSystem: string; profileName: string; columnMappings: ColumnMapping[];
}): Promise<ActionResult<MappingProfile>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.execute")) {
    return { ok: false, error: "Tidak berwenang menyimpan profil mapping." };
  }
  if (!input.sourceSystem.trim()) return { ok: false, error: "Sistem sumber wajib diisi." };
  if (!input.profileName.trim()) return { ok: false, error: "Nama profil wajib diisi." };

  const store = new SupabaseMappingProfileStore(getAdminClient());
  const profile = await store.saveProfile({
    companyId: user.company_id, domain: input.importType, sourceSystem: input.sourceSystem.trim(),
    profileName: input.profileName.trim(), columnMappings: input.columnMappings,
    templateVersion: getTemplateVersionInfo(input.importType).version, createdBy: user.id,
  });
  return { ok: true, data: profile };
}

export async function listMappingProfilesAction(importType: ImportType): Promise<ActionResult<MappingProfile[]>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.view")) return { ok: false, error: "Tidak berwenang." };
  const store = new SupabaseMappingProfileStore(getAdminClient());
  const data = await store.listProfiles(user.company_id, importType);
  return { ok: true, data };
}

export async function getImportBatchDetailAction(batchId: string): Promise<ActionResult<{ batch: NonNullable<Awaited<ReturnType<SupabaseImportRepository["getBatch"]>>>; rows: Awaited<ReturnType<SupabaseImportRepository["getBatchRows"]>> }>> {
  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.view")) return { ok: false, error: "Tidak berwenang." };
  const repository = new SupabaseImportRepository(getAdminClient());
  const batch = await repository.getBatch(user.company_id, batchId);
  if (!batch) return { ok: false, error: "Batch tidak ditemukan." };
  const rows = await repository.getBatchRows(user.company_id, batchId);
  return { ok: true, data: { batch, rows } };
}
