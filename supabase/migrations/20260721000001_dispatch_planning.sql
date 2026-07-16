-- =============================================================================
-- Migration: AI Dispatch Planning MVP
--
-- AODP Waluyo — AI Order-to-Delivery Planning MVP Gate. Menambahkan lapisan
-- perencanaan pengiriman (AI Dispatch Planner) di antara "order confirmed"
-- dan "delivery execution" yang sudah ada (deliveries/delivery_items,
-- Delivery Verification — PASS, tidak diubah oleh migration ini).
--
-- Scope: dispatch_plans (satu baris per sales_order, keputusan planner:
-- tanggal, grouping area, actor, alasan, confidence) + dispatch_plan_events
-- (append-only audit, pola sama seperti delivery_events) + kolom pendukung
-- input planner (products.weight_kg untuk tonase, sales_orders.
-- requested_delivery_date untuk preferensi customer) + perluasan
-- knowledge_candidates.candidate_type supaya human override dispatch plan
-- dapat menjadi Knowledge Candidate (pola sama seperti koreksi "UBAH" pada
-- sales order).
--
-- TIDAK membuat RPC/SECURITY DEFINER baru -- idempotency cukup lewat
-- UNIQUE(company_id, sales_order_id), tidak ada aggregate cross-row
-- invariant seperti delivery quantity sehingga tidak perlu row-locked
-- function. Ini sengaja menghindari kelas risiko yang diaudit di Global SQL
-- Routine Exposure Gate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Kolom pendukung input planner
-- ---------------------------------------------------------------------------

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,3) CHECK (weight_kg IS NULL OR weight_kg >= 0);
COMMENT ON COLUMN public.products.weight_kg IS
  'Berat per unit untuk evaluasi tonase dispatch planning. NULL = belum diketahui -- planner mengecualikan produk ini dari cek tonase (bukan dianggap 0), dicatat sebagai data quality gap pada confidence score.';

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS requested_delivery_date DATE;
COMMENT ON COLUMN public.sales_orders.requested_delivery_date IS
  'Preferensi tanggal kirim dari customer (mis. "kirim Sabtu saja"). NULL = tidak ada preferensi eksplisit. Diisi manual (admin/sales) untuk MVP ini -- ekstraksi otomatis dari teks/voice belum dibangun.';

-- ---------------------------------------------------------------------------
-- dispatch_plans -- keputusan AI Dispatch Planner per sales_order.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dispatch_plans (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  sales_order_id      UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  planning_status     VARCHAR(30)   NOT NULL DEFAULT 'document_ready'
                        CHECK (planning_status IN (
                          'document_ready', 'waiting_planning', 'planned', 'scheduled',
                          'ready_for_delivery',
                          'waiting_stock', 'customer_requested_delay', 'manual_hold', 'route_conflict',
                          'cancelled'
                        )),
  delivery_date       DATE,
  delivery_area       VARCHAR(100),
  delivery_group_key  VARCHAR(160),
  assigned_actor_id   UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  planning_reason     TEXT          NOT NULL DEFAULT '',
  confidence_score    NUMERIC(4,3)  NOT NULL DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  is_override         BOOLEAN       NOT NULL DEFAULT FALSE,
  planned_at          TIMESTAMPTZ,
  scheduled_at        TIMESTAMPTZ,
  created_by          UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, sales_order_id)
);

CREATE INDEX idx_dispatch_plans_company_status ON public.dispatch_plans (company_id, planning_status);
CREATE INDEX idx_dispatch_plans_group_key      ON public.dispatch_plans (company_id, delivery_group_key);
CREATE INDEX idx_dispatch_plans_actor          ON public.dispatch_plans (assigned_actor_id);

CREATE TRIGGER trg_dispatch_plans_updated_at
  BEFORE UPDATE ON public.dispatch_plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.dispatch_plans IS
  'Keputusan AI Dispatch Planner (deterministic rule engine, bukan LLM) per sales_order confirmed: tanggal kirim, grouping area, actor, alasan, confidence. Satu baris per order (UNIQUE company_id+sales_order_id) -- idempotent by design, tidak perlu RPC atomic karena tidak ada aggregate cross-row invariant. Terminal state ready_for_delivery adalah titik serah-terima ke modul Delivery Verification yang sudah ada (deliveries/delivery_items) -- dispatch_plans TIDAK menduplikasi status delivering/delivered milik deliveries/sales_orders.';
