-- =============================================================================
-- Gate P4.05 -- NOO reversal saat order pembuka toko dibatalkan.
--
-- Keputusan Founder 2026-08-17 (bundel 5 keputusan bisnis, TRACKER.md
-- Backlog #6b): NOO (20260930000001, Gate 3E-D5-A, LOCKED) sengaja TIDAK
-- punya reversal ("kontrak instruksi eksplisit menyebut 'maksimal satu
-- kredit NOO seumur hidup', bukan 'net credit saat ini'") -- beda perlakuan
-- dari ORDER_COUNT/REVENUE (20260917000001) yang SUDAH reversal otomatis
-- utk kejadian pemicu identik (order -> cancelled). Risiko yang dilaporkan
-- CTO dan disetujui Founder utk ditutup: (1) kredit NOO bisa "diakali"
-- (order pertama confirm sebentar lalu dibatalkan, kredit tetap nempel
-- selamanya), DAN (2) memblokir toko itu dapat kredit NOO yang SAH di masa
-- depan (unique index lama `uq_skae_noo_credited_once` -- 1x seumur hidup
-- per customer_id, TANPA PANDANG apakah kredit awalnya sudah dibalik --
-- sudah terpakai selamanya).
--
-- Root cause analysis SEBELUM implementasi (wajib dibuktikan dulu, bukan
-- asumsi): trigger crediting asal (`credit_noo_for_sales_order`,
-- 20260930000001) SUDAH BENAR mengecek status LIVE (`so.status =
-- 'confirmed'`) order lain milik customer yang sama -- begitu order
-- pembuka toko dibatalkan (status -> 'cancelled'), baris itu otomatis
-- tidak lagi match `status = 'confirmed'`, sehingga order BERIKUTNYA yang
-- confirmed utk customer sama SUDAH SECARA ALAMI dianggap eligible lagi
-- oleh trigger crediting -- TIDAK PERLU diubah sama sekali. Satu-satunya
-- blocker adalah UNIQUE INDEX `uq_skae_noo_credited_once` yang di-scope ke
-- `customer_id` (bukan `order_id` seperti ORDER_COUNT/REVENUE) -- index
-- itu menolak baris CREDITED kedua utk customer yang sama SELAMANYA,
-- terlepas apakah baris pertama sudah dibalik REVERSED atau belum.
--
-- Fix (2 bagian, murni additive + 1 index diganti scope):
--   1. Tambah trigger reversal `reverse_noo_for_sales_order`, pola IDENTIK
--      `reverse_order_kpi_for_sales_order` (20260917000001) -- AFTER UPDATE
--      OF status, WHEN (NEW.status='cancelled' AND OLD.status IS DISTINCT
--      FROM 'cancelled'), ledger append-only (baris REVERSED baru, TIDAK
--      PERNAH UPDATE/DELETE baris CREDITED asal), idempotency_key dari
--      event id asal + ON CONFLICT DO NOTHING (retry-safe).
--   2. Ganti scope `uq_skae_noo_credited_once` dari `customer_id` ke
--      `order_id` -- pola IDENTIK `uq_skae_order_count_credited_once`/
--      `uq_skae_revenue_credited_once`. Ini SATU-SATUNYA perubahan pada
--      kontrak lock 3E-D5-A: index lama mencegah customer dikredit NOO
--      lebih dari 1x SEUMUR HIDUP; index baru mencegah ORDER YANG SAMA
--      mengkredit NOO lebih dari 1x (retry protection), dan
--      MENGANDALKAN kombinasi advisory lock per-customer (sudah ada,
--      tidak diubah) + live status check di trigger crediting (sudah ada,
--      tidak diubah) utk menjamin HANYA SATU kredit NOO customer yang
--      ACTIVE (belum dibalik) dalam satu waktu -- bukan lagi "1x seumur
--      hidup tanpa syarat". Trigger crediting/foundation/target RPC TIDAK
--      disentuh gate ini.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ganti scope unique index CREDITED: customer_id -> order_id (izinkan
--    re-credit legitimate setelah reversal, tetap cegah retry double-credit
--    utk order yang sama).
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS uq_skae_noo_credited_once;

CREATE UNIQUE INDEX uq_skae_noo_credited_once_per_order
  ON public.sales_kpi_achievement_events (order_id)
  WHERE kpi_code = 'NOO' AND event_type = 'CREDITED';

COMMENT ON INDEX uq_skae_noo_credited_once_per_order IS
  'Gate P4.05: menggantikan uq_skae_noo_credited_once (scope customer_id, 1x seumur hidup tanpa syarat). Scope baru order_id, pola identik uq_skae_order_count_credited_once/uq_skae_revenue_credited_once -- retry protection per-order, BUKAN lagi larangan permanen per-customer. "Hanya satu kredit NOO customer yang aktif" dijamin oleh advisory lock per-customer + live status check di credit_noo_for_sales_order (keduanya tidak diubah gate ini), bukan lagi oleh index ini.';

-- ---------------------------------------------------------------------------
-- 1b. Fix idempotency_key crediting: `'noo:' || customer_id` (asal,
--     20260930000001) TERNYATA customer-scoped, BUKAN order-scoped seperti
--     ORDER_COUNT/REVENUE (`'order-count:' || order_id`). Ditemukan lewat
--     verifikasi manual (bukan asumsi) -- setelah reversal, order BERIKUTNYA
--     yang genuinely first-confirmed-live tetap GAGAL credit walau sudah
--     lolos guard uq_skae_noo_credited_once_per_order (bagian 1 di atas),
--     karena base UNIQUE constraint (company_id, idempotency_key) pada
--     tabel ini mem-block INSERT dengan key yang collide
--     (`noo:<customer_id>` sama utk order manapun customer yang sama) --
--     ON CONFLICT DO NOTHING diam-diam tidak insert apa pun. Fix: key
--     diganti order-scoped (`'noo:' || NEW.id::TEXT`), pola identik
--     ORDER_COUNT/REVENUE. Business logic (guard v_prior_confirmed_exists,
--     advisory lock) TIDAK berubah sama sekali -- murni memperbaiki key
--     supaya tidak collide lintas order.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.credit_noo_for_sales_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_business_date DATE;
  v_prior_confirmed_exists BOOLEAN;
BEGIN
  IF NEW.status <> 'confirmed' OR NEW.is_historical OR NEW.sales_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.company_id::TEXT || ':noo:' || NEW.customer_id::TEXT, 1
  ));

  SELECT EXISTS (
    SELECT 1 FROM public.sales_orders so
    WHERE so.customer_id = NEW.customer_id
      AND so.company_id = NEW.company_id
      AND so.status = 'confirmed'
      AND so.id <> NEW.id
  ) INTO v_prior_confirmed_exists;

  IF v_prior_confirmed_exists THEN
    RETURN NEW;
  END IF;

  v_business_date := (COALESCE(NEW.confirmed_at, NOW()) AT TIME ZONE 'Asia/Jakarta')::DATE;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, order_id, customer_id, idempotency_key, value, actor_type
  ) VALUES (
    NEW.company_id, NEW.sales_id, 'NOO', 'CREDITED', v_business_date,
    'SALES_ORDER', NEW.id, NEW.id, NEW.customer_id, 'noo:' || NEW.id::TEXT, 1, 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.credit_noo_for_sales_order() IS
  'Gate P4.05: idempotency_key diperbaiki jadi order-scoped (''noo:'' || order_id, dulu customer-scoped ''noo:'' || customer_id) supaya tidak collide lintas order milik customer yang sama -- root cause kenapa re-credit legitimate setelah reversal sempat gagal diam-diam saat verifikasi. Business logic (first-confirmed-live check, advisory lock per-customer) TIDAK berubah dari 20260930000001.';

-- ---------------------------------------------------------------------------
-- 2. Reversal trigger -- pola identik reverse_order_kpi_for_sales_order.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reverse_noo_for_sales_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event RECORD;
BEGIN
  IF NEW.status <> 'cancelled' OR OLD.status IS NOT DISTINCT FROM 'cancelled' THEN
    RETURN NEW;
  END IF;

  SELECT id, company_id, salesperson_id, business_date, order_id, customer_id, value
  INTO v_event
  FROM public.sales_kpi_achievement_events
  WHERE order_id = NEW.id
    AND kpi_code = 'NOO'
    AND event_type = 'CREDITED';

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.sales_kpi_achievement_events (
    company_id, salesperson_id, kpi_code, event_type, business_date,
    source_type, source_id, order_id, customer_id, idempotency_key, value,
    reversal_of_event_id, reversal_reason, actor_type
  ) VALUES (
    v_event.company_id, v_event.salesperson_id, 'NOO', 'REVERSED', v_event.business_date,
    'SALES_ORDER', NEW.id, v_event.order_id, v_event.customer_id,
    'noo-reversal:' || v_event.id::TEXT, v_event.value,
    v_event.id, 'Order pembuka toko dinyatakan tidak sah/dibatalkan melalui resolusi dispute/cancellation', 'SYSTEM'
  )
  ON CONFLICT (company_id, idempotency_key) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_orders_reverse_noo
  AFTER UPDATE OF status ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.reverse_noo_for_sales_order();

COMMENT ON FUNCTION public.reverse_noo_for_sales_order() IS
  'Gate P4.05: membalik kredit NOO (baris REVERSED baru, append-only, tidak pernah UPDATE/DELETE baris CREDITED asal) saat order yang mengkredit NOO dibatalkan. Dipasangkan dengan uq_skae_noo_credited_once_per_order (scope order_id) supaya customer yang sama bisa dikredit NOO lagi lewat order LAIN yang genuinely first-confirmed-live, tanpa membuka celah double-credit utk order yang sama.';
