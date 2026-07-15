-- =============================================================================
-- Migration: Telegram Sales Order Entry MVP
--
-- Menambahkan:
--   1. Identity mapping Telegram -> users (tidak pernah percaya payload)
--   2. Idempotency ledger per Telegram update_id
--   3. Conversation state ringan (menunggu konfirmasi / menunggu koreksi)
--   4. Knowledge Pack minimal: alias produk/customer/satuan + discount policy
--      + knowledge_candidates (hasil koreksi sales, butuh approval — TIDAK
--      pernah auto-published)
--   5. Kolom tambahan di sales_orders / sales_order_items untuk discount
--      control, sumber channel, dan audit knowledge_version
--
-- Prinsip: sales_orders.status TETAP memakai nilai existing ('draft',
-- 'confirmed', dst — lihat migration 003). Tidak menambah nilai enum baru
-- ('awaiting_confirmation') supaya tidak mencampur state "channel intake"
-- dengan pipeline fulfillment yang sudah dipakai UI Sales Order existing.
-- Nuansa "menunggu balasan sales" disimpan di telegram_conversation_state,
-- bukan di sales_orders.status.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- telegram_identities
-- Mapping Telegram chat/user -> users internal. HANYA baris ini yang boleh
-- dipercaya untuk resolusi identitas — payload Telegram tidak pernah dipakai
-- langsung sebagai company_id/user_id/role.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.telegram_identities (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  user_id            UUID         NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  telegram_chat_id   BIGINT       NOT NULL,
  telegram_user_id   BIGINT,
  telegram_username  VARCHAR(255),
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by         UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_chat_id)
);

CREATE INDEX idx_telegram_identities_company ON public.telegram_identities (company_id);
CREATE INDEX idx_telegram_identities_user    ON public.telegram_identities (user_id);

CREATE TRIGGER trg_telegram_identities_updated_at
  BEFORE UPDATE ON public.telegram_identities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.telegram_identities IS
  'Satu-satunya sumber kebenaran pemetaan Telegram -> user internal. Payload Telegram tidak pernah dipercaya untuk identitas.';

-- ---------------------------------------------------------------------------
-- telegram_update_events
-- Idempotency ledger. telegram_update_id unik global (per bot instance,
-- bukan per company — sesuai semantik Telegram Bot API).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.telegram_update_events (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_update_id    BIGINT       NOT NULL,
  company_id            UUID         REFERENCES public.companies (id) ON DELETE CASCADE,
  telegram_identity_id  UUID         REFERENCES public.telegram_identities (id) ON DELETE SET NULL,
  message_type          VARCHAR(30)  NOT NULL DEFAULT 'text'
                           CHECK (message_type IN ('text','voice','other')),
  processing_status     VARCHAR(30)  NOT NULL DEFAULT 'received'
                           CHECK (processing_status IN (
                             'received',
                             'processed',
                             'rejected_unregistered',
                             'transcription_pending',
                             'not_order',
                             'error'
                           )),
  resulting_order_id    UUID         REFERENCES public.sales_orders (id) ON DELETE SET NULL,
  raw_payload           JSONB        NOT NULL,
  error_message         TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_update_id)
);

CREATE INDEX idx_telegram_events_company ON public.telegram_update_events (company_id, created_at DESC);

COMMENT ON TABLE public.telegram_update_events IS
  'Idempotency ledger — satu baris per Telegram update_id. update_id duplikat tidak boleh memproses ulang.';

-- ---------------------------------------------------------------------------
-- telegram_conversation_state
-- State ringan per identity: order mana yang sedang menunggu balasan
-- KONFIRMASI/UBAH, atau sedang menunggu teks koreksi setelah UBAH.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.telegram_conversation_state (
  telegram_identity_id  UUID         PRIMARY KEY REFERENCES public.telegram_identities (id) ON DELETE CASCADE,
  company_id            UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  pending_order_id       UUID         REFERENCES public.sales_orders (id) ON DELETE SET NULL,
  awaiting               VARCHAR(30)  NOT NULL DEFAULT 'none'
                           CHECK (awaiting IN ('none','confirmation','correction')),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_telegram_conv_state_updated_at
  BEFORE UPDATE ON public.telegram_conversation_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.telegram_conversation_state IS
  'State percakapan per identity — order mana yang sedang menunggu KONFIRMASI/UBAH dari sales.';

-- ---------------------------------------------------------------------------
-- Knowledge Pack — minimal, deterministic, per company.
-- Semua tabel di bawah adalah "Published Knowledge": hanya baris di sini
-- (bukan knowledge_candidates) yang dipakai saat ekstraksi order.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.knowledge_product_aliases (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  alias_text   VARCHAR(255) NOT NULL,   -- disimpan ternormalisasi lowercase, trimmed
  product_id   UUID         NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by   UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, alias_text)
);

