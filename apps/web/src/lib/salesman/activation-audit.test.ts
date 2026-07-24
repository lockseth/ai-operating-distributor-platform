// =============================================================================
// Gate 1D-B1 — Retrofit audit writer kanonis: Salesman activation/deactivation.
//
// set_salesman_active_status (Gate 1B) SUDAH menulis audit_logs atomik sejak
// awal -- gap yang direstrofit di sini murni kolom kanonis Gate 1D-A
// (actor_type/event_category/module/source/outcome) yang belum diisi. Logic
// otorisasi/idempotency/rollback hidup di SQL (PL/pgSQL), bukan TypeScript --
// tidak bisa dibuktikan lewat InMemorySalesmanRepository (lihat
// workflow.test.ts untuk itu). Pola test baca-migration-sebagai-teks ini sama
// dengan apps/web/src/lib/audit-log/security.test.ts (Gate 1D-A).
// =============================================================================

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260820000001_salesman_activation_audit_canonical.sql",
  ),
  "utf8",
);

describe("Gate 1D-B1 — set_salesman_active_status: signature tidak berubah", () => {
  it("CREATE OR REPLACE (bukan CREATE baru), tidak ada writer paralel", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.set_salesman_active_status(");
    const matches = migration.match(/CREATE (OR REPLACE )?FUNCTION public\.set_salesman_active_status/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("signature parameter dan return type identik dengan migration Gate 1B (20260815000001)", () => {
    const start = migration.indexOf("CREATE OR REPLACE FUNCTION public.set_salesman_active_status(");
    const body = migration.slice(start, start + 300);
    expect(body).toContain("p_company_id UUID");
    expect(body).toContain("p_user_id UUID");
    expect(body).toContain("p_active BOOLEAN");
    expect(body).toContain("p_actor_id UUID");
    expect(body).toContain("RETURNS TABLE(result_outcome TEXT)");
  });

  it("REVOKE ALL + GRANT EXECUTE dipertahankan dengan signature yang sama (service_role saja)", () => {
    expect(migration).toContain(
      "REVOKE ALL ON FUNCTION public.set_salesman_active_status(UUID, UUID, BOOLEAN, UUID)",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION public.set_salesman_active_status(UUID, UUID, BOOLEAN, UUID)",
    );
    expect(migration).toContain("TO service_role");
  });

  it("tidak ada tabel audit paralel dibuat", () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]*audit/i);
  });
});

