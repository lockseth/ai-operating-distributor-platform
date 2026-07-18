-- =============================================================================
-- telegram_menu_conversation_state — state machine Telegram untuk Menu Utama
-- Waluyo Daily Operating Loop (Mulai Hari/Agenda/Kunjungan/Order/Pengiriman/
-- Tambah Toko/Target/Tutup Hari/Laporkan Masalah), terpisah dari conversation
-- state domain lain (sales-order, delivery, dispute, store-pic) -- mengikuti
-- pola yang sudah ada di order_dispute_conversation_state/
-- store_pic_conversation_state. Murni state sementara sisi Telegram, dibaca/
-- ditulis service_role saja (RLS enabled, tanpa policy -- akses hanya lewat
-- admin client).
--
-- Daftar `awaiting` mencakup state untuk seluruh Menu Utama sekaligus
-- (bukan hanya Phase 2) supaya penambahan menu item di phase berikutnya
-- tidak perlu migration ALTER CHECK CONSTRAINT berulang.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.telegram_menu_conversation_state (
  telegram_identity_id UUID         PRIMARY KEY REFERENCES public.telegram_identities (id) ON DELETE CASCADE,
  company_id           UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  awaiting              VARCHAR(30) NOT NULL DEFAULT 'none'
                          CHECK (awaiting IN (
                            'none',
                            'main_menu',
                            'visit_store_select',
                            'visit_pic_select',
                            'visit_outcome_notes',
                            'visit_order_link_confirm',
                            'order_intake_store_select',
                            'order_intake_pic_select',
                            'order_intake_awaiting_text',
                            'delivery_select',
                            'report_problem_note'
                          )),
  draft_state           JSONB       NOT NULL DEFAULT '{}',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.telegram_menu_conversation_state IS
  'State machine percakapan Telegram untuk Menu Utama Daily Operating Loop. draft_state menyimpan progres sementara per sub-alur (toko/PIC terpilih, dsb) sebelum sub-alur mendelegasikan ke domain repository masing-masing (sales_calls, sales_orders, delivery).';

ALTER TABLE public.telegram_menu_conversation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.telegram_menu_conversation_state FROM PUBLIC, anon, authenticated;