COMMENT ON COLUMN public.dispatch_plans.delivery_group_key IS
  'Grouping sederhana berbasis area+tanggal (mis. "Kota|2026-07-20") -- bukan route optimization. Route Intelligence (GPS/Maps) adalah phase berikutnya, sengaja tidak dibangun di MVP ini.';
COMMENT ON COLUMN public.dispatch_plans.is_override IS
  'TRUE bila keputusan saat ini adalah hasil human override (bukan murni AI). Override selalu dicatat di dispatch_plan_events dan menjadi knowledge_candidates -- lihat migration ini bagian bawah.';

-- ---------------------------------------------------------------------------
-- dispatch_plan_events -- append-only audit trail (pola identik
-- delivery_events: hanya service_role yang insert, tidak ada policy
-- UPDATE/DELETE untuk siapa pun).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dispatch_plan_events (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  dispatch_plan_id  UUID         NOT NULL REFERENCES public.dispatch_plans (id) ON DELETE CASCADE,
  event_type        VARCHAR(50)  NOT NULL,
  from_status       VARCHAR(30),
  to_status         VARCHAR(30),
  actor_id          UUID         REFERENCES public.users (id) ON DELETE SET NULL,
  is_ai_decision    BOOLEAN      NOT NULL DEFAULT FALSE,
  reason            TEXT,
  payload           JSONB        NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dispatch_plan_events_plan_id    ON public.dispatch_plan_events (dispatch_plan_id, created_at);
CREATE INDEX idx_dispatch_plan_events_company_id ON public.dispatch_plan_events (company_id, created_at DESC);

COMMENT ON TABLE public.dispatch_plan_events IS
  'Append-only audit trail dispatch planning -- satu baris per keputusan/transisi (AI atau human override). is_ai_decision membedakan keduanya untuk Living Knowledge/learning. Tidak dapat diubah/dihapus oleh siapa pun lewat RLS.';

-- ---------------------------------------------------------------------------
-- knowledge_candidates -- perluasan candidate_type supaya human override
-- dispatch plan dapat menjadi Knowledge Candidate (pola sama seperti
-- koreksi "UBAH" pada sales order -- lihat 20260709000001).
-- ---------------------------------------------------------------------------

ALTER TABLE public.knowledge_candidates
  DROP CONSTRAINT IF EXISTS knowledge_candidates_candidate_type_check;
ALTER TABLE public.knowledge_candidates
  ADD CONSTRAINT knowledge_candidates_candidate_type_check
  CHECK (candidate_type IN ('product_alias', 'customer_alias', 'unit_alias', 'other', 'dispatch_planning_override'));

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('dispatch.view',   'dispatch', 'view',   'View dispatch plans'),
  ('dispatch.manage', 'dispatch', 'manage', 'Create and override dispatch plans')
ON CONFLICT (name) DO NOTHING;

-- Owner/manager/admin/super_admin: manage. Sales/finance/warehouse: view saja.
-- Driver TIDAK diberi dispatch.view/manage -- driver mengeksekusi delivery,
-- bukan merencanakan (pemisahan tugas, konsisten dengan delivery.execute).
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND (
    (r.name IN ('owner', 'manager', 'admin', 'super_admin') AND p.name IN ('dispatch.view', 'dispatch.manage'))
    OR (r.name IN ('sales', 'finance', 'warehouse') AND p.name = 'dispatch.view')
  )
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS -- pola identik deliveries/delivery_events (company-scoped, tidak ada
-- policy DELETE untuk siapa pun; events read-only untuk authenticated).
-- ---------------------------------------------------------------------------

ALTER TABLE public.dispatch_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_plan_events  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dispatch_plans_select" ON public.dispatch_plans
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('dispatch.view')
  );

CREATE POLICY "dispatch_plans_insert" ON public.dispatch_plans
  FOR INSERT WITH CHECK (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('dispatch.manage')
  );

CREATE POLICY "dispatch_plans_update" ON public.dispatch_plans
  FOR UPDATE USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('dispatch.manage')
  );

-- Tidak ada policy DELETE untuk dispatch_plans -- riwayat perencanaan tidak
-- boleh dihapus siapa pun lewat RLS (konsisten dengan deliveries).

CREATE POLICY "dispatch_plan_events_select" ON public.dispatch_plan_events
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('dispatch.view')
  );

-- Tidak ada policy INSERT/UPDATE/DELETE untuk dispatch_plan_events pada role
-- authenticated -- hanya service_role (bypass RLS) yang menulis, pola sama
-- seperti delivery_events/telegram_update_events.
