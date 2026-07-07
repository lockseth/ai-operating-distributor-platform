/**
 * Client-side CSV/TSV parser.
 * Handles quoted fields, escaped quotes, and configurable delimiters.
 */
export function parseCSVText(
  text: string,
  delimiter: string,
  hasHeader: boolean
): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records = splitCSVLines(lines, delimiter);

  if (records.length === 0) return { headers: [], rows: [] };

  if (hasHeader) {
    const [headerRow, ...dataRows] = records;
    return { headers: headerRow, rows: dataRows };
  }

  // No header: generate column names Col1, Col2, ...
  const width   = records[0]?.length ?? 0;
  const headers = Array.from({ length: width }, (_, i) => `Kolom${i + 1}`);
  return { headers, rows: records };
}

function splitCSVLines(text: string, delimiter: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let field        = "";
  let inQuotes     = false;
  let i            = 0;

  while (i < text.length) {
    const ch   = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // Escaped quote
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (ch === delimiter || (delimiter === "\t" && ch === "\t")) {
      row.push(field.trim());
      field = "";
      i++;
      continue;
    }

    if (ch === "\n") {
      row.push(field.trim());
      if (row.some((f) => f !== "")) result.push(row);
      row   = [];
      field = "";
      i++;
      continue;
    }

    field += ch;
    i++;
  }

  // Last field / row
  if (field || row.length > 0) {
    row.push(field.trim());
    if (row.some((f) => f !== "")) result.push(row);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Transform functions
// ---------------------------------------------------------------------------

export function applyTransform(raw: string, transform: string): string {
  const v = raw.trim();
  switch (transform) {
    case "uppercase":  return v.toUpperCase();
    case "lowercase":  return v.toLowerCase();
    case "phone_id":   return normalizePhoneId(v);
    case "date_iso":   return normalizeDateISO(v);
    case "number":     return normalizeNumber(v);
    default:           return v;
  }
}

function normalizePhoneId(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("62"))  return `+${digits}`;
  if (digits.startsWith("0"))   return `+62${digits.slice(1)}`;
  if (digits.startsWith("8"))   return `+62${digits}`;
  return raw;
}

function normalizeDateISO(raw: string): string {
  // Support dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd
  const slash = raw.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (slash) {
    const [, d, m, y] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const isoLike = raw.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
  if (isoLike) {
    const [, y, m, d] = isoLike;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

function normalizeNumber(raw: string): string {
  // Remove thousand separators (dots used as thousand sep in id-ID)
  const cleaned = raw.replace(/\./g, "").replace(",", ".");
  const n       = parseFloat(cleaned);
  return isNaN(n) ? raw : String(n);
}
