// =============================================================================
// Universal Data Onboarding Core — deterministic column-mapping suggestion.
// TIDAK ADA LLM/vendor eksternal. Domain-agnostic: menerima FieldDefinition[]
// dari adapter, tidak tahu apa pun soal domain/tenant tertentu.
// =============================================================================

import type { ColumnMapping, FieldDefinition } from "./types";

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[_\-.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function suggestColumnMapping(sourceHeaders: readonly string[], fields: readonly FieldDefinition[]): ColumnMapping[] {
  const lookup = new Map<string, string>();

  for (const field of fields) {
    lookup.set(normalizeHeader(field.key), field.key);
    lookup.set(normalizeHeader(field.label), field.key);
    for (const alias of field.aliases) {
      lookup.set(normalizeHeader(alias), field.key);
    }
  }

  const mappings: ColumnMapping[] = [];
  const usedTargets = new Set<string>();

  for (const sourceColumn of sourceHeaders) {
    const normalized = normalizeHeader(sourceColumn);
    const target = lookup.get(normalized);
    if (target && !usedTargets.has(target)) {
      mappings.push({ sourceColumn, targetField: target });
      usedTargets.add(target);
    }
  }

  return mappings;
}

export interface MappingValidationResult {
  ok: boolean;
  missingRequiredFields: string[];
}

export function validateMappingCompleteness(mappings: readonly ColumnMapping[], fields: readonly FieldDefinition[]): MappingValidationResult {
  const mappedTargets = new Set(mappings.map((m) => m.targetField));
  const requiredFields = fields.filter((f) => f.required);
  const missing = requiredFields.filter((f) => !mappedTargets.has(f.key)).map((f) => f.key);
  return { ok: missing.length === 0, missingRequiredFields: missing };
}
