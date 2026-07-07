-- =============================================================================
-- Migration: 005 — Schema Flexible Tables
-- Mendukung LOCKED_REQUIREMENT #6 (Schema Flexible) dan #19 (Import Mapping)
-- Tenant dapat mendefinisikan field sendiri tanpa database migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- custom_field_definitions
-- Mendefinisikan field kustom per tenant, per entity type.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.custom_field_definitions (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  entity_type    VARCHAR(100) NOT NULL,   -- 'customer', 'product', 'order', dll
  field_key      VARCHAR(100) NOT NULL,   -- snake_case identifier
  field_label    VARCHAR(255) NOT NULL,   -- Label tampilan (bahasa tenant)
  field_type     VARCHAR(50)  NOT NULL    -- 'text','number','date','boolean','select','textarea'
                   CHECK (field_type IN ('text','number','date','boolean','select','textarea','url','phone','email')),
  field_options  JSONB,                   -- Untuk type 'select': [{"value":"a","label":"Opsi A"}]
  placeholder    VARCHAR(255),
  default_value  TEXT,
  is_required    BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order     INTEGER      NOT NULL DEFAULT 0,
  section        VARCHAR(100),            -- Pengelompokan field dalam form
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, entity_type, field_key)
);

CREATE INDEX idx_cfd_company_entity ON public.custom_field_definitions (company_id, entity_type);
CREATE INDEX idx_cfd_active ON public.custom_field_definitions (company_id, entity_type, is_active)
  WHERE is_active = TRUE;

CREATE TRIGGER trg_cfd_updated_at
  BEFORE UPDATE ON public.custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE  public.custom_field_definitions           IS 'Definisi field kustom per tenant per entity';
COMMENT ON COLUMN public.custom_field_definitions.field_key IS 'Key yang digunakan di JSONB custom_fields pada tabel entity';

-- ---------------------------------------------------------------------------
-- custom_field_values
-- Menyimpan nilai field kustom yang tidak muat di JSONB entity utama.
-- Digunakan untuk field dengan value besar atau yang memerlukan indexing tersendiri.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.custom_field_values (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  entity_type    VARCHAR(100) NOT NULL,
  entity_id      UUID         NOT NULL,
  field_key      VARCHAR(100) NOT NULL,
  value_text     TEXT,
  value_number   NUMERIC,
  value_boolean  BOOLEAN,
  value_date     DATE,
  value_json     JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, entity_type, entity_id, field_key)
);

CREATE INDEX idx_cfv_entity    ON public.custom_field_values (company_id, entity_type, entity_id);
CREATE INDEX idx_cfv_field_key ON public.custom_field_values (company_id, entity_type, field_key);

CREATE TRIGGER trg_cfv_updated_at
  BEFORE UPDATE ON public.custom_field_values
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.custom_field_values IS 'Nilai field kustom untuk pencarian dan indexing terpisah';

-- ---------------------------------------------------------------------------
-- dynamic_forms
-- Form yang dikonfigurasi per tenant untuk entity tertentu.
-- Satu entity bisa memiliki beberapa form (create form, detail form, import form).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dynamic_forms (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  form_type   VARCHAR(50)  NOT NULL DEFAULT 'create'
                CHECK (form_type IN ('create','edit','detail','import','filter')),
  description TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dynamic_forms_company ON public.dynamic_forms (company_id, entity_type, is_active);

CREATE TRIGGER trg_dynamic_forms_updated_at
  BEFORE UPDATE ON public.dynamic_forms
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- dynamic_form_fields
-- Konfigurasi field dalam sebuah dynamic form.
-- Menghubungkan form dengan field definition, dengan override per-form.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dynamic_form_fields (
  id                   UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id              UUID    NOT NULL REFERENCES public.dynamic_forms (id) ON DELETE CASCADE,
  field_definition_id  UUID    REFERENCES public.custom_field_definitions (id) ON DELETE CASCADE,
  -- Juga bisa merujuk ke core field (tanpa field_definition_id)
  core_field_key       VARCHAR(100),   -- Misal: 'name', 'phone', 'email'
  sort_order           INTEGER NOT NULL DEFAULT 0,
  is_visible           BOOLEAN NOT NULL DEFAULT TRUE,
  is_required_override BOOLEAN,        -- NULL = ikuti definition, TRUE/FALSE = override
  col_span             INTEGER NOT NULL DEFAULT 1 CHECK (col_span BETWEEN 1 AND 4),
  section              VARCHAR(100),
  CONSTRAINT chk_field_source CHECK (
    (field_definition_id IS NOT NULL AND core_field_key IS NULL)
    OR (field_definition_id IS NULL AND core_field_key IS NOT NULL)
  )
);

CREATE INDEX idx_dff_form_id ON public.dynamic_form_fields (form_id, sort_order);

COMMENT ON TABLE  public.dynamic_form_fields               IS 'Konfigurasi field dalam sebuah form (urutan, visibility, required override)';
COMMENT ON COLUMN public.dynamic_form_fields.core_field_key IS 'Nama kolom di tabel utama (name, phone, dll) jika bukan custom field';

-- ---------------------------------------------------------------------------
-- Seed: Custom field definitions untuk Viona (air minum distributor)
-- Dibuat setelah seed company — lihat migration 008
-- ---------------------------------------------------------------------------
