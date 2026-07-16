-- =============================================================================
-- Migration: Delivery Verification MVP
--
-- Tahap 2 vertical slice AODP: Sales Order → Delivery Verification → Invoice
-- → Collection → Owner Alert (Constitution L16; AODP Waluyo Living Knowledge
-- Pack v1.0 §4.2; Delivery Verification Implementation Gate).
--
-- Scope MVP: rekonsiliasi order→kirim→terima→invoice-eligible, evidence,
-- exception, append-only audit trail, owner alert outbox. TIDAK membuat
-- invoice final, TIDAK Collection, TIDAK Warehouse/WMS, TIDAK GPS provider
-- integration, TIDAK ML fraud verdict — sesuai Implementation Gate §3.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- deliveries — header. Satu sales_order dapat punya lebih dari satu delivery
-- (mis. re-delivery setelah store_closed) — attempt_number membedakannya.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.deliveries (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id     UUID         NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  attempt_number     INTEGER      NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  assigned_driver_id UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  status             VARCHAR(30)  NOT NULL DEFAULT 'planned'
                        CHECK (status IN (
                          'planned', 'dispatched', 'arrived', 'fully_received',
                          'partially_received', 'rejected', 'store_closed',
                          'failed', 'verified'
                        )),
  idempotency_key    TEXT,
  dispatched_at      TIMESTAMPTZ,
  arrived_at         TIMESTAMPTZ,
  finalized_at       TIMESTAMPTZ,
  created_by         UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (sales_order_id, attempt_number),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX idx_deliveries_company_id     ON public.deliveries (company_id, status);
CREATE INDEX idx_deliveries_sales_order_id ON public.deliveries (sales_order_id);
CREATE INDEX idx_deliveries_driver_id      ON public.deliveries (assigned_driver_id);

CREATE TRIGGER trg_deliveries_updated_at
  BEFORE UPDATE ON public.deliveries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.deliveries IS
  'Delivery Verification header — rekonsiliasi order/kirim/terima per sales_order. Tenant-scoped, idempotency_key mencegah pembuatan delivery ganda dari retry Telegram/webhook.';
COMMENT ON COLUMN public.deliveries.idempotency_key IS
  'Kunci idempotency dari caller (mis. dari Telegram update_id pembuat delivery) — unique per company. NULL diperbolehkan untuk delivery yang dibuat lewat jalur lain.';

-- ---------------------------------------------------------------------------
-- delivery_items — rekonsiliasi per baris sales_order_item.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delivery_items (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id          UUID         NOT NULL REFERENCES public.deliveries (id) ON DELETE CASCADE,
  sales_order_item_id  UUID         NOT NULL REFERENCES public.sales_order_items (id) ON DELETE CASCADE,
  ordered_quantity     NUMERIC(15,3) NOT NULL CHECK (ordered_quantity >= 0),
  dispatched_quantity  NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (dispatched_quantity >= 0),
  received_quantity    NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  rejected_quantity    NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  returned_quantity    NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  unresolved_quantity  NUMERIC(15,3) NOT NULL DEFAULT 0 CHECK (unresolved_quantity >= 0),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (delivery_id, sales_order_item_id),
  -- Invariant selalu benar terlepas dari status: tidak mungkin ada barang yang
  -- "diterima/ditolak/dikembalikan/belum-selesai" melebihi yang dikirim.
  CHECK (received_quantity + rejected_quantity + returned_quantity + unresolved_quantity <= dispatched_quantity),
  -- Tidak mungkin mengirim lebih dari yang dipesan.
  CHECK (dispatched_quantity <= ordered_quantity)
);

CREATE INDEX idx_delivery_items_delivery_id  ON public.delivery_items (delivery_id);
CREATE INDEX idx_delivery_items_soi_id       ON public.delivery_items (sales_order_item_id);

CREATE TRIGGER trg_delivery_items_updated_at
  BEFORE UPDATE ON public.delivery_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.delivery_items IS
  'Rekonsiliasi per item: ordered (snapshot dari sales_order_items) vs dispatched vs received/rejected/returned/unresolved. Invoice eligibility SELALU dari received_quantity, tidak pernah ordered/dispatched.';

-- ---------------------------------------------------------------------------
-- delivery_exceptions — reason code wajib untuk setiap penyimpangan.
-- Immutable kecuali resolution_status (hanya owner/manager/admin).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delivery_exceptions (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  delivery_id        UUID         NOT NULL REFERENCES public.deliveries (id) ON DELETE CASCADE,
  delivery_item_id   UUID         REFERENCES public.delivery_items (id) ON DELETE CASCADE,
  reason_code        VARCHAR(40)  NOT NULL CHECK (reason_code IN (
                        'STORE_CLOSED', 'CUSTOMER_PARTIAL_ACCEPTANCE', 'CUSTOMER_REJECTED',
                        'ITEM_DAMAGED', 'ITEM_MISMATCH', 'QUANTITY_MISMATCH',
                        'PRICE_OR_DISCOUNT_DISPUTE', 'RECIPIENT_NOT_AUTHORIZED',
                        'ADDRESS_NOT_FOUND', 'VEHICLE_OR_DRIVER_ISSUE', 'OTHER_REQUIRES_NOTE'
                      )),
  note               TEXT,
  -- Severity provisional (belum ada materiality threshold terkalibrasi —
  -- lihat AODP Waluyo Living Knowledge Pack v1.0 §10). Dihitung transparan
  -- oleh service layer, bukan angka nominal buatan.
  severity           VARCHAR(20)  NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  resolution_status  VARCHAR(20)  NOT NULL DEFAULT 'open' CHECK (resolution_status IN ('open', 'resolved', 'wont_fix')),
  actor_id           UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (reason_code <> 'OTHER_REQUIRES_NOTE' OR (note IS NOT NULL AND length(trim(note)) > 0))
);

CREATE INDEX idx_delivery_exceptions_delivery_id ON public.delivery_exceptions (delivery_id);
CREATE INDEX idx_delivery_exceptions_company_id  ON public.delivery_exceptions (company_id, resolution_status);

COMMENT ON TABLE public.delivery_exceptions IS
  'Penyimpangan delivery — reason code wajib. Immutable (append-only) kecuali resolution_status, dan hanya owner/manager/admin yang boleh mengubahnya. Sales/driver tidak pernah bisa update/delete.';

-- ---------------------------------------------------------------------------
-- delivery_evidence — foto/lokasi/tanda tangan/voice note. storage_ref
-- adalah referensi (mis. Telegram file_id), bukan file yang di-hosting AODP
-- sendiri — MVP tidak membangun storage bucket baru.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delivery_evidence (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  delivery_id       UUID         NOT NULL REFERENCES public.deliveries (id) ON DELETE CASCADE,
  delivery_item_id  UUID         REFERENCES public.delivery_items (id) ON DELETE CASCADE,
  evidence_type     VARCHAR(20)  NOT NULL CHECK (evidence_type IN ('photo', 'signature', 'voice_note', 'location', 'note')),
  storage_ref       TEXT         NOT NULL,
  captured_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  latitude          NUMERIC(9,6),
  longitude         NUMERIC(9,6),
  actor_id          UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  metadata          JSONB        NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delivery_evidence_delivery_id ON public.delivery_evidence (delivery_id);

COMMENT ON TABLE public.delivery_evidence IS
  'Bukti delivery (foto/signature/voice/lokasi/catatan) — storage_ref adalah referensi eksternal (mis. Telegram file_id), bukan file yang di-hosting AODP. Immutable — sales/driver tidak bisa menghapus. metadata JSONB tidak boleh berisi secret.';
COMMENT ON COLUMN public.delivery_evidence.metadata IS
  'Metadata aman saja (mis. dimensi foto, durasi voice note) — TIDAK PERNAH menyimpan token/secret/kredensial.';

-- ---------------------------------------------------------------------------
-- delivery_recipients — verifikasi penerima, 1:1 per delivery.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delivery_recipients (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  delivery_id           UUID         NOT NULL UNIQUE REFERENCES public.deliveries (id) ON DELETE CASCADE,
  recipient_name        VARCHAR(255) NOT NULL,
  identity_note         TEXT,
  signature_evidence_id UUID         REFERENCES public.delivery_evidence (id) ON DELETE SET NULL,
  is_expected_pic       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delivery_recipients_delivery_id ON public.delivery_recipients (delivery_id);

COMMENT ON COLUMN public.delivery_recipients.is_expected_pic IS
  'FALSE bila penerima berbeda dari PIC/pemesan historis pada sales_order — memicu relationship event (DV-05 / CH-02), tidak otomatis memblokir transaksi.';

-- ---------------------------------------------------------------------------
-- delivery_events — append-only audit trail (state transitions). Pola sama
-- seperti telegram_update_events: hanya service role yang insert, tidak ada
-- policy UPDATE/DELETE untuk siapa pun.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delivery_events (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  delivery_id              UUID         NOT NULL REFERENCES public.deliveries (id) ON DELETE CASCADE,
  event_type               VARCHAR(50)  NOT NULL,
  from_status              VARCHAR(30),
  to_status                VARCHAR(30),
  actor_id                 UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  telegram_update_event_id UUID         REFERENCES public.telegram_update_events (id) ON DELETE SET NULL,
  payload                  JSONB        NOT NULL DEFAULT '{}',
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_delivery_events_delivery_id ON public.delivery_events (delivery_id, created_at);
CREATE INDEX idx_delivery_events_company_id  ON public.delivery_events (company_id, created_at DESC);

COMMENT ON TABLE public.delivery_events IS
  'Append-only audit trail delivery — satu baris per transisi state/aksi. Tidak dapat diubah atau dihapus oleh siapa pun lewat RLS (hanya service role via INSERT langsung, tanpa policy UPDATE/DELETE sama sekali).';

-- ---------------------------------------------------------------------------
-- delivery_conversation_state — state machine Telegram per identity untuk
-- alur operasional delivery (terpisah dari telegram_conversation_state milik
-- alur konfirmasi sales order — workflow berbeda, bentuk state berbeda).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.delivery_conversation_state (
  telegram_identity_id UUID         PRIMARY KEY REFERENCES public.telegram_identities (id) ON DELETE CASCADE,
  company_id           UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  pending_delivery_id  UUID         REFERENCES public.deliveries (id) ON DELETE SET NULL,
  awaiting             VARCHAR(30)  NOT NULL DEFAULT 'none'
                          CHECK (awaiting IN (
                            'none', 'start_confirmation', 'outcome_selection',
                            'item_quantity', 'reason_selection', 'reason_note',
                            'evidence', 'final_confirmation'
                          )),
  current_item_index   INTEGER      NOT NULL DEFAULT 0,
  draft_state          JSONB        NOT NULL DEFAULT '{}',
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.delivery_conversation_state IS
  'State machine percakapan Telegram untuk alur eksekusi delivery driver. draft_state menyimpan progres sementara (jumlah per item, reason, evidence yang sudah diterima) sebelum final_confirmation.';

-- ---------------------------------------------------------------------------
-- owner_alerts — outbox notifikasi owner. Durable, TIDAK PERNAH ditandai
-- 'sent' kecuali benar-benar terkirim. Belum ada provider WhatsApp aktif di
-- MVP ini — alert akan tetap 'pending' sampai provider disiapkan Founder.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.owner_alerts (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id  UUID         REFERENCES public.sales_orders (id) ON DELETE SET NULL,
  delivery_id     UUID         REFERENCES public.deliveries (id) ON DELETE SET NULL,
  alert_type      VARCHAR(50)  NOT NULL,
  channel         VARCHAR(20)  NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
  severity        VARCHAR(20)  NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  payload         JSONB        NOT NULL,
  status          VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        INTEGER      NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);

CREATE INDEX idx_owner_alerts_company_id ON public.owner_alerts (company_id, status, created_at DESC);
CREATE INDEX idx_owner_alerts_delivery_id ON public.owner_alerts (delivery_id);

COMMENT ON TABLE public.owner_alerts IS
  'Outbox alert owner (WhatsApp). status hanya boleh menjadi sent setelah provider benar-benar mengirim — tidak ada provider WhatsApp aktif di MVP ini, jadi alert tetap pending sampai Founder menyiapkan provider (lihat docs). payload berisi kontrak alert terstruktur (toko, order, variance, alasan, bukti, rekomendasi).';
COMMENT ON COLUMN public.owner_alerts.severity IS
  'Provisional — materiality threshold belum dikalibrasi (AODP Waluyo Living Knowledge Pack v1.0 §10). MVP: setiap variance yang mengubah invoice eligibility menghasilkan alert.';

-- ---------------------------------------------------------------------------
-- Permissions baru
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('delivery.view',    'delivery', 'view',    'View delivery verification records'),
  ('delivery.manage',  'delivery', 'manage',  'Manage delivery verification (assign driver, resolve exceptions)'),
  ('delivery.execute', 'delivery', 'execute', 'Execute delivery as assigned driver (dispatch, record outcome)')
ON CONFLICT (name) DO NOTHING;

-- Owner/manager/admin/super_admin: manage. Driver: execute. Semua di atas + sales: view.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND (
    (r.name IN ('owner', 'manager', 'admin', 'super_admin') AND p.name IN ('delivery.view', 'delivery.manage'))
    OR (r.name = 'driver' AND p.name IN ('delivery.view', 'delivery.execute'))
    OR (r.name IN ('sales', 'finance', 'warehouse') AND p.name = 'delivery.view')
  )
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.deliveries                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_items               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_exceptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_evidence            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_recipients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_conversation_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_alerts                 ENABLE ROW LEVEL SECURITY;

-- deliveries: company-scoped; driver sees only their own assignment.
CREATE POLICY "deliveries_select" ON public.deliveries
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('delivery.view')
      OR assigned_driver_id = auth.uid()
    )
  );

CREATE POLICY "deliveries_insert" ON public.deliveries
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('delivery.manage')
  );

CREATE POLICY "deliveries_update" ON public.deliveries
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND (
      public.user_has_permission('delivery.manage')
      OR (assigned_driver_id = auth.uid() AND public.user_has_permission('delivery.execute'))
    )
  );

-- Tidak ada policy DELETE untuk deliveries — tidak boleh dihapus siapa pun lewat RLS.

CREATE POLICY "delivery_items_select" ON public.delivery_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_id
        AND d.company_id = public.get_user_company_id()
        AND (public.user_has_permission('delivery.view') OR d.assigned_driver_id = auth.uid())
    )
  );

