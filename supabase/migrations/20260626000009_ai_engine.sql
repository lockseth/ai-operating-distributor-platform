-- =============================================================================
-- Migration: 009 — AI Engine
-- Mendukung LOCKED_REQUIREMENT #24 (AI Features: 5 fitur AI)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ai_insights
-- Cache hasil komputasi AI per fitur per entitas.
-- Mencegah re-komputasi pada setiap page load.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_insights (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  -- Tipe fitur AI yang menghasilkan insight ini
  feature_type  VARCHAR(100) NOT NULL
    CHECK (feature_type IN (
      'churn_prediction',           -- Prediksi churn per customer
      'repeat_order_prediction',    -- Prediksi tanggal order berikutnya per customer
      'revenue_forecast',           -- Proyeksi revenue bulan depan (company-level)
      'sales_recommendation',       -- Rekomendasi tugas harian per sales rep
      'executive_summary'           -- Ringkasan eksekutif untuk owner
    )),
  entity_type   VARCHAR(50),   -- 'customer', 'sales', 'company', NULL jika global
  entity_id     UUID,          -- UUID entity terkait, NULL jika company-level
  result        JSONB         NOT NULL,   -- Hasil insight dalam format terstruktur
  confidence    NUMERIC(5,4)  CHECK (confidence BETWEEN 0 AND 1),
  -- Versi model yang menghasilkan insight:
  -- 'rule-based-v1': rule-based analytics (no LLM)
  -- 'rule-based+gpt4': rule-based + GPT-4 enhancement
  -- 'rule-based+claude3': rule-based + Claude enhancement
  model_version VARCHAR(100)  NOT NULL DEFAULT 'rule-based-v1',
  expires_at    TIMESTAMPTZ   NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Unique index: satu insight per fitur per entitas per perusahaan
CREATE UNIQUE INDEX idx_ai_insights_entity ON public.ai_insights
  (company_id, feature_type, entity_type, entity_id)
  WHERE entity_id IS NOT NULL;

-- Index untuk query insights company-level
CREATE UNIQUE INDEX idx_ai_insights_company_level ON public.ai_insights
  (company_id, feature_type)
  WHERE entity_id IS NULL;

CREATE INDEX idx_ai_insights_lookup ON public.ai_insights
  (company_id, feature_type, expires_at);

COMMENT ON TABLE  public.ai_insights               IS 'Cache hasil komputasi AI per fitur, di-refresh berkala';
COMMENT ON COLUMN public.ai_insights.result         IS 'JSON terstruktur spesifik per feature_type';
COMMENT ON COLUMN public.ai_insights.model_version  IS 'rule-based-v1 | rule-based+gpt4 | rule-based+claude3';

-- ---------------------------------------------------------------------------
-- ai_feedback
-- Feedback pengguna terhadap hasil AI (untuk future model improvement).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ai_feedback (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  insight_id    UUID         REFERENCES public.ai_insights (id) ON DELETE SET NULL,
  feature_type  VARCHAR(100) NOT NULL,
  entity_id     UUID,
  rating        SMALLINT     NOT NULL CHECK (rating BETWEEN 1 AND 5),  -- 1=sangat tidak berguna, 5=sangat berguna
  feedback_text TEXT,
  submitted_by  UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_feedback_company ON public.ai_feedback (company_id, feature_type);

COMMENT ON TABLE public.ai_feedback IS 'Feedback pengguna untuk AI insight — digunakan untuk evaluasi model';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.ai_insights  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_feedback  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ais_select" ON public.ai_insights
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "ais_upsert" ON public.ai_insights
  FOR ALL USING (company_id = public.get_user_company_id());

CREATE POLICY "aif_select" ON public.ai_feedback
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "aif_insert" ON public.ai_feedback
  FOR INSERT WITH CHECK (company_id = public.get_user_company_id());
