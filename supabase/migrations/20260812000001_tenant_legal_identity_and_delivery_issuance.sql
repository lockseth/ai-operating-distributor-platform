-- =============================================================================
-- Migration: Tenant Legal Identity + Document Numbering Allocator + Delivery
-- Note (Surat Jalan) Issuance.
--
-- LOCKED DECISION (2026-07-22, lanjutan Repository & Persistence Closure
-- Gate) -- Target 2 (Delivery Number/Date) + Target 3 (Tenant Legal
-- Identity), keduanya additive, tidak mengubah tabel/kolom yang sudah ada.
--
-- Target 3 -- companies: legal_address/contact_email/contact_phone (identitas
-- legal untuk header dokumen cetak) + document_number_prefix (kode tenant
-- terstruktur untuk format nomor dokumen, mis. "SWAS" -- BUKAN hardcoded di
-- kode aplikasi/renderer, lihat allocate_document_number di bawah). Ketiganya
-- NULL-able untuk baris historis; Document Engine WAJIB menolak issuance
-- eksplisit (COMPANY_PROFILE_INCOMPLETE) bila field wajib belum lengkap --
-- lihat validate_company_profile_complete().
--
-- Target 2 -- deliveries.delivery_number/delivery_date: dialokasikan SAAT
-- dokumen Surat Jalan diterbitkan (issue_delivery_note()), yaitu setelah
-- delivery dibuat (status='planned') dan SEBELUM dispatch. delivery_date
-- memakai tanggal bisnis Asia/Jakarta pada saat issuance (bukan created_at).
-- Immutable setelah issued (trigger). Delivery historis boleh NULL --
-- Document Engine (repository-adapter.ts) sudah menolak eksplisit bila NULL
-- lewat DELIVERY_SOURCE_INCOMPLETE, TIDAK fallback ke created_at/tanggal lain.
--
-- Allocator (dipakai bersama Target 4, lihat migration berikutnya
-- 20260812000002) -- document_number_counters + allocate_document_number():
-- atomic lewat SATU statement INSERT ... ON CONFLICT DO UPDATE ... RETURNING
-- (row-level lock built-in Postgres pada upsert), BUKAN dihitung dengan
-- MAX+1/read-then-write terpisah yang rentan race condition. Counter terpisah
-- per (company_id, document_type, business_date).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Target 3: Tenant Legal Identity (additive, companies).
-- ---------------------------------------------------------------------------

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS legal_address          TEXT,
  ADD COLUMN IF NOT EXISTS contact_email           TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone           TEXT,
  ADD COLUMN IF NOT EXISTS document_number_prefix  VARCHAR(10);

COMMENT ON COLUMN public.companies.legal_address IS
  'Alamat legal tenant untuk header dokumen cetak (PO/Faktur/Surat Jalan). NULL untuk tenant historis -- Document Engine wajib menolak issuance dengan COMPANY_PROFILE_INCOMPLETE bila kosong, bukan mengosongkan baris di dokumen.';
COMMENT ON COLUMN public.companies.contact_email IS
  'Email kontak legal tenant untuk header dokumen cetak. NULL untuk tenant historis -- lihat validate_company_profile_complete().';
COMMENT ON COLUMN public.companies.contact_phone IS
  'Telepon kontak legal tenant untuk header dokumen cetak. NULL untuk tenant historis -- lihat validate_company_profile_complete().';
COMMENT ON COLUMN public.companies.document_number_prefix IS
  'Kode tenant terstruktur untuk format nomor dokumen (mis. "SWAS" -> SWAS-SJ-YYYYMMDD-000001). Berasal dari konfigurasi/kontrak tenant -- TIDAK PERNAH hardcoded di renderer/allocator. Wajib diisi sebelum tenant dapat menerbitkan dokumen apa pun (lihat allocate_document_number, validate_company_profile_complete).';

-- ---------------------------------------------------------------------------
-- Allocator -- counter transactional per (company_id, document_type,
-- business_date). Concurrency-safe: satu statement UPSERT, tidak ada
-- read-modify-write terpisah di sisi caller.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.document_number_counters (
  company_id     UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  document_type  VARCHAR(30)  NOT NULL CHECK (document_type IN ('PURCHASE_ORDER', 'DELIVERY_NOTE', 'INVOICE')),
  business_date  DATE         NOT NULL,
  last_sequence  INTEGER      NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, document_type, business_date)
);

COMMENT ON TABLE public.document_number_counters IS
  'Counter atomic per tenant/jenis dokumen/tanggal bisnis. SATU-SATUNYA sumber sequence nomor dokumen -- ditulis HANYA lewat allocate_document_number() (INSERT ... ON CONFLICT DO UPDATE ... RETURNING dalam satu statement, row-level lock built-in). Tidak ada MAX+1 di tempat lain.';