CREATE INDEX idx_kpa_company_active ON public.knowledge_product_aliases (company_id, is_active);

CREATE TRIGGER trg_kpa_updated_at
  BEFORE UPDATE ON public.knowledge_product_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.knowledge_customer_aliases (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  alias_text   VARCHAR(255) NOT NULL,
  customer_id  UUID         NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by   UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, alias_text)
);

CREATE INDEX idx_kca_company_active ON public.knowledge_customer_aliases (company_id, is_active);

CREATE TRIGGER trg_kca_updated_at
  BEFORE UPDATE ON public.knowledge_customer_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.knowledge_unit_aliases (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  alias_text         VARCHAR(50)  NOT NULL,   -- mis. 'ds', 'dus', 'box'
  canonical_unit     VARCHAR(50)  NOT NULL,   -- mis. 'dus'
  conversion_factor  NUMERIC(12,4),           -- opsional, untuk konversi qty di masa depan
  is_active          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, alias_text)
);

CREATE TRIGGER trg_kua_updated_at
  BEFORE UPDATE ON public.knowledge_unit_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.knowledge_discount_policies (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  scope          VARCHAR(20)  NOT NULL DEFAULT 'global'
                   CHECK (scope IN ('global','product','customer')),
  product_id     UUID         REFERENCES public.products (id) ON DELETE CASCADE,
  customer_id    UUID         REFERENCES public.customers (id) ON DELETE CASCADE,
  max_percentage NUMERIC(5,2) CHECK (max_percentage IS NULL OR (max_percentage >= 0 AND max_percentage <= 100)),
  max_nominal    NUMERIC(15,2) CHECK (max_nominal IS NULL OR max_nominal >= 0),
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by     UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_discount_policy_scope CHECK (
    (scope = 'global'   AND product_id IS NULL AND customer_id IS NULL) OR
    (scope = 'product'  AND product_id IS NOT NULL AND customer_id IS NULL) OR
    (scope = 'customer' AND customer_id IS NOT NULL AND product_id IS NULL)
  )
);

CREATE INDEX idx_kdp_company_active ON public.knowledge_discount_policies (company_id, is_active);

CREATE TRIGGER trg_kdp_updated_at
  BEFORE UPDATE ON public.knowledge_discount_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.knowledge_discount_policies IS
  'Jika tidak ada baris aktif yang cocok untuk scope tertentu, extraction TIDAK BOLEH mengarang limit — order ditandai requires_discount_review.';

