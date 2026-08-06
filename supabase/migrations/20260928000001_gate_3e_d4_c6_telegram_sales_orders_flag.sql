-- =============================================================================
-- Gate 3E-D4-C6 — Global kill switch untuk Telegram Sales Order.
--
-- Audit blocker: rejectionReason 'capability_denied_sales_order_telegram'
-- (hasSalesOrderCapability, lib/sales-orders/repository.ts) sudah menegakkan
-- role sales-only, tapi TIDAK ADA mekanisme untuk mematikan seluruh workflow
-- Sales Order via Telegram secara global (lintas tenant) tanpa deploy ulang
-- kode. platform_feature_flags mengisi celah itu -- tabel platform-level
-- (BUKAN data tenant, sengaja tanpa company_id), dibaca HANYA lewat
-- service-role admin client dari server (lihat
-- lib/feature-flags/repository.ts). Default OFF bila baris tidak ada,
-- kolom malformed, atau query gagal -- fail-closed, konsisten dengan pola
-- fail-closed capability check yang sudah ada.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.platform_feature_flags (
  key         TEXT        PRIMARY KEY,
  enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  UUID        REFERENCES public.users (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_feature_flags IS
  'Kill switch tingkat platform (global, lintas tenant) -- bukan data bisnis tenant. Runtime membaca lewat service-role admin client (bypass RLS); policy di bawah hanya untuk akses dari sesi user biasa.';

CREATE TRIGGER trg_platform_feature_flags_updated_at
  BEFORE UPDATE ON public.platform_feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.platform_feature_flags ENABLE ROW LEVEL SECURITY;

-- Fail-closed by default: tidak ada policy untuk role selain super_admin,
-- jadi RLS otomatis menolak SELECT/mutasi apa pun dari sesi user biasa.
CREATE POLICY "pff_select" ON public.platform_feature_flags
  FOR SELECT USING (public.user_has_role(ARRAY['super_admin']));

CREATE POLICY "pff_manage" ON public.platform_feature_flags
  FOR ALL USING (public.user_has_role(ARRAY['super_admin']));

-- Seed key telegram_sales_orders, default OFF. Diaktifkan eksplisit per
-- gate (mis. Gate 3E-D4-C6 mengaktifkan untuk UAT hosted) lewat UPDATE
-- terpisah -- bukan lewat migration ini, supaya migration ini idempotent
-- dan tidak pernah membuka flag secara diam-diam saat re-run.
INSERT INTO public.platform_feature_flags (key, enabled, description)
VALUES (
  'telegram_sales_orders',
  FALSE,
  'Kill switch global workflow Sales Order via Telegram (Gate 3E-D4-C6). Default OFF -- diaktifkan eksplisit per gate/UAT.'
)
ON CONFLICT (key) DO NOTHING;
