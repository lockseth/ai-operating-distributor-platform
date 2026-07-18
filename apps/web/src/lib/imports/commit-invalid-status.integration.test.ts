// =============================================================================
// DB-backed integration test -- commit_import_batch RPC, invalid_status path.
//
// Root cause fixed by migration 20260803000001: RETURN QUERY di PL/pgSQL
// menuntut kecocokan TIPE PERSIS dengan RETURNS TABLE(result_outcome TEXT,
// detail TEXT). v_batch.status bertipe VARCHAR(20) (kolom import_batches.
// status) -- tanpa cast eksplisit, Postgres melempar "structure of query
// does not match function result type" SETIAP KALI jalur ini dieksekusi.
// Mock/InMemory TIDAK menegakkan tipe kolom Postgres sama sekali, sehingga
// TIDAK BISA membuktikan fix ini -- test ini sengaja memanggil RPC
// sungguhan lewat @supabase/supabase-js (bukan mock) terhadap Postgres
// lokal nyata.
//
// Skip graceful (bukan fail) kalau kredensial Supabase lokal tidak
// tersedia -- menjaga `pnpm test` tetap hermetic untuk kontributor tanpa
// Docker berjalan, sambil tetap menguji RPC sungguhan saat infra tersedia
// (yang selalu tersedia dalam alur dev normal repo ini).
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";

function loadLocalSupabaseEnv(): { url: string; serviceRoleKey: string } | null {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { url: process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY };
  }
  const envPath = path.resolve(__dirname, "../../../.env.local");
  if (!existsSync(envPath)) return null;
  const text = readFileSync(envPath, "utf-8");
  const vars = Object.fromEntries(
    text.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
  );
  if (!vars.NEXT_PUBLIC_SUPABASE_URL || !vars.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: vars.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey: vars.SUPABASE_SERVICE_ROLE_KEY };
}

const env = loadLocalSupabaseEnv();
const describeIfDb = env ? describe : describe.skip;

if (!env) {
  console.warn(
    "[commit-invalid-status.integration.test] SKIPPED -- kredensial Supabase lokal (.env.local) tidak ditemukan. " +
    "Test ini butuh Postgres nyata untuk membuktikan kompatibilitas tipe RETURN QUERY, tidak bisa digantikan mock."
  );
}

