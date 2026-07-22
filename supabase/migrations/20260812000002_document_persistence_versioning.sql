-- =============================================================================
-- Migration: Document Persistence & Versioning (Target 4, LOCKED 2026-07-22).
--
-- issued_documents -- snapshot immutable per versi untuk PURCHASE_ORDER,
-- DELIVERY_NOTE, INVOICE. Revisi SELALU menghasilkan row/version baru;
-- snapshot lama TIDAK PERNAH di-UPDATE (application layer -- lib/document-
-- engine -- juga tidak boleh mem-mutasi snapshot lama; tabel ini tidak
-- mengizinkan UPDATE snapshot lewat trigger di bawah sebagai penegakan kedua).
--
-- Uniqueness mengakomodasi versi: UNIQUE(company_id, document_type,
-- document_number, version). "Tidak ada dua active/current version untuk
-- source yang sama" ditegakkan lewat partial unique index pada source_key
-- (COALESCE(source_delivery_id, source_order_id)) WHERE status='active'.
--
-- Foreign key source (source_order_id/source_delivery_id) divalidasi SATU
-- TENANT lewat trigger validate_issued_document_tenant() -- bukan hanya FK
-- referential integrity (yang tidak bisa menegakkan company_id yang sama).
--
-- Nomor dialokasikan HANYA lewat allocate_document_number() (migration
-- sebelumnya, 20260812000001) -- record_issued_document() di bawah menerima
-- document_number sebagai parameter yang SUDAH dialokasikan oleh caller
-- (lib/document-engine, application layer) supaya urutan "alokasi nomor lalu
-- build snapshot lalu persist" tetap eksplisit dan dapat diuji terpisah.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.issued_documents (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  document_type            VARCHAR(30)  NOT NULL CHECK (document_type IN ('PURCHASE_ORDER', 'DELIVERY_NOTE', 'INVOICE')),
  source_order_id          UUID         REFERENCES public.sales_orders (id) ON DELETE RESTRICT,
  source_delivery_id       UUID         REFERENCES public.deliveries (id) ON DELETE RESTRICT,
  source_key               UUID         GENERATED ALWAYS AS (COALESCE(source_delivery_id, source_order_id)) STORED,
  document_number          TEXT         NOT NULL,
  version                  INTEGER      NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot                 JSONB        NOT NULL,
  status                   VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  issued_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  issued_by                UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  supersedes_document_id   UUID         REFERENCES public.issued_documents (id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_issued_documents_source CHECK (
    (document_type = 'PURCHASE_ORDER' AND source_order_id IS NOT NULL AND source_delivery_id IS NULL)
    OR (document_type = 'DELIVERY_NOTE' AND source_delivery_id IS NOT NULL AND source_order_id IS NULL)
    OR (document_type = 'INVOICE' AND source_order_id IS NOT NULL AND source_delivery_id IS NOT NULL)
  ),
  UNIQUE (company_id, document_type, document_number, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_issued_documents_active_source
  ON public.issued_documents (company_id, document_type, source_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_issued_documents_company_type ON public.issued_documents (company_id, document_type, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_issued_documents_source_order ON public.issued_documents (source_order_id) WHERE source_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issued_documents_source_delivery ON public.issued_documents (source_delivery_id) WHERE source_delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_issued_documents_supersedes ON public.issued_documents (supersedes_document_id) WHERE supersedes_document_id IS NOT NULL;

COMMENT ON TABLE public.issued_documents IS
  'Snapshot dokumen resmi yang diterbitkan (PO/Surat Jalan/Invoice) -- immutable per versi. Revisi = row baru (version+1, supersedes_document_id -> dokumen lama), snapshot lama TIDAK PERNAH ditulis ulang (lihat trg_issued_documents_immutable). Hanya boleh ditulis lewat record_issued_document().';
COMMENT ON COLUMN public.issued_documents.source_key IS
  'COALESCE(source_delivery_id, source_order_id) -- kunci identitas "transaksi sumber" dokumen ini, dipakai partial unique index uq_issued_documents_active_source untuk menegakkan maksimal SATU versi aktif per source per document_type.';
COMMENT ON COLUMN public.issued_documents.snapshot IS
  'DocumentSnapshot immutable (lib/document-engine/types.ts) -- hasil build server-side (monetary.ts) pada saat issuance. TIDAK PERNAH dihitung ulang saat dibaca.';
COMMENT ON COLUMN public.issued_documents.status IS
  'active = versi berlaku saat ini (maksimal satu per source, lihat uq_issued_documents_active_source). superseded = digantikan versi lebih baru, tetap tersimpan untuk audit trail, tidak pernah dihapus.';

-- ---------------------------------------------------------------------------
-- Immutability -- snapshot/document_number/version/company_id/document_type/
-- source_* tidak boleh diubah setelah insert. Satu-satunya UPDATE yang
-- diizinkan: status active -> superseded (dilakukan record_issued_document()
-- saat menerbitkan revisi baru).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_issued_document_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
    OR NEW.document_number IS DISTINCT FROM OLD.document_number
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.source_order_id IS DISTINCT FROM OLD.source_order_id
    OR NEW.source_delivery_id IS DISTINCT FROM OLD.source_delivery_id
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
  THEN
    RAISE EXCEPTION 'ISSUED_DOCUMENT_IMMUTABLE: dokumen % (versi %) tidak dapat diubah -- revisi wajib membuat row baru', OLD.id, OLD.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'ISSUED_DOCUMENT_IMMUTABLE: dokumen % sudah superseded, tidak dapat diaktifkan kembali', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_issued_documents_immutable ON public.issued_documents;
CREATE TRIGGER trg_issued_documents_immutable
  BEFORE UPDATE ON public.issued_documents
  FOR EACH ROW EXECUTE FUNCTION public.prevent_issued_document_mutation();

-- ---------------------------------------------------------------------------
-- Tenant validation -- FK referential integrity saja tidak menegakkan
-- company_id yang sama; trigger ini WAJIB untuk setiap INSERT.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_issued_document_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_order_company_id     UUID;
  v_delivery_company_id  UUID;
  v_delivery_order_id    UUID;
BEGIN
  IF NEW.source_order_id IS NOT NULL THEN
    SELECT so.company_id INTO v_order_company_id
    FROM public.sales_orders so WHERE so.id = NEW.source_order_id;
    IF v_order_company_id IS NULL THEN
      RAISE EXCEPTION 'SOURCE_ORDER_NOT_FOUND: %', NEW.source_order_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_order_company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: source order % bukan milik company %', NEW.source_order_id, NEW.company_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  IF NEW.source_delivery_id IS NOT NULL THEN
    SELECT d.company_id, d.sales_order_id INTO v_delivery_company_id, v_delivery_order_id
    FROM public.deliveries d WHERE d.id = NEW.source_delivery_id;
    IF v_delivery_company_id IS NULL THEN
      RAISE EXCEPTION 'SOURCE_DELIVERY_NOT_FOUND: %', NEW.source_delivery_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_delivery_company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: source delivery % bukan milik company %', NEW.source_delivery_id, NEW.company_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.document_type = 'INVOICE' AND v_delivery_order_id IS DISTINCT FROM NEW.source_order_id THEN
      RAISE EXCEPTION 'DELIVERY_ORDER_MISMATCH: delivery % milik order %, bukan order %', NEW.source_delivery_id, v_delivery_order_id, NEW.source_order_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_issued_document_tenant IS
  'BEFORE INSERT guard: source_order_id/source_delivery_id WAJIB milik company_id yang sama dengan dokumen (FK referential integrity saja tidak cukup, tidak menegakkan tenant). Untuk INVOICE, delivery.sales_order_id juga wajib sama dengan source_order_id (rantai Order<->Delivery yang sama, sesuai AODP_DOCUMENT_CONSTITUTION).';

DROP TRIGGER IF EXISTS trg_issued_documents_tenant ON public.issued_documents;
CREATE TRIGGER trg_issued_documents_tenant
  BEFORE INSERT ON public.issued_documents
  FOR EACH ROW EXECUTE FUNCTION public.validate_issued_document_tenant();

-- ---------------------------------------------------------------------------
-- record_issued_document() -- satu-satunya jalur penulisan issued_documents.
-- Menangani versioning (supersede) + menegakkan single-active-per-source
-- secara atomic. document_number HARUS sudah dialokasikan oleh caller lewat
-- allocate_document_number() sebelum memanggil fungsi ini.
--
-- Output kolom diberi prefix out_ dengan sengaja -- RETURNS TABLE(...)
-- membuat setiap nama kolom otomatis menjadi variabel PL/pgSQL dalam scope
-- fungsi; tanpa prefix, referensi bare "id"/"status" dkk pada statement SQL
-- di bawah (mis. WHERE id = ...) akan ambigu antara kolom tabel dan variabel
-- OUT ini.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_issued_document(
  p_company_id               UUID,
  p_document_type            VARCHAR(30),
  p_source_order_id          UUID,
  p_source_delivery_id       UUID,
  p_document_number          TEXT,
  p_snapshot                 JSONB,
  p_issued_by                UUID DEFAULT NULL,
  p_supersedes_document_id   UUID DEFAULT NULL
) RETURNS TABLE(
  out_id               UUID,
  out_document_number  TEXT,
  out_version          INTEGER,
  out_status           VARCHAR(20),
  out_issued_at        TIMESTAMPTZ
) AS $$
DECLARE
  v_source_key    UUID := COALESCE(p_source_delivery_id, p_source_order_id);
  v_old           public.issued_documents%ROWTYPE;
  v_new_version   INTEGER;
  v_new_id        UUID;
  v_issued_at     TIMESTAMPTZ;
BEGIN
  IF v_source_key IS NULL THEN
    RAISE EXCEPTION 'SOURCE_REQUIRED: dokumen % wajib memiliki source_order_id atau source_delivery_id', p_document_type
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_supersedes_document_id IS NOT NULL THEN
    SELECT iod.* INTO v_old FROM public.issued_documents iod
    WHERE iod.id = p_supersedes_document_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'SUPERSEDES_DOCUMENT_NOT_FOUND: %', p_supersedes_document_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_old.company_id <> p_company_id OR v_old.document_type <> p_document_type THEN
      RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: dokumen % bukan milik company/tipe yang sama', p_supersedes_document_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_old.status <> 'active' THEN
      RAISE EXCEPTION 'SUPERSEDES_DOCUMENT_NOT_ACTIVE: dokumen % berstatus %, bukan active', p_supersedes_document_id, v_old.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF v_old.source_key IS DISTINCT FROM v_source_key THEN
      RAISE EXCEPTION 'VERSION_SOURCE_MISMATCH: revisi wajib merujuk source yang sama dengan dokumen sebelumnya'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_new_version := v_old.version + 1;

    UPDATE public.issued_documents iod SET status = 'superseded' WHERE iod.id = p_supersedes_document_id;
  ELSE
    v_new_version := 1;
  END IF;

  BEGIN
    INSERT INTO public.issued_documents AS iod (
      company_id, document_type, source_order_id, source_delivery_id,
      document_number, version, snapshot, status, issued_at, issued_by, supersedes_document_id
    ) VALUES (
      p_company_id, p_document_type, p_source_order_id, p_source_delivery_id,
      p_document_number, v_new_version, p_snapshot, 'active', NOW(), p_issued_by, p_supersedes_document_id
    )
    RETURNING iod.id, iod.issued_at INTO v_new_id, v_issued_at;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE: sudah ada dokumen % aktif untuk source ini', p_document_type
      USING ERRCODE = 'unique_violation';
  END;

  RETURN QUERY SELECT v_new_id, p_document_number, v_new_version, 'active'::VARCHAR(20), v_issued_at;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.record_issued_document IS
  'Satu-satunya jalur penulisan issued_documents. Tanpa p_supersedes_document_id: version=1, ditolak (DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE) bila sudah ada versi aktif untuk source yang sama (partial unique index uq_issued_documents_active_source sebagai backstop concurrency). Dengan p_supersedes_document_id: mengunci dokumen lama (FOR UPDATE, menyerialisasi revisi konkuren), menolak bila bukan status active/source berbeda/tenant berbeda, lalu version=lama+1 dan menandai lama superseded -- dalam satu transaksi atomic. document_number WAJIB sudah dialokasikan lewat allocate_document_number() oleh caller. Dipanggil hanya lewat service_role.';

-- ---------------------------------------------------------------------------
-- RLS + permission 'document.view' untuk dashboard membaca dokumen terbitan
-- milik tenant sendiri. TIDAK ADA policy INSERT/UPDATE/DELETE untuk
-- authenticated -- hanya service_role (bypass RLS) yang menulis lewat
-- record_issued_document(), pola sama dengan delivery_events/owner_alerts.
-- ---------------------------------------------------------------------------

ALTER TABLE public.issued_documents ENABLE ROW LEVEL SECURITY;

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('document.view', 'document', 'view', 'View issued documents (PO/Surat Jalan/Invoice) milik company sendiri')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance', 'sales')
  AND p.name = 'document.view'
ON CONFLICT DO NOTHING;

CREATE POLICY "issued_documents_select" ON public.issued_documents
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('document.view')
  );
