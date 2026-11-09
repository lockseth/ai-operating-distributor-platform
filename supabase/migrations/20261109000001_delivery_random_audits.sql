-- =============================================================================
-- Audit acak pengiriman untuk Owner (pagar anti-kolusi admin-sales).
-- Rancangan: docs/product/delivery-verification/AODP_DELIVERY_ADMIN_INPUT_DESIGN.md
--
-- Owner membuat sampel pengiriman selesai (prioritas: diinput admin, tanpa lokasi,
-- ada selisih; sisanya acak), menelepon toko, lalu mencatat hasil. Penulisan hanya
-- lewat server action (service_role); satu baris audit per pengiriman.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.delivery_audits (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  delivery_id     UUID          NOT NULL REFERENCES public.deliveries (id) ON DELETE CASCADE,
  sales_order_id  UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE CASCADE,
  selection_reason VARCHAR(30)  NOT NULL CHECK (selection_reason IN ('admin_input','no_location','variance','random')),
  status          VARCHAR(20)   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified_ok','discrepancy')),
  selected_by     UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  selected_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  checked_by      UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  checked_at      TIMESTAMPTZ   NULL,
  result_note     TEXT          NULL,
  CONSTRAINT delivery_audits_checked_chk
    CHECK ((status = 'pending' AND checked_at IS NULL) OR (status <> 'pending' AND checked_at IS NOT NULL)),
  CONSTRAINT delivery_audits_discrepancy_note_chk
    CHECK (status <> 'discrepancy' OR (result_note IS NOT NULL AND length(btrim(result_note)) > 0)),
  UNIQUE (company_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_audits_company_status
  ON public.delivery_audits (company_id, status, selected_at DESC);

ALTER TABLE public.delivery_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delivery_audits_select" ON public.delivery_audits
  FOR SELECT USING (company_id = public.get_user_company_id());
-- Tanpa policy tulis: hanya service_role (server action).
