// =============================================================================
// Kontrak lookup read-only ke data existing -- dipakai validators.ts untuk
// deteksi duplicate/referential match. Diimplementasikan oleh
// SupabaseImportLookup (repository.ts, produksi) dan InMemoryImportLookup
// (test) supaya logic validasi bisa diuji tanpa Postgres nyata.
// =============================================================================

export interface LookupCustomer {
  id: string;
  name: string;
  legacyId: string | null;
}

// companyId WAJIB di setiap method -- lookup ini dipanggil lewat admin client
// (service_role, RLS di-bypass), jadi tenant-scoping harus ditegakkan eksplisit
// di sini, bukan diserahkan ke RLS.
export interface ImportLookup {
  findCustomerByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<LookupCustomer | null>;
  /** Exact case-insensitive name match -- TIDAK PERNAH fuzzy (beda toko tidak boleh tergabung karena nama mirip). */
  findCustomerByExactName(companyId: string, name: string): Promise<LookupCustomer[]>;
  findSalesmanByName(companyId: string, name: string): Promise<{ id: string } | null>;
  findPicByPhoneOnStore(companyId: string, customerId: string, normalizedPhone: string): Promise<{ id: string } | null>;
  findProductByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null>;
  findProductBySku(companyId: string, sku: string): Promise<{ id: string } | null>;
  findArInvoiceByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null>;
  findOrderByLegacyId(companyId: string, sourceSystem: string, legacyId: string): Promise<{ id: string } | null>;
}

/** In-batch dedup: legacy_id yang sama muncul >1 kali dalam file yang sama. */
export function findInBatchDuplicateLegacyId(
  legacyIds: readonly (string | null)[],
  index: number
): boolean {
  const target = legacyIds[index];
  if (!target) return false;
  return legacyIds.some((id, i) => i !== index && id === target);
}

export async function sha256HexOf(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
