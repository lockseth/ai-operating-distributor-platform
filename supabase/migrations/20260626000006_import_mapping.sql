-- =============================================================================
-- Migration: 006 — Import Mapping Tables
-- Mendukung LOCKED_REQUIREMENT #19 (Import Mapping)
-- Tenant dapat upload Excel/CSV dengan nama kolom sendiri dan memetakan ke field sistem.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- import_templates
-- Template mapping kolom Excel/CSV ke field sistem per tenant.
-- Sekali dibuat, bisa dipakai ulang untuk import berikutnya.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_templates (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  entity_type     VARCHAR(100) NOT NULL,   -- 'customer', 'product', 'order', dll
  description     TEXT,
  -- column_mappings: array mapping kolom file ke field sistem
  -- [{
  --   "source_column": "Nama Toko",
  --   "target_field": "name",
  --   "target_type": "core",          -- 'core' atau 'custom'
  --   "is_required": true,
  --   "default_value": null,
  --   "transform": null               -- null | "uppercase" | "phone_id" | "date_iso"
  -- }]
  column_mappings JSONB        NOT NULL DEFAULT '[]',
  -- Konfigurasi file
  file_has_header BOOLEAN      NOT NULL DEFAULT TRUE,
  delimiter       VARCHAR(10)  NOT NULL DEFAULT ',',   -- untuk CSV
  sheet_name      VARCHAR(100),                         -- untuk Excel (default: sheet pertama)
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by      UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_templates_company ON public.import_templates (company_id, entity_type);

CREATE TRIGGER trg_import_templates_updated_at
  BEFORE UPDATE ON public.import_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE  public.import_templates                   IS 'Template mapping kolom file ke field sistem per tenant';
COMMENT ON COLUMN public.import_templates.column_mappings   IS 'Array JSON: {source_column, target_field, target_type, is_required, default_value, transform}';

-- ---------------------------------------------------------------------------
-- import_jobs
-- Riwayat import yang pernah dilakukan beserta statusnya.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  template_id     UUID         REFERENCES public.import_templates (id) ON DELETE SET NULL,
  entity_type     VARCHAR(100) NOT NULL,
  file_name       VARCHAR(500) NOT NULL,
  file_url        TEXT,
  status          VARCHAR(50)  NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','validating','processing','completed','failed','rolled_back')),
  total_rows      INTEGER      NOT NULL DEFAULT 0,
  success_rows    INTEGER      NOT NULL DEFAULT 0,
  error_rows      INTEGER      NOT NULL DEFAULT 0,
  skipped_rows    INTEGER      NOT NULL DEFAULT 0,
  -- Ringkasan error per baris
  -- [{"row": 5, "column": "Nama Toko", "error": "Nilai wajib kosong"}]
  errors          JSONB        NOT NULL DEFAULT '[]',
  -- Snapshot mapping yang digunakan saat import (immutable setelah import)
  column_mappings JSONB        NOT NULL DEFAULT '[]',
  rollback_data   JSONB,                     -- Data untuk rollback jika diperlukan
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_jobs_company ON public.import_jobs (company_id, created_at DESC);
CREATE INDEX idx_import_jobs_status  ON public.import_jobs (company_id, status);

COMMENT ON TABLE  public.import_jobs              IS 'Riwayat import file per tenant';
COMMENT ON COLUMN public.import_jobs.errors       IS 'Array error per baris: {row, column, error}';
COMMENT ON COLUMN public.import_jobs.rollback_data IS 'Snapshot data sebelum import untuk keperluan rollback';

-- ---------------------------------------------------------------------------
-- RLS untuk tabel baru
-- ---------------------------------------------------------------------------

ALTER TABLE public.custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_field_values      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dynamic_forms            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dynamic_form_fields      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_jobs              ENABLE ROW LEVEL SECURITY;

-- custom_field_definitions
CREATE POLICY "cfd_select" ON public.custom_field_definitions
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "cfd_manage" ON public.custom_field_definitions
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('settings.manage')
  );

-- custom_field_values
CREATE POLICY "cfv_select" ON public.custom_field_values
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "cfv_insert" ON public.custom_field_values
  FOR INSERT WITH CHECK (company_id = public.get_user_company_id());

CREATE POLICY "cfv_update" ON public.custom_field_values
  FOR UPDATE USING (company_id = public.get_user_company_id());

CREATE POLICY "cfv_delete" ON public.custom_field_values
  FOR DELETE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','super_admin'])
  );

-- dynamic_forms
CREATE POLICY "df_select" ON public.dynamic_forms
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "df_manage" ON public.dynamic_forms
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('settings.manage')
  );

-- dynamic_form_fields
CREATE POLICY "dff_select" ON public.dynamic_form_fields
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.dynamic_forms df
      WHERE df.id = form_id
        AND df.company_id = public.get_user_company_id()
    )
  );

CREATE POLICY "dff_manage" ON public.dynamic_form_fields
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.dynamic_forms df
      WHERE df.id = form_id
        AND df.company_id = public.get_user_company_id()
        AND public.user_has_permission('settings.manage')
    )
  );

-- import_templates
CREATE POLICY "it_select" ON public.import_templates
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "it_manage" ON public.import_templates
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- import_jobs
CREATE POLICY "ij_select" ON public.import_jobs
  FOR SELECT USING (company_id = public.get_user_company_id());

CREATE POLICY "ij_insert" ON public.import_jobs
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "ij_update" ON public.import_jobs
  FOR UPDATE USING (company_id = public.get_user_company_id());
