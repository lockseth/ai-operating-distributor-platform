-- =============================================================================
-- Migration: 008 â€” Automation Engine
-- Mendukung LOCKED_REQUIREMENT #11 (Automation: WhatsApp, n8n, Reminder, Scheduled Task)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- automation_rules
-- Aturan otomatisasi berbasis event yang dapat dikonfigurasi per tenant.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.automation_rules (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  -- Tipe trigger yang mengaktifkan rule ini
  trigger_type    VARCHAR(100) NOT NULL
    CHECK (trigger_type IN (
      'customer_dormant',      -- Pelanggan tidak order > N hari
      'churn_risk',            -- Pelanggan berisiko churn
      'repeat_order_due',      -- Prediksi waktu order berikutnya
      'large_order',           -- Order melebihi threshold nilai
      'new_order',             -- Order baru masuk
      'low_stock',             -- Stok produk di bawah minimum
      'payment_overdue',       -- Invoice belum dibayar
      'new_customer',          -- Pelanggan baru didaftarkan
      'scheduled_daily',       -- Trigger harian (cron)
      'scheduled_weekly',      -- Trigger mingguan (cron)
      'manual'                 -- Dipicu manual
    )),
  -- Konfigurasi threshold untuk trigger
  -- Contoh customer_dormant: { "days": 30 }
  -- Contoh large_order: { "min_amount": 5000000 }
  trigger_config  JSONB        NOT NULL DEFAULT '{}',
  -- Kondisi tambahan (AND logic)
  -- [{ "field": "area", "operator": "in", "value": ["Jakarta Selatan"] }]
  conditions      JSONB        NOT NULL DEFAULT '[]',
  -- Daftar aksi yang dieksekusi berurutan
  -- [{ "type": "call_n8n", "webhook_id": "uuid" }, { "type": "log" }]
  actions         JSONB        NOT NULL DEFAULT '[]',
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  priority        INTEGER      NOT NULL DEFAULT 0,  -- Urutan eksekusi jika ada konflik
  run_count       INTEGER      NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  created_by      UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_automation_rules_company ON public.automation_rules (company_id, trigger_type, is_active);

CREATE TRIGGER trg_automation_rules_updated_at
  BEFORE UPDATE ON public.automation_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE  public.automation_rules               IS 'Aturan otomatisasi event-driven per tenant';
COMMENT ON COLUMN public.automation_rules.trigger_config IS 'Konfigurasi threshold trigger, misalnya { "days": 30 }';
COMMENT ON COLUMN public.automation_rules.actions        IS 'Array aksi: [{ "type": "call_n8n", "webhook_id": "..." }]';

-- ---------------------------------------------------------------------------
-- n8n_webhooks
-- Registrasi URL webhook n8n yang akan dipanggil oleh automation engine.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.n8n_webhooks (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  event_type     VARCHAR(100) NOT NULL,   -- Jenis event yang ditangani webhook ini
  webhook_url    TEXT         NOT NULL,   -- URL endpoint n8n
  secret_key     VARCHAR(255),            -- HMAC secret untuk verifikasi
  headers        JSONB        NOT NULL DEFAULT '{}',  -- Custom headers jika diperlukan
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  timeout_ms     INTEGER      NOT NULL DEFAULT 5000,  -- Timeout pemanggilan (ms)
  retry_count    INTEGER      NOT NULL DEFAULT 2,
  last_called_at TIMESTAMPTZ,
  call_count     INTEGER      NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_n8n_webhooks_company ON public.n8n_webhooks (company_id, event_type, is_active);

CREATE TRIGGER trg_n8n_webhooks_updated_at
  BEFORE UPDATE ON public.n8n_webhooks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.n8n_webhooks IS 'Registrasi URL webhook n8n per tenant';

-- ---------------------------------------------------------------------------
-- automation_logs
-- Riwayat eksekusi automation rules (immutable).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.automation_logs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  rule_id       UUID         REFERENCES public.automation_rules (id) ON DELETE SET NULL,
  rule_name     VARCHAR(255),  -- Snapshot nama rule saat eksekusi
  trigger_type  VARCHAR(100) NOT NULL,
  trigger_data  JSONB,         -- Data yang memicu rule
  status        VARCHAR(50)  NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','success','failed','skipped')),
  actions_executed JSONB,      -- Hasil setiap aksi yang dieksekusi
  error_msg     TEXT,
  duration_ms   INTEGER,
  executed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_automation_logs_company ON public.automation_logs (company_id, executed_at DESC);
CREATE INDEX idx_automation_logs_rule    ON public.automation_logs (rule_id, executed_at DESC);

COMMENT ON TABLE public.automation_logs IS 'Riwayat eksekusi automation â€” immutable audit trail';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.n8n_webhooks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_logs  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ar_select" ON public.automation_rules
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "ar_manage" ON public.automation_rules
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "nw_select" ON public.n8n_webhooks
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "nw_manage" ON public.n8n_webhooks
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','admin','super_admin'])
  );

CREATE POLICY "al_select" ON public.automation_logs
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "al_insert" ON public.automation_logs
  FOR INSERT WITH CHECK (company_id = public.get_user_company_id());

