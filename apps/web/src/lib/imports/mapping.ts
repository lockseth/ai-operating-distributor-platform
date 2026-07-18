// =============================================================================
// AODP adapter — wrapper ergonomis di atas Universal Core mapping (LANGKAH 6).
// Algoritma alias-matching sesungguhnya ada di
// lib/data-onboarding/core/mapping.ts (generik, tanpa tahu ImportType AODP);
// file ini hanya menjembatani ImportType -> DOMAIN_FIELDS untuk pemanggil
// yang sudah terbiasa dengan API lama (importType, bukan fields[]).
// =============================================================================

import { suggestColumnMapping as coreSuggestColumnMapping, validateMappingCompleteness as coreValidateMappingCompleteness } from "@/lib/data-onboarding/core/mapping";
import { DOMAIN_FIELDS, type ColumnMapping, type ImportType } from "./types";

export function suggestColumnMapping(sourceHeaders: readonly string[], importType: ImportType): ColumnMapping[] {
  return coreSuggestColumnMapping(sourceHeaders, DOMAIN_FIELDS[importType]);
}

export interface MappingValidationResult {
  ok: boolean;
  missingRequiredFields: string[];
}

export function validateMappingCompleteness(mappings: readonly ColumnMapping[], importType: ImportType): MappingValidationResult {
  return coreValidateMappingCompleteness(mappings, DOMAIN_FIELDS[importType]);
}
