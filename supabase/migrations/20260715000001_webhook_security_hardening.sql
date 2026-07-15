-- =============================================================================
-- Migration: Webhook Security Hardening
--
-- 1. n8n inbound webhook selama ini mengautentikasi SEMUA caller dengan satu
--    HMAC secret global (N8N_WEBHOOK_SECRET), lalu mempercayai company_id
--    dari payload JSON untuk menentukan tenant mana yang ditulis. Ini
--    memisahkan autentikasi dari otorisasi tenant — siapa pun yang tahu
--    secret global bisa menulis automation_logs ke company_id mana pun.
--    Perbaikan: kredensial sekarang per-tenant (hash tersimpan, revocable,
--    scoped ke event_type tertentu), company_id SELALU di-resolve dari
--    kredensial, bukan dari payload.
--
-- 2. Telegram unregistered handshake selama ini menyimpan raw_payload penuh
--    (termasuk isi pesan) ke telegram_update_events untuk chat yang belum
--    terdaftar. Perbaikan: hanya metadata minimum yang disimpan untuk baris
--    rejected_unregistered.
--
-- Non-destructive: hanya CREATE TABLE / ADD COLUMN / DROP NOT NULL. Tidak ada
-- DROP TABLE, DROP COLUMN, TRUNCATE, atau penghapusan data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- n8n_inbound_credentials
-- Kredensial per-tenant untuk autentikasi webhook inbound dari n8n.
-- Token mentah TIDAK PERNAH disimpan — hanya SHA-256 hash-nya (credential_hash).
-- Provisioning hanya lewat service role (lihat docs/architecture/
-- TELEGRAM_SALES_ORDER_ENTRY.md) — tidak ada jalur INSERT lewat RLS.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.n8n_inbound_credentials (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  credential_hash  TEXT         NOT NULL,
  label            VARCHAR(255) NOT NULL DEFAULT 'n8n integration',
  -- event_type yang diizinkan credential ini. KOSONG berarti TIDAK ADA event
  -- yang diizinkan (fail closed) — bukan "semua diizinkan". Admin wajib
  -- mengisi eksplisit sesuai kebutuhan integrasi.
  scope            TEXT[]       NOT NULL DEFAULT '{}',
  status           VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by       UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  rotated_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  UNIQUE (credential_hash)
);

CREATE INDEX idx_n8n_inbound_credentials_company ON public.n8n_inbound_credentials (company_id, status);

COMMENT ON TABLE public.n8n_inbound_credentials IS
  'Kredensial inbound n8n per tenant. credential_hash = SHA-256(raw token) — raw token tidak pernah disimpan plaintext di mana pun.';
COMMENT ON COLUMN public.n8n_inbound_credentials.scope IS
  'Daftar event_type yang boleh dikirim credential ini. Array kosong = tidak ada event yang diizinkan (fail closed).';
COMMENT ON COLUMN public.n8n_inbound_credentials.credential_hash IS
  'SHA-256 hex digest dari token mentah. Token mentah hanya diketahui admin yang men-generate-nya dan disimpan di credential store n8n — tidak pernah masuk ke database ini maupun log.';

ALTER TABLE public.n8n_inbound_credentials ENABLE ROW LEVEL SECURITY;

-- Hanya owner/admin/super_admin tenant yang boleh melihat kredensial tenant
-- sendiri (untuk keperluan audit/manajemen di masa depan). credential_hash
-- yang terlihat tetap tidak berguna bagi siapa pun tanpa token mentah asli.
-- TIDAK ada policy INSERT/UPDATE/DELETE — provisioning kredensial hanya lewat
-- service role, supaya generate token tetap satu jalur yang diaudit.
CREATE POLICY "nic_select" ON public.n8n_inbound_credentials
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','admin','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- n8n_inbound_events
-- Idempotency ledger untuk event masuk dari n8n. Mencegah automation_logs
-- terduplikasi jika n8n retry pengiriman event yang sama.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.n8n_inbound_events (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id  UUID         NOT NULL REFERENCES public.n8n_inbound_credentials (id) ON DELETE CASCADE,
  company_id     UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  event_id       TEXT         NOT NULL,  -- idempotency key yang dikirim n8n (mis. execution id)
  event_type     VARCHAR(100) NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Dedupe per kredensial: dua tenant berbeda kebetulan memakai event_id yang
  -- sama (mis. keduanya "1") tidak boleh saling menabrak.
  UNIQUE (credential_id, event_id)
);

CREATE INDEX idx_n8n_inbound_events_company ON public.n8n_inbound_events (company_id, created_at DESC);

COMMENT ON TABLE public.n8n_inbound_events IS
  'Idempotency ledger inbound n8n — satu baris per (credential_id, event_id). Event duplikat tidak diproses ulang / tidak membuat automation_logs ganda.';

ALTER TABLE public.n8n_inbound_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "nie_select" ON public.n8n_inbound_events
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- ---------------------------------------------------------------------------
-- Hardening: telegram_update_events — jangan simpan raw_payload penuh untuk
-- handshake dari chat yang belum terdaftar. Kolom baru menampung metadata
-- minimum; raw_payload menjadi nullable (kode aplikasi mengisi NULL untuk
-- baris processing_status = 'rejected_unregistered' sejak migrasi ini).
-- Baris LAMA yang sudah terlanjur menyimpan raw_payload penuh TIDAK diubah
-- retroaktif oleh migration ini (non-destructive) — lihat dokumentasi
-- retensi di TELEGRAM_SALES_ORDER_ENTRY.md untuk pembersihan manual.
-- ---------------------------------------------------------------------------

ALTER TABLE public.telegram_update_events ALTER COLUMN raw_payload DROP NOT NULL;

ALTER TABLE public.telegram_update_events
  ADD COLUMN IF NOT EXISTS telegram_chat_id   BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_user_id   BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_username  TEXT,
  ADD COLUMN IF NOT EXISTS rejection_reason   TEXT;

COMMENT ON COLUMN public.telegram_update_events.raw_payload IS
  'Payload update Telegram penuh. Untuk processing_status lain, tetap diisi (kebutuhan debug). Untuk rejected_unregistered, kolom ini SENGAJA NULL sejak migrasi ini — pakai telegram_chat_id/telegram_user_id/telegram_username sebagai gantinya.';
COMMENT ON COLUMN public.telegram_update_events.telegram_username IS
  'Label tampilan saja untuk membantu admin mengenali pengirim secara manual saat proses registrasi identitas — BUKAN identitas tepercaya, tidak pernah dipakai untuk resolve identity/otorisasi di kode aplikasi.';
COMMENT ON COLUMN public.telegram_update_events.rejection_reason IS
  'Alasan penolakan, mis. unregistered_chat. Hanya diisi untuk baris yang tidak diproses.';
