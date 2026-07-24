import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../../../../supabase/migrations/20260819000001_activity_audit_log_foundation.sql",
  ),
  "utf8",
);

const page = readFileSync(
  path.resolve(__dirname, "../../app/(dashboard)/dashboard/owner/activity-log/page.tsx"),
  "utf8",
);

const filters = readFileSync(
  path.resolve(__dirname, "../../components/audit-log/audit-log-filters.tsx"),
  "utf8",
);

describe("Gate 1D-A — audit_logs tetap tabel tunggal, additive-only", () => {
  it("migration TIDAK membuat tabel log paralel (hanya ALTER TABLE audit_logs)", () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]*audit/i);
    expect(migration).toContain("ALTER TABLE public.audit_logs");
  });

  it("kolom baru semua ditambahkan via ADD COLUMN IF NOT EXISTS (additive, tidak destructive)", () => {
    for (const column of [
      "actor_type", "event_category", "module", "source", "outcome", "reason", "metadata", "request_id",
    ]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });

  it("tidak menggandakan before_state/after_state/occurred_at -- dipetakan ke old_data/new_data/created_at existing", () => {
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS before_state/);
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS after_state/);
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS occurred_at/);
    expect(migration).toContain("Kanonis: before_state");
    expect(migration).toContain("Kanonis: after_state");
    expect(migration).toContain("Kanonis: occurred_at");
  });
});

describe("Gate 1D-A — append-only hardening", () => {
  it("REVOKE eksplisit INSERT/UPDATE/DELETE dari authenticated dan anon", () => {
    expect(migration).toContain("REVOKE INSERT, UPDATE, DELETE ON TABLE public.audit_logs FROM authenticated, anon");
  });

  it("REVOKE eksplisit TRUNCATE dari authenticated dan anon (TRUNCATE tidak tunduk RLS, bisa mengosongkan semua tenant)", () => {
    expect(migration).toContain("REVOKE TRUNCATE ON TABLE public.audit_logs FROM authenticated, anon");
  });

  it("tidak ada policy UPDATE/DELETE baru ditambahkan (append-only tetap dipertahankan)", () => {
    expect(migration).not.toMatch(/CREATE POLICY[^;]*FOR UPDATE[^;]*audit_logs/i);
    expect(migration).not.toMatch(/CREATE POLICY[^;]*FOR DELETE[^;]*audit_logs/i);
  });
});