describe("Gate 1D-B1 — event contract kanonis", () => {
  it("event type stabil salesman.activated / salesman.deactivated dipertahankan", () => {
    expect(migration).toContain("'salesman.activated'");
    expect(migration).toContain("'salesman.deactivated'");
  });

  it("INSERT audit_logs mengisi kolom kanonis baru (actor_type, event_category, module, source, outcome)", () => {
    const start = migration.indexOf("INSERT INTO public.audit_logs (");
    expect(start).toBeGreaterThan(-1);
    const end = migration.indexOf(");", start);
    const insertStatement = migration.slice(start, end);
    for (const column of ["actor_type", "event_category", "module", "source", "outcome"]) {
      expect(insertStatement).toContain(column);
    }
    expect(insertStatement).toContain("'owner'");
    expect(insertStatement).toContain("'audit'");
    expect(insertStatement).toContain("'salesman'");
    expect(insertStatement).toContain("'rpc'");
    expect(insertStatement).toContain("'success'");
  });

  it("hanya SATU INSERT INTO audit_logs pada migration ini (bukan double-write)", () => {
    const matches = migration.match(/INSERT INTO public\.audit_logs/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("actor (user_id) berasal dari p_actor_id, company_id dari p_company_id, target dari p_user_id -- bukan literal/konstanta bebas", () => {
    const start = migration.indexOf("INSERT INTO public.audit_logs (");
    const end = migration.indexOf(");", start);
    const insertStatement = migration.slice(start, end);
    expect(insertStatement).toContain("p_company_id,");
    expect(insertStatement).toContain("p_actor_id,");
    expect(insertStatement).toContain("p_user_id,");
  });

  it("before/after data minimal { is_active } berasal dari state sebelum/sesudah mutasi (bukan echo input mentah)", () => {
    const start = migration.indexOf("INSERT INTO public.audit_logs (");
    const end = migration.indexOf(");", start);
    const insertStatement = migration.slice(start, end);
    expect(insertStatement).toContain("jsonb_build_object('is_active', v_current_active)");
    expect(insertStatement).toContain("jsonb_build_object('is_active', p_active)");
  });

  it("entity_type/entity_id menunjuk ke user Salesman target (public.users, p_user_id) -- konsisten dengan writer Gate 1B lain di modul Pengguna", () => {
    const start = migration.indexOf("INSERT INTO public.audit_logs (");
    const end = migration.indexOf(");", start);
    const insertStatement = migration.slice(start, end);
    expect(insertStatement).toContain("'users',");
  });
});

describe("Gate 1D-B1 — no-op tidak menciptakan audit palsu", () => {
  // Anchor pencarian ke dalam BODY fungsi (setelah BEGIN) supaya tidak
  // ketemu penyebutan "UPDATE public.users"/"'unchanged'"/"'success'" di
  // blok komentar rationale di atas fungsi -- itu prosa, bukan kode.
  const fnBodyStart = migration.indexOf("BEGIN\n");

  it("cabang 'unchanged' RETURN QUERY muncul SEBELUM UPDATE dan INSERT audit_logs manapun", () => {
    const unchangedIdx = migration.indexOf("RETURN QUERY SELECT 'unchanged'::TEXT;", fnBodyStart);
    const updateIdx = migration.indexOf("UPDATE public.users", fnBodyStart);
    const insertIdx = migration.indexOf("INSERT INTO public.audit_logs", fnBodyStart);
    expect(unchangedIdx).toBeGreaterThan(fnBodyStart);
    expect(updateIdx).toBeGreaterThan(fnBodyStart);
    expect(insertIdx).toBeGreaterThan(fnBodyStart);
    expect(unchangedIdx).toBeLessThan(updateIdx);
    expect(unchangedIdx).toBeLessThan(insertIdx);
  });

  it("outcome 'success' hanya dipakai pada baris yang benar-benar tereksekusi setelah mutasi (bukan dikirim untuk unchanged/forbidden/not_found/not_eligible)", () => {
    // outcome='success' hanya boleh muncul di dalam INSERT audit_logs itu sendiri,
    // tidak pernah dikembalikan sebagai result_outcome RPC (yang tetap
    // activated/deactivated/unchanged/forbidden/not_found/not_eligible -- lihat
    // repository.ts switch-case yang tidak berubah).
    const insertStart = migration.indexOf("INSERT INTO public.audit_logs (", fnBodyStart);
    const insertEnd = migration.indexOf(");", insertStart);
    const fnEnd = migration.indexOf("$$;", fnBodyStart);
    const bodyOutsideInsert = migration.slice(fnBodyStart, insertStart) + migration.slice(insertEnd, fnEnd);
    expect(bodyOutsideInsert).not.toContain("'success'");
  });
});

describe("Gate 1D-B1 — atomicity / rollback", () => {
  it("tidak ada blok EXCEPTION yang bisa menelan kegagalan INSERT audit (kegagalan harus membatalkan seluruh fungsi, termasuk UPDATE is_active)", () => {
    expect(migration).not.toMatch(/EXCEPTION\s+WHEN/i);
  });

  it("UPDATE public.users mendahului INSERT audit_logs dalam satu fungsi PL/pgSQL yang sama (satu transaksi implisit, bukan dua statement terpisah lewat app layer)", () => {
    const fnStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.set_salesman_active_status(");
    const updateIdx = migration.indexOf("UPDATE public.users", fnStart);
    const insertIdx = migration.indexOf("INSERT INTO public.audit_logs", fnStart);
    const fnEnd = migration.indexOf("$$;", fnStart);
    expect(updateIdx).toBeGreaterThan(fnStart);
    expect(insertIdx).toBeGreaterThan(updateIdx);
    expect(insertIdx).toBeLessThan(fnEnd);
  });

  it("audit write TIDAK melalui logAuditEvent (server action fire-and-forget) -- murni SQL dalam RPC SECURITY DEFINER yang sama", () => {
    expect(migration).not.toContain("logAuditEvent");
    expect(migration).toContain("SECURITY DEFINER");
  });
});

describe("Gate 1D-B1 — otorisasi Gate 1B tidak berubah", () => {
  it("actor harus owner aktif pada tenant yang sama sebelum baris audit manapun bisa tercapai", () => {
    const actorCheckIdx = migration.indexOf("v_actor_allowed");
    const forbiddenIdx = migration.indexOf("RETURN QUERY SELECT 'forbidden'::TEXT;");
    const insertIdx = migration.indexOf("INSERT INTO public.audit_logs");
    expect(actorCheckIdx).toBeGreaterThan(-1);
    expect(forbiddenIdx).toBeGreaterThan(actorCheckIdx);
    expect(forbiddenIdx).toBeLessThan(insertIdx);
    expect(migration).toContain("r.name = 'owner'");
  });

  it("target harus role sales pada tenant yang sama sebelum audit ditulis", () => {
    const notEligibleIdx = migration.indexOf("RETURN QUERY SELECT 'not_eligible'::TEXT;");
    const insertIdx = migration.indexOf("INSERT INTO public.audit_logs");
    expect(notEligibleIdx).toBeGreaterThan(-1);
    expect(notEligibleIdx).toBeLessThan(insertIdx);
    expect(migration).toContain("r.name = 'sales'");
  });
});
