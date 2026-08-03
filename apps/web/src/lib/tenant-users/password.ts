import { randomBytes } from "node:crypto";

/**
 * Temporary password cryptographically secure -- SELALU dibuat server-side
 * (Gate 3E-C-C2-B1 brief §5/§6), TIDAK PERNAH input owner/client (berbeda
 * dari salesman/actions.ts lama yang menerima tempPassword dari form owner).
 * 18 random bytes -> 24 karakter base64url (~144 bit entropy) -- jauh di
 * atas ambang minimal 8 karakter yang divalidasi di service.ts, dan dari
 * alfabet 64 simbol sehingga campuran huruf besar/kecil/angka/tanda praktis
 * pasti muncul tanpa perlu retry/loop konstruksi manual.
 */
export function generateSecureTempPassword(): string {
  return randomBytes(18).toString("base64url");
}
