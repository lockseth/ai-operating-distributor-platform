-- =============================================================================
-- Gate P4.20 -- Business Guard Alert State (celah #3 audit fraud protection,
-- 2026-08-23/24). Business Guard AI (6 fitur deteksi) sebelumnya 100%
-- pull-only, dan 2 fitur yang sudah sempat masuk brief WA harian (Gate P4.18
-- Unremitted Collection, Gate P4.19 Call Timing) tidak punya anti-spam --
-- entitas yang tetap HIGH berhari-hari akan muncul di WA setiap hari.
--
-- Tabel ini SATU-SATUNYA state persisten di Business Guard (5 fitur lain
-- SELECT+JS murni, tidak menulis apa pun) -- menyimpan level risiko terakhir
-- yang PERNAH dinotifikasi per entitas, supaya notifikasi cuma dikirim saat
-- level berubah sejak notifikasi terakhir (bukan tiap kali masih HIGH).
--
-- RPC vs plain UPSERT: SENGAJA plain UPSERT via admin client, TANPA RPC.
-- Beda dari automation_outbox (FOR UPDATE SKIP LOCKED + SECURITY DEFINER,
-- perlu karena banyak worker/credential bisa claim job sama secara konkuren
-- + validasi permission caller tidak dipercaya) -- tabel ini SATU-SATUNYA
-- penulis adalah 1 cron/hari (tidak ada konkurensi untuk diarbitrase) dan
-- SATU-SATUNYA pemanggil adalah route automation internal yang sudah pakai
-- getAdminClient() (service role, sudah lolos scope-check credential SEBELUM
-- kode Business Guard jalan) -- tidak ada pemanggil kedua kurang dipercaya
-- untuk dijaga RPC. Logic transisi HIGH/MEDIUM tetap di TypeScript
-- (CLAUDE.md #2, testable) -- RPC di sini cuma jadi pass-through tanpa
-- manfaat nyata. RLS+REVOKE di bawah tetap defense-in-depth (sesi dashboard
-- manusia tidak akan pernah bisa menulis meski dicoba), bukan mekanisme
-- penegakan utama.
--
-- Tidak menulis ke audit_logs -- state ini murni housekeeping turunan
-- (bukan aksi user, bukan bagian financial contract), beda kelas dari
-- transisi job/promise-to-pay yang memang perlu jejak audit.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.business_guard_alert_state (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  alert_type                VARCHAR(30)  NOT NULL CHECK (alert_type IN (
                                'discount_anomaly', 'collection_risk', 'behavior_change',
                                'transaction_risk', 'unremitted_collection', 'call_timing_anomaly'
                              )),
  entity_key                TEXT         NOT NULL CHECK (length(entity_key) > 0),
  last_risk_level           VARCHAR(10)  NOT NULL CHECK (last_risk_level IN ('HIGH','MEDIUM','LOW','NONE')),
  last_notified_risk_level  VARCHAR(10)  CHECK (last_notified_risk_level IS NULL OR last_notified_risk_level IN ('HIGH','MEDIUM','LOW','NONE')),
  last_notified_at          TIMESTAMPTZ,
  first_seen_high_at        TIMESTAMPTZ,
  last_evaluated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, alert_type, entity_key)
);

CREATE INDEX idx_business_guard_alert_state_lookup
  ON public.business_guard_alert_state (company_id, alert_type);

CREATE TRIGGER trg_business_guard_alert_state_updated_at
  BEFORE UPDATE ON public.business_guard_alert_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.business_guard_alert_state IS
  'Gate P4.20 -- level risiko terakhir yang PERNAH dinotifikasi per entitas Business Guard, supaya push WA tidak berulang tiap hari selama entitas masih di level yang sama. Ditulis HANYA oleh route automation internal (admin client), tidak pernah oleh sesi dashboard.';

ALTER TABLE public.business_guard_alert_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_guard_alert_state_select" ON public.business_guard_alert_state
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

REVOKE ALL ON TABLE public.business_guard_alert_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.business_guard_alert_state TO authenticated;