CREATE POLICY "delivery_items_insert" ON public.delivery_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_id
        AND d.company_id = public.get_user_company_id()
        AND public.user_has_permission('delivery.manage')
    )
  );

CREATE POLICY "delivery_items_update" ON public.delivery_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_id
        AND d.company_id = public.get_user_company_id()
        AND (
          public.user_has_permission('delivery.manage')
          OR (d.assigned_driver_id = auth.uid() AND public.user_has_permission('delivery.execute'))
        )
    )
  );

-- delivery_exceptions: SELECT company-scoped; UPDATE (resolution_status only,
-- enforced di application layer) hanya delivery.manage. TIDAK ADA DELETE.
CREATE POLICY "delivery_exceptions_select" ON public.delivery_exceptions
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (public.user_has_permission('delivery.view') OR public.user_has_permission('delivery.execute'))
  );

CREATE POLICY "delivery_exceptions_insert" ON public.delivery_exceptions
  FOR INSERT WITH CHECK (company_id = public.get_user_company_id());

CREATE POLICY "delivery_exceptions_update" ON public.delivery_exceptions
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('delivery.manage')
  );

-- delivery_evidence: SELECT company-scoped. INSERT oleh siapa pun yang
-- berhak eksekusi delivery. TIDAK ADA UPDATE/DELETE — evidence immutable.
CREATE POLICY "delivery_evidence_select" ON public.delivery_evidence
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (public.user_has_permission('delivery.view') OR public.user_has_permission('delivery.execute'))
  );

