-- =============================================================================
-- Gate 1D-A — Activity & Audit Log Foundation.
--
-- public.audit_logs (migration 20260626000003) sudah ada dan sudah dipakai
-- puluhan writer (RPC SECURITY DEFINER + logAuditEvent server action) sejak
-- baseline. Gate 1D-A TIDAK membuat tabel log paralel -- hanya memperluas
-- audit_logs secara ADDITIVE supaya event contract kanonis (company_id,
-- actor_id nullable, actor_type, event_category, module, action, entity_type,
-- entity_id, before/after state, source, outcome, reason, metadata,
-- request_id, occurred_at) bisa direpresentasikan dengan aman, TANPA
-- mengubah makna kolom existing:
--   * before_state/after_state  -> dipetakan ke old_data/new_data existing
--     (TIDAK digandakan sebagai kolom baru).
--   * occurred_at               -> dipetakan ke created_at existing (semua
--     writer saat ini menulis synchronous, created_at == waktu kejadian;
--     TIDAK ada kolom occurred_at terpisah).
--   * actor_id                  -> user_id existing (sudah nullable sejak
--     awal untuk actor AI/system).
-- Kolom baru (actor_type, event_category, module, source, outcome, reason,
-- metadata, request_id) SEMUA nullable, TANPA DEFAULT yang memaksa backfill
-- speculative -- event lama tetap terbaca apa adanya (NULL pada kolom baru).
-- Retrofit actor_type/event_category/module/source/outcome untuk seluruh
-- writer existing adalah scope Gate 1D-B/1D-C, BUKAN gate ini.
--
-- Koreksi security review: policy "audit_logs_select" asli (20260626000004)
-- mengizinkan owner/manager/super_admin membaca audit_logs. Tidak ada reader
-- lain di repo ini yang bergantung pada akses manager/super_admin (dicek via
-- grep sebelum migration ini ditulis -- lihat security.test.ts). DIPERSEMPIT
-- di bagian 4 di bawah menjadi HANYA user AKTIF ber-role 'owner' pada tenant
-- yang sama -- bukan lagi hanya app-layer redirect di atas RLS yang lebih
-- longgar. App-layer guard (page redirect di halaman Owner "Activity & Audit
-- Log") TETAP dipertahankan sebagai lapisan kedua (defense-in-depth), BUKAN
-- lagi satu-satunya lapisan owner-only.
--
-- Hardening tambahan (defense-in-depth, bukan perubahan perilaku existing):
-- audit_logs TIDAK pernah punya RLS policy UPDATE/DELETE (append-only by
-- omission sejak awal) -- REVOKE eksplisit UPDATE/DELETE/INSERT dari
-- authenticated/anon di bawah membuat jaminan ini tidak bergantung pada
-- default privilege Postgres/Supabase yang mungkin berubah di masa depan.
-- INSERT existing (RPC SECURITY DEFINER + getAdminClient() service_role)
-- TIDAK terpengaruh -- keduanya berjalan di luar privilege authenticated/anon.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Kolom kanonis tambahan (semua nullable, tanpa backfill spekulatif)
-- ---------------------------------------------------------------------------

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS actor_type     TEXT,
  ADD COLUMN IF NOT EXISTS event_category TEXT,
  ADD COLUMN IF NOT EXISTS module         TEXT,
  ADD COLUMN IF NOT EXISTS source         TEXT,
  ADD COLUMN IF NOT EXISTS outcome        TEXT,
  ADD COLUMN IF NOT EXISTS reason         TEXT,
  ADD COLUMN IF NOT EXISTS metadata       JSONB,
  ADD COLUMN IF NOT EXISTS request_id     UUID;

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_actor_type_check
  CHECK (
    actor_type IS NULL OR actor_type IN (
      'owner', 'manager', 'admin', 'sales', 'finance', 'warehouse', 'driver',
      'super_admin', 'ai', 'system'
    )
  );

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_event_category_check;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_event_category_check
  CHECK (event_category IS NULL OR event_category IN ('audit', 'activity', 'security'));

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_source_check;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_source_check
  CHECK (source IS NULL OR source IN ('web', 'telegram', 'whatsapp', 'ai', 'automation', 'rpc'));

ALTER TABLE public.audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_outcome_check;
ALTER TABLE public.audit_logs
  ADD CONSTRAINT audit_logs_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('success', 'rejected', 'unchanged', 'failed'));

COMMENT ON COLUMN public.audit_logs.actor_type IS
  'Kanonis Gate 1D-A. Nullable -- event lama (pre-1D-A) tidak di-backfill spekulatif. owner/manager/admin/sales/finance/warehouse/driver/super_admin untuk actor manusia; ai/system untuk actor non-manusia (user_id biasanya NULL).';
COMMENT ON COLUMN public.audit_logs.event_category IS
  'Kanonis Gate 1D-A. audit = perubahan data; activity = aksi non-mutating (mis. navigasi, export -- Gate 1D-C); security = auth/permission/pairing. Nullable untuk event lama.';
COMMENT ON COLUMN public.audit_logs.module IS
  'Nama modul/menu asal event (mis. "customers", "sales_kpi"). Nullable untuk event lama -- retrofit di Gate 1D-B/C.';
COMMENT ON COLUMN public.audit_logs.source IS
  'Kanal asal event: web, telegram, whatsapp, ai, automation, rpc. Nullable untuk event lama.';
