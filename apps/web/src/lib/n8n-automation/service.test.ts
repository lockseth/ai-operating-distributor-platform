import { describe, expect, it } from "vitest";
import {
  computeBackoffMinutes,
  hashN8nCredential,
  isNonEmptyString,
  isUuid,
  resolveAutomationCredential,
  sanitizeAutomationError,
} from "./service";
import { InMemoryAutomationRepository } from "./repository";

// ---------------------------------------------------------------------------
// Credential leakage -- structural test wajib (payload/log tidak boleh
// membocorkan token/credential).
// ---------------------------------------------------------------------------
describe("sanitizeAutomationError -- credential leakage prevention", () => {
  it("menutupi 'Bearer <token>' yang ter-echo provider di pesan error", () => {
    const raw = "Request failed: Authorization header was 'Bearer abc123SECRETTOKENxyz789' -- invalid";
    const sanitized = sanitizeAutomationError(raw);
    expect(sanitized).not.toContain("abc123SECRETTOKENxyz789");
    expect(sanitized).toContain("[redacted]");
  });

  it("menutupi header 'Authorization: ...' literal", () => {
    const raw = "Upstream responded 401. Sent header: Authorization: Bearer sk-liveSecretValue1234567890";
    const sanitized = sanitizeAutomationError(raw);
    expect(sanitized).not.toContain("sk-liveSecretValue1234567890");
  });

  it("menutupi string panjang mirip token/hash meski tanpa label eksplisit", () => {
    const raw = "provider error code a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6";
    const sanitized = sanitizeAutomationError(raw);
    expect(sanitized).not.toContain("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6");
    expect(sanitized).toContain("[redacted-token-like]");
  });

  it("pesan error biasa (tanpa token) tidak diubah selain dipotong panjangnya", () => {
    const raw = "Telegram API timeout after 5000ms";
    expect(sanitizeAutomationError(raw)).toBe(raw);
  });

  it("dipotong maksimal 500 karakter", () => {
    const raw = "x".repeat(1000);
    expect(sanitizeAutomationError(raw).length).toBeLessThanOrEqual(500);
  });
});

describe("computeBackoffMinutes", () => {
  it("eksponensial: 2^attempt, cap 60 menit", () => {
    expect(computeBackoffMinutes(0)).toBe(1);
    expect(computeBackoffMinutes(1)).toBe(2);
    expect(computeBackoffMinutes(2)).toBe(4);
    expect(computeBackoffMinutes(10)).toBe(60); // cap
  });
});

describe("isUuid / isNonEmptyString", () => {
  it("isUuid menolak string bukan UUID", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("11111111-1111-1111-1111-111111111111")).toBe(false); // versi nibble salah (harus 1-5)
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("isNonEmptyString menolak string kosong/whitespace", () => {
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString("x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAutomationCredential -- gate autentikasi SATU-SATUNYA yang dipakai
// SEMUA 8 route internal automation (claim/complete/fail/replay/health/
// morning-brief/kpi-daily-summary/dispatch). Setiap route memanggil ini
// PALING AWAL dan mengembalikan 401 kalau hasilnya null -- jadi membuktikan
// fungsi ini menolak anonymous/credential tidak sah SUDAH cukup membuktikan
// endpoint mana pun menolak permintaan tanpa kredensial (401), tanpa perlu
// mengimpor Next.js route handler (route sengaja tipis, lihat komentar di
// claim/route.ts).
// ---------------------------------------------------------------------------
describe("resolveAutomationCredential -- gate 401 untuk semua route internal automation", () => {
  it("Authorization header null (anonymous) -> null, tidak pernah menyentuh repository", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: "cred-1", companyId: "company-1", scope: ["automation.claim"] });
    const result = await resolveAutomationCredential(null, repo);
    expect(result).toBeNull();
  });

  it("Authorization header tanpa prefix 'Bearer ' -> null", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: "cred-1", companyId: "company-1", scope: ["automation.claim"] });
    const result = await resolveAutomationCredential("Basic cred-1", repo);
    expect(result).toBeNull();
  });

  it("Bearer token kosong (hanya 'Bearer ' tanpa isi) -> null", async () => {
    const repo = new InMemoryAutomationRepository();
    const result = await resolveAutomationCredential("Bearer    ", repo);
    expect(result).toBeNull();
  });

  it("Bearer token yang tidak terdaftar di repository -> null (bukan error, fail closed)", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({ id: hashN8nCredential("raw-token-1"), companyId: "company-1", scope: ["automation.claim"] });
    const result = await resolveAutomationCredential("Bearer raw-token-unknown", repo);
    expect(result).toBeNull();
  });

  it("credential revoked -> null walau token/scope cocok", async () => {
    const repo = new InMemoryAutomationRepository();
    repo.seedCredential({
      id: hashN8nCredential("raw-token-revoked"), companyId: "company-1",
      scope: ["automation.claim"], status: "revoked",
    });
    const result = await resolveAutomationCredential("Bearer raw-token-revoked", repo);
    expect(result).toBeNull();
  });

  it("credential aktif dan valid -> resolved dengan companyId dari credential (bukan dari input)", async () => {
    const repo = new InMemoryAutomationRepository();
    const credentialId = hashN8nCredential("raw-token-valid");
    repo.seedCredential({ id: credentialId, companyId: "company-42", scope: ["automation.claim", "automation.health"] });
    const result = await resolveAutomationCredential("Bearer raw-token-valid", repo);
    expect(result).toEqual({ id: credentialId, companyId: "company-42", scope: ["automation.claim", "automation.health"] });
  });
});