CREATE POLICY "delivery_evidence_insert" ON public.delivery_evidence
  FOR INSERT WITH CHECK (company_id = public.get_user_company_id());

-- delivery_recipients: SELECT company-scoped, INSERT saat verifikasi
-- penerima. TIDAK ADA UPDATE/DELETE.
CREATE POLICY "delivery_recipients_select" ON public.delivery_recipients
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND (public.user_has_permission('delivery.view') OR public.user_has_permission('delivery.execute'))
  );

CREATE POLICY "delivery_recipients_insert" ON public.delivery_recipients
  FOR INSERT WITH CHECK (company_id = public.get_user_company_id());

-- delivery_events: read-only untuk manajemen (append-only audit trail).
-- TIDAK ADA policy INSERT/UPDATE/DELETE untuk role authenticated — hanya
-- service role (bypass RLS) yang menulis, pola sama seperti telegram_update_events.
CREATE POLICY "delivery_events_select" ON public.delivery_events
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('delivery.view')
  );

-- delivery_conversation_state: tidak ada akses dashboard biasa — murni
-- internal state webhook (service role only, RLS aktif tapi tanpa policy
-- untuk role authenticated sama sekali, konsisten dengan telegram_conversation_state).

-- owner_alerts: SELECT untuk manajemen. TIDAK ADA INSERT/UPDATE/DELETE untuk
-- role authenticated — hanya service role yang menulis (webhook/worker),
-- mencegah sales/driver menandai alert miliknya sendiri sebagai selesai.
CREATE POLICY "owner_alerts_select" ON public.owner_alerts
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_role(ARRAY['owner', 'manager', 'admin', 'super_admin'])
  );