describeIfDb("commit_import_batch RPC -- invalid_status path (DB-backed, Postgres nyata)", () => {
  let supabase: SupabaseClient;
  const runTag = `itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const companyAId = randomUUID();
  const companyBId = randomUUID();
  let ownerAAuthId = "";
  let ownerBAuthId = "";
  const uploadedBatchId = randomUUID();
  const readyBatchId = randomUUID();

  beforeAll(async () => {
    supabase = createClient(env!.url, env!.serviceRoleKey);

    const { data: ownerRole } = await supabase.from("roles").select("id").eq("name", "owner").single();
    const ownerRoleId = (ownerRole as { id: string }).id;

    const { data: ownerAAuth, error: ownerAErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner-a@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (ownerAErr || !ownerAAuth.user) throw new Error(`gagal buat auth user A: ${ownerAErr?.message}`);
    ownerAAuthId = ownerAAuth.user.id;

    const { data: ownerBAuth, error: ownerBErr } = await supabase.auth.admin.createUser({
      email: `${runTag}-owner-b@verify.test`, password: randomUUID(), email_confirm: true,
    });
    if (ownerBErr || !ownerBAuth.user) throw new Error(`gagal buat auth user B: ${ownerBErr?.message}`);
    ownerBAuthId = ownerBAuth.user.id;

    await supabase.from("companies").insert([
      { id: companyAId, name: `Verify Co A ${runTag}`, slug: `verify-a-${runTag}` },
      { id: companyBId, name: `Verify Co B ${runTag}`, slug: `verify-b-${runTag}` },
    ]);
    await supabase.from("users").insert([
      { id: ownerAAuthId, company_id: companyAId, email: `${runTag}-owner-a@verify.test`, full_name: "Owner A", is_active: true },
      { id: ownerBAuthId, company_id: companyBId, email: `${runTag}-owner-b@verify.test`, full_name: "Owner B", is_active: true },
    ]);
    await supabase.from("user_roles").insert([
      { user_id: ownerAAuthId, company_id: companyAId, role_id: ownerRoleId },
      { user_id: ownerBAuthId, company_id: companyBId, role_id: ownerRoleId },
    ]);

    // Batch A: masih UPLOADED (belum divalidasi) -- target utama skenario invalid_status.
    await supabase.from("import_batches").insert({
      id: uploadedBatchId, company_id: companyAId, import_type: "CUSTOMER_PIC",
      source_system: "ITEST", original_filename: "itest-uploaded.csv", file_hash: `${runTag}-h1`,
      status: "UPLOADED", created_by: ownerAAuthId, total_rows: 0, valid_rows: 0, warning_rows: 0, error_rows: 0, duplicate_rows: 0,
    });

    // Batch B: READY_TO_COMMIT (regresi -- happy path harus tetap jalan, + idempotency).
    await supabase.from("import_batches").insert({
      id: readyBatchId, company_id: companyAId, import_type: "CUSTOMER_PIC",
      source_system: "ITEST", original_filename: "itest-ready.csv", file_hash: `${runTag}-h2`,
      status: "READY_TO_COMMIT", created_by: ownerAAuthId, total_rows: 1, valid_rows: 1, warning_rows: 0, error_rows: 0, duplicate_rows: 0,
    });
    await supabase.from("import_batch_rows").insert({
      batch_id: readyBatchId, company_id: companyAId, row_number: 1, raw_data: {},
      normalized_data: {
        store_legacy_code: `TKI-${runTag}`, store_name: "Toko Integration Test",
        pic_name: "PIC Verify", pic_phone: `0819${Date.now() % 100000000}`, pic_roles: ["OWNER"], is_active: true,
      },
      validation_status: "VALID", proposed_action: "CREATE", row_hash: `${runTag}-rh1`,
    });
  }, 30000);

  afterAll(async () => {
    if (!supabase) return;
    await supabase.from("import_batch_rows").delete().in("batch_id", [uploadedBatchId, readyBatchId]);
    await supabase.from("customer_pics").delete().eq("company_id", companyAId);
    await supabase.from("customers").delete().eq("company_id", companyAId);
    await supabase.from("import_batches").delete().in("id", [uploadedBatchId, readyBatchId]);
    await supabase.from("user_roles").delete().in("company_id", [companyAId, companyBId]);
    await supabase.from("users").delete().in("id", [ownerAAuthId, ownerBAuthId]);
    await supabase.from("companies").delete().in("id", [companyAId, companyBId]);
    if (ownerAAuthId) await supabase.auth.admin.deleteUser(ownerAAuthId);
    if (ownerBAuthId) await supabase.auth.admin.deleteUser(ownerBAuthId);
  }, 30000);

  it("1-4. batch UPLOADED -> outcome invalid_status, detail berupa TEXT ('UPLOADED'), TIDAK ADA exception, batch tetap UPLOADED", async () => {
    const { data, error } = await supabase.rpc("commit_import_batch", {
      p_company_id: companyAId, p_batch_id: uploadedBatchId, p_actor_id: ownerAAuthId,
    });

    expect(error).toBeNull(); // 3. tidak ada PostgreSQL exception
    const row = (data ?? [])[0] as { result_outcome: string; detail: string | null } | undefined;
    expect(row?.result_outcome).toBe("invalid_status"); // 1.
    expect(typeof row?.detail).toBe("string"); // 2. detail dikembalikan sebagai string/text
    expect(row?.detail).toBe("UPLOADED");

    const { data: batchAfter } = await supabase.from("import_batches").select("status").eq("id", uploadedBatchId).single();
    expect((batchAfter as { status: string }).status).toBe("UPLOADED"); // 4. batch tetap UPLOADED
  });

  it("5. tidak ada customer/PIC yang ter-commit dari batch UPLOADED", async () => {
    const { count } = await supabase.from("customers").select("id", { count: "exact", head: true })
      .eq("company_id", companyAId).eq("import_batch_id", uploadedBatchId);
    expect(count ?? 0).toBe(0);
    const { count: picCount } = await supabase.from("customer_pics").select("id", { count: "exact", head: true })
      .eq("company_id", companyAId).eq("import_batch_id", uploadedBatchId);
    expect(picCount ?? 0).toBe(0);
  });

  it("6. batch READY_TO_COMMIT tetap bisa di-commit normal (regresi -- fix tidak merusak happy path)", async () => {
    const { data, error } = await supabase.rpc("commit_import_batch", {
      p_company_id: companyAId, p_batch_id: readyBatchId, p_actor_id: ownerAAuthId,
    });
    expect(error).toBeNull();
    const row = (data ?? [])[0] as { result_outcome: string; detail: string | null } | undefined;
    expect(row?.result_outcome).toBe("committed");

    const { data: batchAfter } = await supabase.from("import_batches").select("status, commit_result").eq("id", readyBatchId).single();
    expect((batchAfter as { status: string }).status).toBe("COMMITTED");
    expect((batchAfter as { commit_result: { createdCount: number } }).commit_result.createdCount).toBe(1);
  });

  it("7. retry commit (idempotency) -- already_committed, tidak menggandakan data", async () => {
    const { data, error } = await supabase.rpc("commit_import_batch", {
      p_company_id: companyAId, p_batch_id: readyBatchId, p_actor_id: ownerAAuthId,
    });
    expect(error).toBeNull();
    const row = (data ?? [])[0] as { result_outcome: string } | undefined;
    expect(row?.result_outcome).toBe("already_committed");

    const { count } = await supabase.from("customers").select("id", { count: "exact", head: true })
      .eq("company_id", companyAId).eq("import_batch_id", readyBatchId);
    expect(count ?? 0).toBe(1); // tetap 1, tidak digandakan oleh retry
  });

  it("8. cross-tenant caller (Owner B) ditolak saat mencoba commit batch Company A", async () => {
    const { data, error } = await supabase.rpc("commit_import_batch", {
      p_company_id: companyAId, p_batch_id: uploadedBatchId, p_actor_id: ownerBAuthId,
    });
    expect(error).toBeNull();
    const row = (data ?? [])[0] as { result_outcome: string } | undefined;
    expect(row?.result_outcome).toBe("forbidden");
  });
});