-- ---------------------------------------------------------------------------
-- knowledge_candidates
-- Koreksi sales (via UBAH) disimpan di sini, BUKAN langsung ke tabel alias
-- Published Knowledge. Butuh approval eksplisit (reviewed_by) sebelum
-- dipakai di ekstraksi berikutnya.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.knowledge_candidates (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  candidate_type   VARCHAR(30)  NOT NULL
                     CHECK (candidate_type IN ('product_alias','customer_alias','unit_alias','other')),
  raw_text         TEXT         NOT NULL,        -- teks asli dari sales, mis. "MW Putih 20 ds"
  suggested_value  JSONB        NOT NULL,         -- mis. {"product_id": "...", "canonical_name": "Cat Mawar Putih"}
  source_order_id  UUID         REFERENCES public.sales_orders (id) ON DELETE SET NULL,
  submitted_by     UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  status           VARCHAR(20)  NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected')),
  reviewed_by      UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_knowledge_candidates_company_status ON public.knowledge_candidates (company_id, status);

COMMENT ON TABLE public.knowledge_candidates IS
  'Kandidat pengetahuan dari koreksi sales (UBAH). TIDAK auto-published — menunggu review/approval manusia.';

-- ---------------------------------------------------------------------------
-- ALTER sales_order_items — discount control per item + fallback produk
-- belum matched ke master (pola sama seperti sales_report_items.product_name_snapshot)
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_order_items
  ALTER COLUMN product_id DROP NOT NULL;

ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS product_name_raw       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS unit                   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS discount_type          VARCHAR(20) CHECK (discount_type IS NULL OR discount_type IN ('percentage','nominal')),
  ADD COLUMN IF NOT EXISTS discount_value         NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS amount_before_discount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS discount_exception     BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.sales_order_items
  ADD CONSTRAINT chk_soi_product_reference CHECK (
    product_id IS NOT NULL OR product_name_raw IS NOT NULL
  );

COMMENT ON COLUMN public.sales_order_items.product_name_raw IS
  'Nama produk mentah hasil ekstraksi saat belum berhasil di-match ke products.id';
COMMENT ON COLUMN public.sales_order_items.amount_before_discount IS
  'quantity * unit_price sebelum diskon diterapkan; total_amount tetap menyimpan nilai setelah diskon';
COMMENT ON COLUMN public.sales_order_items.discount_exception IS
  'TRUE jika diskon item ini melebihi knowledge_discount_policies yang berlaku';

-- ---------------------------------------------------------------------------
-- ALTER sales_orders — sumber channel, audit knowledge, gate review diskon
-- ---------------------------------------------------------------------------

ALTER TABLE public.sales_orders
  ALTER COLUMN customer_id DROP NOT NULL;

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS customer_name_raw          VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_channel            VARCHAR(30) NOT NULL DEFAULT 'manual'
    CHECK (source_channel IN ('manual','telegram','whatsapp')),
  ADD COLUMN IF NOT EXISTS knowledge_version          VARCHAR(100),
  ADD COLUMN IF NOT EXISTS extraction_confidence      NUMERIC(4,3) CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  ADD COLUMN IF NOT EXISTS missing_fields             JSONB,
  ADD COLUMN IF NOT EXISTS requires_discount_review    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS delivery_note               TEXT,
  ADD COLUMN IF NOT EXISTS telegram_update_event_id    UUID REFERENCES public.telegram_update_events (id) ON DELETE SET NULL;

ALTER TABLE public.sales_orders
  ADD CONSTRAINT chk_so_customer_reference CHECK (
    customer_id IS NOT NULL OR customer_name_raw IS NOT NULL
  );

COMMENT ON COLUMN public.sales_orders.customer_name_raw IS
  'Nama toko mentah hasil ekstraksi saat belum berhasil di-match ke customers.id (mis. via Telegram intake)';
COMMENT ON COLUMN public.sales_orders.knowledge_version IS
  'Snapshot pengetahuan aktif saat ekstraksi (jumlah baris + max(updated_at) yang dipakai) — untuk audit, bukan FK ke tabel versioning terpisah';
COMMENT ON COLUMN public.sales_orders.requires_discount_review IS
  'TRUE jika ada item dengan diskon tanpa knowledge_discount_policies yang berlaku (limit tidak diketahui, bukan diasumsikan 0)';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.telegram_identities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_update_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_conversation_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_product_aliases    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_customer_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_unit_aliases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_discount_policies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_candidates         ENABLE ROW LEVEL SECURITY;

-- telegram_identities: hanya owner/manager/admin/super_admin yang boleh melihat & mengelola
CREATE POLICY "ti_select" ON public.telegram_identities
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "ti_manage" ON public.telegram_identities
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- telegram_update_events: read-only untuk manajemen; hanya service role yang insert (webhook)
CREATE POLICY "tue_select" ON public.telegram_update_events
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- telegram_conversation_state: sama seperti identities
CREATE POLICY "tcs_select" ON public.telegram_conversation_state
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- knowledge_* : bisa dilihat semua role terautentikasi dalam company (dipakai
-- untuk ekstraksi), tapi hanya owner/manager/admin yang bisa mengubah.
CREATE POLICY "kpa_select" ON public.knowledge_product_aliases
  FOR SELECT USING (company_id = public.get_user_company_id());
CREATE POLICY "kpa_manage" ON public.knowledge_product_aliases
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "kca_select" ON public.knowledge_customer_aliases
  FOR SELECT USING (company_id = public.get_user_company_id());
CREATE POLICY "kca_manage" ON public.knowledge_customer_aliases
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "kua_select" ON public.knowledge_unit_aliases
  FOR SELECT USING (company_id = public.get_user_company_id());
CREATE POLICY "kua_manage" ON public.knowledge_unit_aliases
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

CREATE POLICY "kdp_select" ON public.knowledge_discount_policies
  FOR SELECT USING (company_id = public.get_user_company_id());
CREATE POLICY "kdp_manage" ON public.knowledge_discount_policies
  FOR ALL USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- knowledge_candidates: sales boleh melihat kandidat miliknya sendiri;
-- hanya owner/manager/admin yang bisa approve/reject (update status).
CREATE POLICY "kc_select" ON public.knowledge_candidates
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      submitted_by = auth.uid()
      OR public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
    )
  );

CREATE POLICY "kc_review" ON public.knowledge_candidates
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner','manager','admin','super_admin'])
  );

-- Permission baru untuk mengelola knowledge pack & telegram identity (dashboard masa depan)
INSERT INTO public.permissions (name, module, action, description) VALUES
  ('knowledge.view',   'knowledge', 'view',   'View knowledge pack (product/customer alias, discount policy)'),
  ('knowledge.manage', 'knowledge', 'manage', 'Manage & approve knowledge pack candidates'),
  ('telegram.manage',  'telegram',  'manage', 'Manage Telegram identity mapping')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
CROSS JOIN public.permissions p
WHERE r.name IN ('owner','manager','admin') AND r.is_system_role = TRUE
  AND p.name IN ('knowledge.view','knowledge.manage','telegram.manage')
ON CONFLICT DO NOTHING;