COMMENT ON COLUMN public.audit_logs.outcome IS
  'Hasil aksi: success, rejected, unchanged, failed. "unchanged" mencegah no-op tercatat seolah perubahan nyata (lihat rule Gate 1D). Nullable untuk event lama.';
COMMENT ON COLUMN public.audit_logs.reason IS
  'Alasan/catatan opsional (mis. alasan rejected/failed). Tidak boleh berisi token/password/credential -- tanggung jawab writer, lihat kontrak Gate 1D.';
COMMENT ON COLUMN public.audit_logs.metadata IS
  'Konteks tambahan aman (BUKAN before/after state -- lihat old_data/new_data). Writer wajib tidak menaruh token/password/session/api key/credential/authorization header di sini.';
COMMENT ON COLUMN public.audit_logs.request_id IS
  'Correlation/dedupe id opsional untuk tracing lintas writer (mis. satu business operation yang menulis >1 event).';

COMMENT ON COLUMN public.audit_logs.old_data IS
  'Kanonis: before_state. Dipetakan dari nama existing old_data -- TIDAK ada kolom before_state terpisah supaya tidak menggandakan makna.';
COMMENT ON COLUMN public.audit_logs.new_data IS
  'Kanonis: after_state. Dipetakan dari nama existing new_data -- TIDAK ada kolom after_state terpisah supaya tidak menggandakan makna.';
COMMENT ON COLUMN public.audit_logs.created_at IS
  'Kanonis: occurred_at. Semua writer existing menulis synchronous (created_at == waktu kejadian) -- TIDAK ada kolom occurred_at terpisah supaya tidak menggandakan makna.';

-- ---------------------------------------------------------------------------
-- 2. Index tambahan untuk query reader (filter kategori/modul/action+outcome)
--    idx_audit_logs_company_id (company_id, created_at DESC) dan
--    idx_audit_logs_user_id (actor) SUDAH ADA sejak 20260626000003 --
--    TIDAK diduplikasi di sini.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_category
  ON public.audit_logs (company_id, event_category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_module
  ON public.audit_logs (company_id, module, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_action_outcome
  ON public.audit_logs (company_id, action, outcome);

-- ---------------------------------------------------------------------------
-- 3. Append-only hardening (explicit, tidak bergantung pada default privilege)
--    RLS audit_logs sejak awal HANYA punya policy SELECT (lihat
--    20260626000004) -- tidak pernah ada policy UPDATE/DELETE/INSERT untuk
--    authenticated/anon. REVOKE di bawah membuat jaminan ini eksplisit di
--    level grant, bukan hanya "kebetulan tidak ada policy".
--
--    TRUNCATE eksplisit di-REVOKE juga (koreksi security review lanjutan):
--    TRUNCATE adalah privilege GRANT terpisah dari INSERT/UPDATE/DELETE dan
--    TIDAK tunduk pada RLS sama sekali -- role manapun yang punya privilege
--    ini bisa mengosongkan SELURUH audit_logs (semua tenant) satu perintah,
--    melewati baik RLS maupun REVOKE INSERT/UPDATE/DELETE di atas. Default
--    Supabase/Postgres tetap memberi TRUNCATE ke authenticated/anon kecuali
--    di-REVOKE eksplisit seperti ini.
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE ON TABLE public.audit_logs FROM authenticated, anon;
REVOKE TRUNCATE ON TABLE public.audit_logs FROM authenticated, anon;

-- Tidak ada policy UPDATE/DELETE ditambahkan -- audit_logs tetap append-only
-- murni lewat RPC SECURITY DEFINER / service_role existing. service_role
-- (dipakai getAdminClient() dan seluruh writer SECURITY DEFINER) TIDAK
-- tunduk pada RLS sama sekali -- REVOKE di atas dan policy SELECT di bagian 4
-- di bawah HANYA berlaku untuk role authenticated/anon, tidak memengaruhi
-- jalur tulis existing.

-- ---------------------------------------------------------------------------
-- 4. Owner-only SELECT (koreksi security review) -- ganti policy
--    "audit_logs_select" (20260626000004: owner/manager/super_admin) supaya
--    HANYA user AKTIF ber-role 'owner' pada tenant yang sama yang bisa
--    membaca audit_logs -- termasuk lewat Supabase client/REST langsung
--    (PostgREST tunduk penuh pada RLS untuk role authenticated/anon; tidak
--    ada bypass selain service_role, yang memang di luar cakupan RLS).
--
--    get_user_company_id() (20260626000004) TIDAK memeriksa is_active atau
--    role -- sengaja generik untuk seluruh tabel. Policy ini menambahkan
--    EXISTS check sendiri (bukan reuse user_has_role(), yang juga tidak
--    memeriksa is_active) supaya user 'owner' yang sudah dinonaktifkan tidak
--    bisa membaca audit_logs meski token/session lama masih valid -- sama
--    seperti getAuthUser() app-layer (lib/auth/get-user.ts) yang sign-out
--    paksa user is_active = FALSE, tapi ditegakkan juga di DB supaya tidak
--    bergantung HANYA pada app layer.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "audit_logs_select" ON public.audit_logs;

CREATE POLICY "audit_logs_select" ON public.audit_logs
  FOR SELECT
  USING (
    company_id = public.get_user_company_id()
    AND EXISTS (
      SELECT 1
      FROM public.users u
      JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
      JOIN public.roles r ON r.id = ur.role_id
      WHERE u.id = auth.uid()
        AND u.company_id = public.get_user_company_id()
        AND u.is_active = TRUE
        AND r.name = 'owner'
    )
  );