describe("Gate 1D-A security remediation — audit_logs_select dipersempit ke owner-only", () => {
  it("policy audit_logs_select LAMA (owner/manager/super_admin) di-DROP secara eksplisit", () => {
    expect(migration).toContain('DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs');
  });

  it("policy audit_logs_select BARU: FOR SELECT, company_id dari get_user_company_id(), plus EXISTS check role owner", () => {
    const start = migration.indexOf('CREATE POLICY "audit_logs_select"');
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, start + 700);
    expect(body).toContain("FOR SELECT");
    expect(body).toContain("company_id = public.get_user_company_id()");
    expect(body).toContain("r.name = 'owner'");
  });

  it("policy BARU memeriksa is_active = TRUE pada actor (bukan reuse user_has_role() yang tidak cek is_active)", () => {
    const start = migration.indexOf('CREATE POLICY "audit_logs_select"');
    const body = migration.slice(start, start + 700);
    expect(body).toContain("u.is_active = TRUE");
    expect(body).not.toContain("user_has_role(");
  });

  it("policy BARU TIDAK lagi menyebut role manager/super_admin/sales sama sekali", () => {
    const start = migration.indexOf('CREATE POLICY "audit_logs_select"');
    const end = migration.indexOf(";", start) + 1;
    const body = migration.slice(start, end);
    expect(body).not.toMatch(/'manager'/);
    expect(body).not.toMatch(/'super_admin'/);
    expect(body).not.toMatch(/'sales'/);
    expect(body).not.toMatch(/'admin'/);
  });

  it("policy BARU mem-filter company_id sebelum EXISTS -- tenant isolation tidak bergantung hanya pada subquery role", () => {
    const start = migration.indexOf('CREATE POLICY "audit_logs_select"');
    const body = migration.slice(start, start + 200);
    const companyIdx = body.indexOf("company_id = public.get_user_company_id()");
    const existsIdx = body.indexOf("EXISTS");
    expect(companyIdx).toBeGreaterThan(-1);
    expect(companyIdx).toBeLessThan(existsIdx);
  });

  it("hanya SATU CREATE POLICY audit_logs_select di migration ini (bukan menambah policy permisif kedua)", () => {
    const matches = migration.match(/CREATE POLICY "audit_logs_select"/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("Gate 1D-A — kolom baru punya CHECK constraint enum (no-op tidak boleh masuk nilai sembarang)", () => {
  it("actor_type, event_category, source, outcome semua punya CHECK constraint bernama", () => {
    for (const constraint of [
      "audit_logs_actor_type_check",
      "audit_logs_event_category_check",
      "audit_logs_source_check",
      "audit_logs_outcome_check",
    ]) {
      expect(migration).toContain(constraint);
    }
  });

  it("outcome enum termasuk 'unchanged' -- no-op tidak boleh tercatat seolah perubahan nyata", () => {
    const start = migration.indexOf("audit_logs_outcome_check");
    const body = migration.slice(start, start + 300);
    expect(body).toContain("'unchanged'");
  });
});

describe("Gate 1D-A — index query utama tersedia", () => {
  it("index company_id+category, company_id+module, company_id+action+outcome ada", () => {
    expect(migration).toContain("idx_audit_logs_company_category");
    expect(migration).toContain("idx_audit_logs_company_module");
    expect(migration).toContain("idx_audit_logs_company_action_outcome");
  });
});

describe("Gate 1D-A — halaman Activity & Audit Log owner-only, tenant dari sesi", () => {
  it("redirect non-owner dan sesi demo sebelum query apa pun di dalam page component", () => {
    const pageComponentStart = page.indexOf("export default async function ActivityAuditLogPage");
    expect(pageComponentStart).toBeGreaterThan(-1);
    const body = page.slice(pageComponentStart);
    const guardIdx = body.indexOf("if (user.isDemo || !user.roles.includes(\"owner\"))");
    const firstQueryIdx = body.indexOf("createClient()");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstQueryIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(firstQueryIdx);
  });

  it("company_id SELALU dari user.company_id (sesi), tidak pernah dari searchParams/params", () => {
    expect(page).toContain(".eq(\"company_id\", companyId)");
    expect(page).toContain(".eq(\"company_id\", user.company_id)");
    expect(page).not.toMatch(/company_id.*params\./);
  });

  it("tidak ada tombol/aksi edit atau delete pada halaman", () => {
    expect(page).not.toMatch(/DELETE FROM|\.delete\(\)|onDelete|handleDelete/i);
    expect(page).not.toMatch(/onEdit|handleEdit|<EditButton/i);
  });

  it("timestamp memakai formatter Asia/Jakarta", () => {
    expect(page).toContain("formatJakartaDateTime");
  });

  it("before/after state dan reason di-redact sebelum dirender (tidak dump JSON mentah)", () => {
    expect(page).toContain("summarizeChange(row.old_data, row.new_data)");
    expect(page).toContain("redactSensitive({ reason: row.reason })");
    expect(page).not.toMatch(/JSON\.stringify\(row\.(old_data|new_data)\)/);
  });

  it("pagination bounded (PAGE_SIZE tetap, memakai .range())", () => {
    expect(page).toContain("const PAGE_SIZE = 20");
    expect(page).toContain(".range(offset, offset + PAGE_SIZE - 1)");
  });

  it("filter periode, modul, pelaku, kategori, aksi, entitas, sumber, outcome, pencarian semua diterapkan ke query", () => {
    for (const clause of [
      'query.or(`action.ilike',
      'query.gte("created_at"',
      'query.lte("created_at"',
      'query.ilike("module"',
      'query.ilike("action"',
      'query.ilike("entity_type"',
      'query.eq("event_category"',
      'query.eq("source"',
      'query.eq("outcome"',
      'query.eq("user_id", actor)',
    ]) {
      expect(page).toContain(clause);
    }
  });
});

describe("Gate 1D-A — filter UI tidak mengandung kontrol edit/hapus", () => {
  it("audit-log-filters.tsx murni navigasi (router.replace), tidak ada mutation call", () => {
    expect(filters).toContain("router.replace(");
    // sp.delete(...) di sini adalah URLSearchParams.delete (hapus query param),
    // BUKAN mutasi data -- yang diperiksa adalah absennya writer/mutation nyata.
    expect(filters).not.toMatch(/logAuditEvent|getAdminClient|supabase|\.insert\(|\.update\(/);
  });
});
