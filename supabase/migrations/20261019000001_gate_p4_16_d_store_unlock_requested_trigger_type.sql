-- =============================================================================
-- Gate P4.16-D -- Tambah trigger_type 'store_unlock_requested' ke whitelist
-- automation_rules (migration 20260626000008, diperluas 20261011000001).
--
-- Celah ditemukan saat mau seed rule notifikasi WA untuk Gate P4.16: kode TS
-- (lib/automation/types.ts) sudah punya 'store_unlock_requested' di union
-- AutomationTriggerType sejak Fase 1 (call_bablast, 2026-08-23), tapi
-- CHECK constraint DB tidak pernah ikut diperluas -- INSERT automation_rules
-- dengan trigger_type ini akan ditolak constraint violation. Pola migration
-- IDENTIK Gate P4.08 (murni tambah whitelist, engine.ts TIDAK disentuh).
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
    'special_price_proposal_submitted',
    'store_unlock_requested'
  ));

COMMENT ON CONSTRAINT automation_rules_trigger_type_check ON public.automation_rules IS
  'Gate P4.16-D: menambah store_unlock_requested (notifikasi WA Owner saat sales ajukan buka kunci toko) ke whitelist trigger_type existing.';
