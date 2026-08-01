// =============================================================================
// Gate 3D-B1 (Database Single-Owner Enforcement) -- DB-backed, Postgres/Supabase
// NYATA (bukan mock). Membuktikan migration
// 20260906000001_gate_3d_b1_single_owner_enforcement.sql terhadap kontrak
// docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
// (G1, FROZEN Gate 3D-A1) -- BEFORE INSERT trigger pada public.user_roles
// yang menolak owner kedua untuk company_id yang sama, race-safe, dan tidak
// bisa dilewati oleh service-role/RPC-style write mana pun.
//
// Semua insert di sini sengaja lewat client SERVICE-ROLE (bypass total RLS)
// -- persis meniru jalur RPC/service-role/"direct write" nyata (createSalesman
// workflow, future first-owner RPC). Pembuktian "tidak bisa dilewati" bukan
// dari RLS (trigger tabel selalu jalan untuk peran apa pun, termasuk
// service_role) melainkan dari trigger itu sendiri.
//
// Skip graceful jika kredensial Supabase lokal tidak tersedia -- pola identik
// dengan gate-3b-role-permission-matrix.integration.test.ts.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient as createServiceClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { isLoopbackSupabaseUrl } from "../imports/is-loopback-supabase-url";

function readDotEnvLocal(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.NEXT_PUBLIC_SUPABASE_ANON_KEY || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, anonKey: vars.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

function loadLocalSupabaseEnv(): { url: string; anonKey: string; serviceRoleKey: string } | null {
  const raw =
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
      ? { url: process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }
      : readDotEnvLocal();
  if (!raw) return null;
  if (!isLoopbackSupabaseUrl(raw.url)) return null;
  return raw;
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn("Gate 3D-B1 integration test skipped: Supabase URL is not loopback/local (or credentials unavailable).");
}

describeIfDb("Gate 3D-B1: single-owner-per-company DB enforcement (BEFORE INSERT trigger, Postgres nyata)", () => {
  let service: SupabaseClient;
  const runTag = `itest-g3db1-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const companyA = randomUUID(); // owner pertama sukses, owner kedua ditolak
  const companyB = randomUUID(); // tenant berbeda -- owner tetap sukses
  const companyRace = randomUUID(); // dua insert owner konkuren

  let ownerRoleId = "";
  let adminRoleId = "";
  let salesRoleId = "";

  const authIds: Record<string, string> = {};
  const allCompanyIds = [companyA, companyB, companyRace];

  async function makeAuthAndProfileUser(key: string, companyId: string, spoofedMetadataRole?: string): Promise<string> {
    const email = `${runTag}-${key}@itest.test`;
    const { data: auth, error: authErr } = await service.auth.admin.createUser({
      email,
      password: randomUUID(),
      email_confirm: true,
      user_metadata: spoofedMetadataRole ? { role: spoofedMetadataRole, full_name: `Itest ${key}` } : { full_name: `Itest ${key}` },
    });
    if (authErr || !auth.user) throw new Error(`gagal buat auth user ${key}: ${authErr?.message}`);
    authIds[key] = auth.user.id;
    const { error: profileErr } = await service.from("users").insert({ id: auth.user.id, company_id: companyId, email, full_name: `Itest ${key}`, is_active: true });
    if (profileErr) throw new Error(`gagal buat profile user ${key}: ${profileErr.message}`);
    return auth.user.id;
  }

  beforeAll(async () => {
    service = createServiceClient(env!.url, env!.serviceRoleKey);

    const { error: companiesErr } = await service.from("companies").insert(
      allCompanyIds.map((id, i) => ({
        id,
        name: `Gate 3D-B1 ${runTag} #${i}`,
        slug: `gate-3d-b1-${runTag}-${i}`,
        legal_address: `Jl. Gate 3D-B1 No. ${i}`,
        contact_email: `gate3db1-${i}@demo.test`,
        contact_phone: `021-556${i}`,
        document_number_prefix: `G3DB1${i}`,
      })),
    );
    if (companiesErr) throw new Error(`gagal buat companies: ${companiesErr.message}`);

    const [{ data: ownerRole }, { data: adminRole }, { data: salesRole }] = await Promise.all([
      service.from("roles").select("id").eq("name", "owner").is("company_id", null).single(),
      service.from("roles").select("id").eq("name", "admin").is("company_id", null).single(),
      service.from("roles").select("id").eq("name", "sales").is("company_id", null).single(),
    ]);
    ownerRoleId = (ownerRole as { id: string }).id;
    adminRoleId = (adminRole as { id: string }).id;
    salesRoleId = (salesRole as { id: string }).id;
  }, 60000);

  afterAll(async () => {
    if (!service) return;
    await service.from("user_roles").delete().in("company_id", allCompanyIds);
    const allIds = Object.values(authIds).filter(Boolean);
    await service.from("users").delete().in("id", allIds);
    await service.from("companies").delete().in("id", allCompanyIds);
    for (const id of allIds) await service.auth.admin.deleteUser(id);
  }, 60000);

  it("1. Owner pertama untuk sebuah company BERHASIL", async () => {
    const userId = await makeAuthAndProfileUser("ownerA1", companyA);
    const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyA, role_id: ownerRoleId });
    expect(error).toBeNull();
  });

  it("2. Owner KEDUA untuk company_id yang SAMA DITOLAK oleh trigger (bukan RLS)", async () => {
    const userId = await makeAuthAndProfileUser("ownerA2", companyA);
    const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyA, role_id: ownerRoleId });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("AODP_SINGLE_OWNER_VIOLATION");
    expect(error!.code).toBe("23505");

    // Buktikan tidak ada baris yang ter-insert sama sekali (fail-closed, bukan partial).
    const { data: rows } = await service.from("user_roles").select("id").eq("user_id", userId);
    expect(rows ?? []).toHaveLength(0);
  });

  it("3. Owner untuk company_id yang BERBEDA tetap BERHASIL (bukan blokir global)", async () => {
    const userId = await makeAuthAndProfileUser("ownerB", companyB);
    const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyB, role_id: ownerRoleId });
    expect(error).toBeNull();
  });

  it("4. Role admin di company yang SUDAH punya owner tetap BERHASIL (trigger hanya menyasar role=owner)", async () => {
    const userId = await makeAuthAndProfileUser("adminA", companyA);
    const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyA, role_id: adminRoleId });
    expect(error).toBeNull();
  });

  it("5. Role sales di company yang SUDAH punya owner tetap BERHASIL (trigger hanya menyasar role=owner)", async () => {
    const userId = await makeAuthAndProfileUser("salesA", companyA);
    const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyA, role_id: salesRoleId });
    expect(error).toBeNull();
  });

  it("6. Direct write lewat client service-role (jalur RPC/bypass-RLS) TIDAK dapat melewati enforcement", async () => {
    // Semua insert pada tes ini SUDAH lewat `service` (service-role, bypass total
    // RLS) -- ini bukan RLS policy, melainkan trigger tabel yang berjalan untuk
    // SEMUA jalur tulis termasuk service_role. Tes eksplisit ini menegaskan ulang
    // titik itu: percobaan kedua yang identik dengan tes #2, murni lewat service
    // client, tetap ditolak.
    const userId = await makeAuthAndProfileUser("ownerA3-direct", companyA);
    const { error } = await service.from("user_roles").insert({ user_id: userId, company_id: companyA, role_id: ownerRoleId });
    expect(error).not.toBeNull();
    expect(error!.message).toContain("AODP_SINGLE_OWNER_VIOLATION");
  });

  it("7. Spoofing user_metadata TIDAK memengaruhi keputusan trigger sama sekali", async () => {
    // Auth user dengan user_metadata.role='sales' (spoof) tapi baris user_roles
    // yang benar-benar di-insert adalah role=owner untuk company yang SUDAH
    // punya owner -- tetap ditolak. Trigger hanya membaca role_id -> roles.name,
    // tidak pernah membaca user_metadata (konsisten dengan Gate 3B/3C: 0
    // referensi user_metadata di jalur otorisasi mana pun).
    const userId = await makeAuthAndProfileUser("spoofOwner", companyA, "sales");
    const { data: userData } = await service.auth.admin.getUserById(userId);
    expect((userData.user?.user_metadata as { role?: string } | null)?.role).toBe("sales");

    const { error: ownerAttemptErr } = await service.from("user_roles").insert({ user_id: userId, company_id: companyA, role_id: ownerRoleId });
    expect(ownerAttemptErr).not.toBeNull();
    expect(ownerAttemptErr!.message).toContain("AODP_SINGLE_OWNER_VIOLATION");

    // Sebaliknya: auth user dengan user_metadata.role='owner' (spoof) tapi baris
    // yang sesungguhnya di-insert adalah role=sales -- BERHASIL tanpa halangan,
    // membuktikan trigger tidak pernah dipengaruhi metadata ke arah mana pun.
    const userId2 = await makeAuthAndProfileUser("spoofSales", companyA, "owner");
    const { data: userData2 } = await service.auth.admin.getUserById(userId2);
    expect((userData2.user?.user_metadata as { role?: string } | null)?.role).toBe("owner");

    const { error: salesAttemptErr } = await service.from("user_roles").insert({ user_id: userId2, company_id: companyA, role_id: salesRoleId });
    expect(salesAttemptErr).toBeNull();
  });

  it("8. Dua insert owner KONKUREN untuk company_id yang sama -- tepat SATU berhasil, tidak pernah dua-duanya (race-safe)", async () => {
    const [userIdRace1, userIdRace2] = await Promise.all([
      makeAuthAndProfileUser("ownerRace1", companyRace),
      makeAuthAndProfileUser("ownerRace2", companyRace),
    ]);

    const [result1, result2] = await Promise.all([
      service.from("user_roles").insert({ user_id: userIdRace1, company_id: companyRace, role_id: ownerRoleId }),
      service.from("user_roles").insert({ user_id: userIdRace2, company_id: companyRace, role_id: ownerRoleId }),
    ]);

    const errors = [result1.error, result2.error];
    const successCount = errors.filter((e) => e === null).length;
    const failureCount = errors.filter((e) => e !== null).length;

    expect(successCount).toBe(1);
    expect(failureCount).toBe(1);
    const failedError = errors.find((e) => e !== null);
    expect(failedError!.message).toContain("AODP_SINGLE_OWNER_VIOLATION");

    // Verifikasi tegas di level DB: tepat satu baris owner untuk company ini,
    // tidak peduli hasil promise mana yang "menang" race di sisi client.
    const { data: ownerRows } = await service
      .from("user_roles")
      .select("id, user_id")
      .eq("company_id", companyRace)
      .eq("role_id", ownerRoleId);
    expect(ownerRows ?? []).toHaveLength(1);
  }, 30000);
});
