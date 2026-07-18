-- =============================================================================
-- Saved Import Mapping Profiles (addendum "SAVED IMPORT PROFILE").
--
-- Tujuan: tenant tidak perlu memetakan ulang kolom setiap kali mengimpor dari
-- sumber yang sama (mis. "Export Customer Accurate v1", "Excel Toko Pak
-- Waluyo v1"). Profil di-key oleh (company_id, import_type, source_system,
-- profile_name) -- tenant lain TIDAK PERNAH melihat profil tenant ini (RLS +
-- filter company_id di setiap query, sama seperti import_batches).
--
-- Versioned: menyimpan ulang nama profil yang sama menaikkan `version` (lihat
-- ON CONFLICT di bawah) supaya mapping lama tetap bisa dirujuk/diaudit tanpa
-- mengubah struktur tabel/core.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.import_mapping_profiles (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  import_type       VARCHAR(30)   NOT NULL CHECK (import_type IN (
                      'CUSTOMER_PIC', 'PRODUCT_PRICE', 'OPEN_AR', 'OPEN_ORDER', 'HISTORICAL_ORDER'
                    )),
  source_system     VARCHAR(100)  NOT NULL,
  profile_name      VARCHAR(200)  NOT NULL,
  column_mappings   JSONB         NOT NULL,
  template_version  VARCHAR(20)   NOT NULL DEFAULT '1.0.0',
  version           INTEGER       NOT NULL DEFAULT 1,
  created_by        UUID          NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, import_type, source_system, profile_name)
);

CREATE INDEX idx_import_mapping_profiles_company
  ON public.import_mapping_profiles (company_id, import_type);

CREATE TRIGGER trg_import_mapping_profiles_updated_at
  BEFORE UPDATE ON public.import_mapping_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.import_mapping_profiles IS
  'Mapping kolom tersimpan per tenant+domain+sumber, supaya import berulang dari sumber yang sama tidak perlu mapping ulang. version naik setiap kali profil dengan nama sama disimpan ulang (lihat repository saveMappingProfile).';
COMMENT ON COLUMN public.import_mapping_profiles.source_system IS
  'Label sumber data (mis. "Accurate", "Excel Toko Pak Waluyo") -- bukan enum tetap, tenant bebas menamai.';

ALTER TABLE public.import_mapping_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "import_mapping_profiles_select" ON public.import_mapping_profiles
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- INSERT/UPDATE hanya lewat server action + admin client (service_role) --
-- pola yang sama dengan import_batches (lihat migration foundation).
