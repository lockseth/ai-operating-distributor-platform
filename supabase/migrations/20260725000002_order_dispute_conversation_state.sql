-- =============================================================================
-- order_dispute_conversation_state — state machine Telegram per identity
-- untuk alur "Batalkan atau Sengketakan Order", terpisah dari
-- telegram_conversation_state (alur konfirmasi order) dan
-- delivery_conversation_state (alur eksekusi delivery) — workflow berbeda,
-- mengikuti pola yang sudah ada. Tidak ada akses dashboard biasa — murni
-- state sementara sisi Telegram, dibaca/ditulis service_role saja.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.order_dispute_conversation_state (
  telegram_identity_id UUID         PRIMARY KEY REFERENCES public.telegram_identities (id) ON DELETE CASCADE,
  company_id           UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  pending_sales_order_id UUID       REFERENCES public.sales_orders (id) ON DELETE SET NULL,
  awaiting              VARCHAR(30) NOT NULL DEFAULT 'none'
                          CHECK (awaiting IN (
                            'none', 'order_lookup', 'type_selection', 'pic_name',
                            'contact_source', 'reason_selection', 'notes', 'final_confirmation'
                          )),
  draft_state           JSONB       NOT NULL DEFAULT '{}',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.order_dispute_conversation_state IS
  'State machine percakapan Telegram untuk alur Batalkan/Sengketakan Order. draft_state menyimpan progres sementara (order_id, request_type, pic, sumber, alasan, catatan) sebelum final_confirmation.';

ALTER TABLE public.order_dispute_conversation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_dispute_conversation_state FROM PUBLIC, anon, authenticated;
