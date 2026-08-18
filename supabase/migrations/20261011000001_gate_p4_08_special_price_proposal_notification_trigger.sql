-- =============================================================================
-- Gate P4.08 -- Tambah trigger_type 'special_price_proposal_submitted' ke
-- automation_rules (migration 20260626000008, engine existing LOCKED --
-- lib/automation/engine.ts TIDAK diubah sama sekali di sini).
--
-- Konteks: Owner minta notifikasi realtime (WhatsApp, provider Bablast) saat
-- Sales mengajukan harga khusus, supaya tidak perlu buka Owner Approval Inbox
-- berkala untuk tahu ada yang menunggu. Automation engine sudah mendukung
-- persis pola ini (event -> rule -> action call_n8n -> webhook n8n
-- terkonfigurasi per tenant) -- provider WhatsApp (Bablast) BELUM dikoneksikan
-- (kredensial belum tersedia saat gate ini ditulis), jadi scope migration ini
-- MURNI menambah trigger_type baru ke whitelist supaya sisi AODP bisa
-- memicu event-nya. Rule + webhook n8n sesungguhnya (yang memanggil Bablast)
-- didaftarkan terpisah kapan pun kredensial provider sudah siap -- TIDAK ada
-- di migration ini, mengikuti pola trigger_type lain (customer_dormant, dst.)
-- yang juga tidak otomatis punya rule aktif.
-- =============================================================================

ALTER TABLE public.automation_rules
  DROP CONSTRAINT automation_rules_trigger_type_check;

ALTER TABLE public.automation_rules
  ADD CONSTRAINT automation_rules_trigger_type_check
  CHECK (trigger_type IN (
    'customer_dormant',
    'churn_risk',
    'repeat_order_due',
    'large_order',
    'new_order',
    'low_stock',
    'payment_overdue',
    'new_customer',
    'scheduled_daily',
    'scheduled_weekly',
    'manual',
    'special_price_proposal_submitted'
  ));

COMMENT ON CONSTRAINT automation_rules_trigger_type_check ON public.automation_rules IS
  'Gate P4.08: menambah special_price_proposal_submitted (Owner Approval Inbox realtime notify) ke whitelist trigger_type existing (migration 20260626000008).';
