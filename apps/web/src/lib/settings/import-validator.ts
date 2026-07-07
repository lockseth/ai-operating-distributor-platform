import type { ColumnMapping } from "./import-actions";
import { applyTransform } from "./csv-parser";

export interface MappedRow {
  rowIndex:   number;
  rawValues:  Record<string, string>;  // source_column -> raw value from CSV
  mapped:     MappedField[];
  errors:     string[];
  isValid:    boolean;
}

export interface MappedField {
  sourceColumn:      string;
  targetField:       string;
  targetType:        "core" | "custom";
  rawValue:          string;
  transformedValue:  string;
  isRequired:        boolean;
  defaultValue:      string | null;
  transform:         string;
  hasError:          boolean;
  errorMessage:      string | null;
}

export interface PreviewResult {
  totalRows:  number;
  validRows:  number;
  errorRows:  number;
  mappedRows: MappedRow[];
  unmappedSourceColumns: string[];
}

const MAX_PREVIEW_ROWS = 200;

export function buildPreview(
  headers: string[],
  rows: string[][],
  mappings: ColumnMapping[]
): PreviewResult {
  const headerIndex = new Map(headers.map((h, i) => [h.trim(), i]));

  // Find source columns not covered by any mapping
  const mappedSources = new Set(mappings.map((m) => m.source_column));
  const unmappedSourceColumns = headers.filter((h) => !mappedSources.has(h.trim()));

  const previewRows = rows.slice(0, MAX_PREVIEW_ROWS);

  const mappedRows: MappedRow[] = previewRows.map((row, idx) => {
    const rawValues: Record<string, string> = {};
    headers.forEach((h, i) => {
      rawValues[h.trim()] = row[i] ?? "";
    });

    const errors: string[] = [];
    const mapped: MappedField[] = mappings.map((m) => {
      const colIdx = headerIndex.get(m.source_column);
      const rawValue =
        colIdx !== undefined ? (row[colIdx] ?? "").trim() : "";
      const effectiveRaw = rawValue || (m.default_value ?? "");
      const transformedValue = effectiveRaw
        ? applyTransform(effectiveRaw, m.transform)
        : "";

      let hasError    = false;
      let errorMessage: string | null = null;

      // Required check
      if (m.is_required && !transformedValue) {
        hasError     = true;
        errorMessage = `Field wajib "${m.target_field}" kosong`;
        errors.push(errorMessage);
      }

      // Type-specific validation
      if (!hasError && transformedValue) {
        const fieldErr = validateFieldValue(m.target_field, transformedValue, m.transform);
        if (fieldErr) {
          hasError     = true;
          errorMessage = fieldErr;
          errors.push(fieldErr);
        }
      }

      // Warn if source column not found in file
      if (colIdx === undefined && !m.default_value) {
        hasError     = true;
        errorMessage = `Kolom "${m.source_column}" tidak ditemukan di file`;
        errors.push(errorMessage);
      }

      return {
        sourceColumn:     m.source_column,
        targetField:      m.target_field,
        targetType:       m.target_type,
        rawValue,
        transformedValue,
        isRequired:       m.is_required,
        defaultValue:     m.default_value,
        transform:        m.transform,
        hasError,
        errorMessage,
      };
    });

    return {
      rowIndex: idx + 1,
      rawValues,
      mapped,
      errors,
      isValid: errors.length === 0,
    };
  });

  const validRows = mappedRows.filter((r) => r.isValid).length;

  return {
    totalRows:  rows.length,
    validRows,
    errorRows:  rows.length - validRows,
    mappedRows,
    unmappedSourceColumns,
  };
}

function validateFieldValue(
  targetField: string,
  value: string,
  transform: string
): string | null {
  // Numeric fields
  const numericFields = [
    "price", "cost", "stock_quantity", "min_stock", "quantity",
    "unit_price", "discount_amount", "avg_order_interval_days",
  ];
  if (numericFields.includes(targetField) || transform === "number") {
    if (isNaN(Number(value))) {
      return `Field "${targetField}" harus berupa angka, ditemukan: "${value}"`;
    }
  }

  // Email
  if (targetField === "email" && value) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return `Format email tidak valid: "${value}"`;
    }
  }

  // Date ISO
  if (transform === "date_iso" || targetField === "delivery_date") {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `Format tanggal tidak valid (harus YYYY-MM-DD): "${value}"`;
    }
  }

  return null;
}
