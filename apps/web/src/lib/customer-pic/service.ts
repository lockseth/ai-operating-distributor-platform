// =============================================================================
// Rule-based deterministic duplicate detection + validasi murni — SENGAJA
// dicerminkan persis dari RPC create_store_with_pic()/create_customer_pic()
// (migration 20260728000001_customer_pic_master.sql) supaya InMemory
// repository dan RPC produksi selalu setuju pada hasil yang sama. Tidak ada
// AI vendor/ML di sini (keputusan Pak Waluyo — rule-based deterministic).
// =============================================================================

import { PIC_ROLES, type PicRole } from "./types";
import { normalizeIdPhone } from "./phone";

export function isValidPicRoles(roles: readonly string[] | null | undefined): roles is PicRole[] {
  if (!roles || roles.length === 0) return false;
  return roles.every((r) => (PIC_ROLES as readonly string[]).includes(r));
}

export interface DuplicateCandidateStore {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  area: string | null;
  isActive: boolean;
}

/**
 * Exact duplicate: nama SAMA PERSIS (case-insensitive, trimmed) DIKOMBINASI
 * dengan minimal satu sinyal kuat lain (alamat sama ATAU nomor toko sama).
 * Nomor telepon SENDIRIAN (tanpa nama sama) BUKAN exact -- satu pemilik sah
 * memakai satu nomor untuk beberapa toko/cabang (lihat findSimilarStoreDuplicate).
 * Mencerminkan bagian "v_exact_id" di create_store_with_pic().
 */
export function findExactStoreDuplicate(
  candidateName: string,
  candidatePhone: string | null,
  candidateAddress: string | null,
  existingStores: readonly DuplicateCandidateStore[]
): DuplicateCandidateStore | null {
  const normalizedCandidatePhone = normalizeIdPhone(candidatePhone);
  const nameKey = candidateName.trim().toLowerCase();
  const addressKey = (candidateAddress ?? "").trim().toLowerCase();

  for (const store of existingStores) {
    if (!store.isActive) continue;
    const nameMatch = store.name.trim().toLowerCase() === nameKey;
    if (!nameMatch) continue;
    const addressMatch = (store.address ?? "").trim().toLowerCase() === addressKey;
    const phoneMatch = normalizedCandidatePhone !== null && normalizeIdPhone(store.phone) === normalizedCandidatePhone;
    if (addressMatch || phoneMatch) return store;
  }
  return null;
}

/**
 * Similar duplicate (warning, bukan block): nomor toko sama TAPI nama
 * berbeda (satu pemilik/beberapa cabang -- sah, tapi tetap perlu review),
 * ATAU nama mirip (salah satu substring dari yang lain, area sama), ATAU
 * alamat sama persis dengan nama berbeda. Mencerminkan bagian "v_similar_id"
 * di create_store_with_pic(). Hanya dipanggil kalau TIDAK ada exact duplicate.
 */
export function findSimilarStoreDuplicate(
  candidateName: string,
  candidatePhone: string | null,
  candidateAddress: string | null,
  candidateArea: string | null,
  existingStores: readonly DuplicateCandidateStore[],
  excludeId?: string
): DuplicateCandidateStore | null {
  const normalizedCandidatePhone = normalizeIdPhone(candidatePhone);
  const nameKey = candidateName.trim().toLowerCase();
  const addressKey = (candidateAddress ?? "").trim().toLowerCase();
  const nameTrimmed = candidateName.trim();

  for (const store of existingStores) {
    if (!store.isActive) continue;
    if (excludeId && store.id === excludeId) continue;

    const phoneMatchDifferentName =
      normalizedCandidatePhone !== null &&
      normalizeIdPhone(store.phone) === normalizedCandidatePhone &&
      store.name.trim().toLowerCase() !== nameKey;

    const storeNameLower = store.name.toLowerCase();
    const nameSimilarInArea =
      store.area === candidateArea &&
      nameTrimmed.length >= 4 &&
      (storeNameLower.includes(nameKey) || nameKey.includes(storeNameLower));

    const sameAddressDifferentName =
      addressKey !== "" && (store.address ?? "").trim().toLowerCase() === addressKey && store.name.trim().toLowerCase() !== nameKey;

    if (phoneMatchDifferentName || nameSimilarInArea || sameAddressDifferentName) return store;
  }
  return null;
}

export interface DuplicateCandidatePic {
  id: string;
  customerId: string;
  phone: string;
}

/**
 * Nomor PIC yang sama muncul di toko lain (tenant sama) — TIDAK PERNAH
 * dianggap fraud otomatis, murni informational (DUPLICATE_PIC_DETECTED).
 */
export function findPicPhoneOnOtherStore(
  normalizedPhone: string,
  currentCustomerId: string,
  existingPics: readonly DuplicateCandidatePic[]
): DuplicateCandidatePic | null {
  return existingPics.find((p) => p.phone === normalizedPhone && p.customerId !== currentCustomerId) ?? null;
}