CREATE TRIGGER trg_document_number_counters_updated_at
  BEFORE UPDATE ON public.document_number_counters
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS: internal counter, tidak ada kebutuhan dashboard. RLS aktif TANPA
-- policy apa pun untuk anon/authenticated (pola sama dengan
-- delivery_conversation_state) -- default privilege GRANT ALL ON TABLES ke
-- anon/authenticated (20260707000003) tetap diblokir RLS ini; hanya
-- service_role (bypass RLS) yang menulis/membaca lewat allocate_document_number().
ALTER TABLE public.document_number_counters ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.allocate_document_number(
  p_company_id     UUID,
  p_document_type  VARCHAR(30),
  p_business_date  DATE
) RETURNS TEXT AS $$
DECLARE
  v_prefix     VARCHAR(10);
  v_type_code  TEXT;
  v_seq        INTEGER;
BEGIN
  SELECT document_number_prefix INTO v_prefix
  FROM public.companies
  WHERE id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPANY_NOT_FOUND: %', p_company_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_prefix IS NULL OR length(btrim(v_prefix)) = 0 THEN
    RAISE EXCEPTION 'COMPANY_PROFILE_INCOMPLETE'
      USING ERRCODE = 'check_violation',
            DETAIL = jsonb_build_object('companyId', p_company_id, 'missingFields', ARRAY['document_number_prefix'])::text;
  END IF;

  v_type_code := CASE p_document_type
    WHEN 'PURCHASE_ORDER' THEN 'PO'
    WHEN 'DELIVERY_NOTE'  THEN 'SJ'
    WHEN 'INVOICE'        THEN 'INV'
    ELSE NULL
  END;
  IF v_type_code IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_DOCUMENT_TYPE: %', p_document_type USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Atomic upsert -- Postgres mengunci baris counter selama statement ini,
  -- caller konkuren untuk (company_id, document_type, business_date) yang
  -- sama akan diserialisasi di sini, bukan membaca nilai basi.
  INSERT INTO public.document_number_counters AS c (company_id, document_type, business_date, last_sequence)
  VALUES (p_company_id, p_document_type, p_business_date, 1)
  ON CONFLICT (company_id, document_type, business_date)
  DO UPDATE SET last_sequence = c.last_sequence + 1, updated_at = NOW()
  RETURNING last_sequence INTO v_seq;

  RETURN v_prefix || '-' || v_type_code || '-' || to_char(p_business_date, 'YYYYMMDD') || '-' || lpad(v_seq::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.allocate_document_number IS
  'Alokasi nomor dokumen atomic/concurrency-safe: SWAS-PO|SJ|INV-YYYYMMDD-000001. Menolak (RAISE EXCEPTION COMPANY_PROFILE_INCOMPLETE) bila companies.document_number_prefix belum diatur. Dipanggil hanya lewat service_role (lihat event trigger trg_harden_new_public_routines, 20260720000001) -- tidak ada GRANT eksplisit ke anon/authenticated di sini.';

-- ---------------------------------------------------------------------------
-- Helper -- validasi kelengkapan profil legal tenant sebelum issuance dokumen
-- apa pun (Target 3). Dipakai issue_delivery_note() di bawah dan akan dipakai
-- ulang oleh jalur issuance PO/Invoice (aplikasi, lib/document-engine).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_company_profile_complete(p_company_id UUID)
RETURNS VOID AS $$
DECLARE
  v_row      public.companies%ROWTYPE;
  v_missing  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT * INTO v_row FROM public.companies WHERE id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPANY_NOT_FOUND: %', p_company_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.legal_address IS NULL OR length(btrim(v_row.legal_address)) = 0 THEN
    v_missing := array_append(v_missing, 'legal_address');
  END IF;
  IF v_row.contact_email IS NULL OR length(btrim(v_row.contact_email)) = 0 THEN
    v_missing := array_append(v_missing, 'contact_email');
  END IF;
  IF v_row.contact_phone IS NULL OR length(btrim(v_row.contact_phone)) = 0 THEN
    v_missing := array_append(v_missing, 'contact_phone');
  END IF;
  IF v_row.document_number_prefix IS NULL OR length(btrim(v_row.document_number_prefix)) = 0 THEN
    v_missing := array_append(v_missing, 'document_number_prefix');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'COMPANY_PROFILE_INCOMPLETE'
      USING ERRCODE = 'check_violation',
            DETAIL = jsonb_build_object('companyId', p_company_id, 'missingFields', v_missing)::text;
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_company_profile_complete IS
  'Menolak (RAISE EXCEPTION COMPANY_PROFILE_INCOMPLETE, DETAIL berisi JSON {companyId, missingFields}) bila legal_address/contact_email/contact_phone/document_number_prefix belum lengkap. companies.name TETAP nama legal canonical (NOT NULL sejak awal) -- tidak diperiksa ulang di sini. Dipanggil sebelum issuance dokumen apa pun.';

-- ---------------------------------------------------------------------------
-- Target 2: deliveries.delivery_number / delivery_date (additive, immutable
-- setelah issued).
-- ---------------------------------------------------------------------------

ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS delivery_number  TEXT,
  ADD COLUMN IF NOT EXISTS delivery_date    DATE;

COMMENT ON COLUMN public.deliveries.delivery_number IS
  'Nomor Surat Jalan (format SWAS-SJ-YYYYMMDD-000001), dialokasikan SAAT issuance lewat issue_delivery_note() -- setelah delivery dibuat (status=planned), sebelum dispatch. NULL untuk delivery historis/belum diterbitkan. Immutable setelah terisi (lihat trg_deliveries_number_immutable). Document Engine WAJIB menolak eksplisit bila NULL, TIDAK fallback ke nilai lain.';
COMMENT ON COLUMN public.deliveries.delivery_date IS
  'Tanggal bisnis Asia/Jakarta saat Surat Jalan diterbitkan (issue_delivery_note()) -- BUKAN created_at/current date saat dibaca. NULL untuk delivery historis/belum diterbitkan. Immutable setelah terisi.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_deliveries_company_delivery_number
  ON public.deliveries (company_id, delivery_number)
  WHERE delivery_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_delivery_number_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.delivery_number IS NOT NULL AND NEW.delivery_number IS DISTINCT FROM OLD.delivery_number THEN
    RAISE EXCEPTION 'DELIVERY_NUMBER_IMMUTABLE: delivery % sudah memiliki delivery_number, tidak dapat diubah', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.delivery_date IS NOT NULL AND NEW.delivery_date IS DISTINCT FROM OLD.delivery_date THEN
    RAISE EXCEPTION 'DELIVERY_DATE_IMMUTABLE: delivery % sudah memiliki delivery_date, tidak dapat diubah', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.prevent_delivery_number_mutation IS
  'Trigger guard: setelah deliveries.delivery_number/delivery_date terisi (issued), keduanya immutable -- UPDATE apa pun (termasuk lewat jalur lain di luar issue_delivery_note()) yang mencoba mengubah nilai non-NULL ini ditolak.';

DROP TRIGGER IF EXISTS trg_deliveries_number_immutable ON public.deliveries;
CREATE TRIGGER trg_deliveries_number_immutable
  BEFORE UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.prevent_delivery_number_mutation();

-- ---------------------------------------------------------------------------
-- issue_delivery_note() -- Target 2 orchestration: alokasi + tulis
-- delivery_number/delivery_date dalam satu transaksi atomic.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.issue_delivery_note(p_delivery_id UUID)
RETURNS TABLE(delivery_number TEXT, delivery_date DATE) AS $$
DECLARE
  v_company_id       UUID;
  v_status           VARCHAR(30);
  v_existing_number  TEXT;
  v_business_date    DATE;
  v_number           TEXT;
BEGIN
  SELECT d.company_id, d.status, d.delivery_number
  INTO v_company_id, v_status, v_existing_number
  FROM public.deliveries d
  WHERE d.id = p_delivery_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND: %', p_delivery_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_existing_number IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_NUMBER_ALREADY_ISSUED: delivery % sudah memiliki delivery_number %', p_delivery_id, v_existing_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_status <> 'planned' THEN
    RAISE EXCEPTION 'DELIVERY_NOT_ISSUABLE: delivery % berstatus % (Surat Jalan hanya dapat diterbitkan sebelum dispatch, status=planned)', p_delivery_id, v_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  PERFORM public.validate_company_profile_complete(v_company_id);

  v_business_date := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
  v_number := public.allocate_document_number(v_company_id, 'DELIVERY_NOTE', v_business_date);

  UPDATE public.deliveries d
  SET delivery_number = v_number, delivery_date = v_business_date
  WHERE d.id = p_delivery_id;

  RETURN QUERY SELECT v_number, v_business_date;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.issue_delivery_note IS
  'Menerbitkan Surat Jalan: mengunci baris delivery (FOR UPDATE), menolak bila sudah pernah diterbitkan (DELIVERY_NUMBER_ALREADY_ISSUED) atau status bukan planned (DELIVERY_NOT_ISSUABLE, harus sebelum dispatch), menolak bila profil tenant belum lengkap (COMPANY_PROFILE_INCOMPLETE lewat validate_company_profile_complete), lalu mengalokasikan delivery_number (format SWAS-SJ-YYYYMMDD-000001) dan delivery_date (tanggal bisnis Asia/Jakarta saat issuance) secara atomic lewat allocate_document_number. Immutable setelahnya (trg_deliveries_number_immutable). Dipanggil hanya lewat service_role.';
