-- =============================================================================
-- Percakapan Telegram "Tambah Toko" — state machine terpisah dari
-- conversation state sales-orders/delivery/dispute (pola JSONB draft yang
-- sama). BEDA dengan precedent sebelumnya: tabel ini punya expires_at
-- eksplisit (LANGKAH 6: "conversation state tenant-scoped dan memiliki
-- expiry") -- draft toko/PIC yang ditinggal Salesman di tengah jalan tidak
-- boleh nyangkut selamanya, dan tidak boleh dilanjutkan setelah lama idle
-- (data toko/PIC bisa jadi sudah tidak relevan).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.store_pic_conversation_state (
  telegram_identity_id UUID         PRIMARY KEY REFERENCES public.telegram_identities (id) ON DELETE CASCADE,
  company_id           UUID         NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  awaiting              VARCHAR(30) NOT NULL DEFAULT 'none'
                          CHECK (awaiting IN (
                            'none', 'store_name', 'store_address', 'store_area', 'store_phone',
                            'pic_name', 'pic_phone', 'pic_roles', 'final_confirmation',
                            'similar_duplicate_confirmation'
                          )),
  draft_state           JSONB       NOT NULL DEFAULT '{}',
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN public.store_pic_conversation_state.expires_at IS
  'Percakapan yang belum KONFIRMASI/BATAL setelah expires_at dianggap kedaluwarsa -- dibaca sebagai awaiting=none oleh workflow (lib/customer-pic/conversation.ts), tidak melanjutkan draft lama.';

ALTER TABLE public.store_pic_conversation_state ENABLE ROW LEVEL SECURITY;

-- Sama seperti order_dispute_conversation_state/delivery_conversation_state:
-- tidak ada policy SELECT sama sekali -- hanya service_role (admin client di
-- webhook route) yang mengakses, tidak ada akses dashboard biasa.
REVOKE ALL ON TABLE public.store_pic_conversation_state FROM PUBLIC, anon, authenticated;
