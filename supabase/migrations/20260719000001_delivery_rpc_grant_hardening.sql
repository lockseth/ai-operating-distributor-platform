-- =============================================================================
-- Migration: Delivery RPC Grant Hardening
--
-- Pre-deployment gate audit (2026-07-16) menemukan CRITICAL gap: migration
-- 20260707000003_grant_schema_privileges.sql memberi `GRANT ALL ON ALL
-- ROUTINES IN SCHEMA public TO anon, authenticated, service_role` (plus
-- ALTER DEFAULT PRIVILEGES yang sama untuk routine masa depan) -- ini pola
-- standar Supabase (RLS sebagai satu-satunya boundary untuk tabel), TAPI dua
-- fungsi delivery adalah RPC MUTATING yang seharusnya HANYA dipanggil lewat
-- trusted server workflow (service role), bukan langsung oleh client:
--
-- 1. sync_sales_order_delivery_status() -- SECURITY DEFINER, tidak ada
--    pengecekan tenant/actor sama sekali di dalam fungsi. Karena SECURITY
--    DEFINER berjalan dengan privilege pemilik fungsi (bypass RLS), maka
--    TANPA REVOKE EXECUTE, seorang caller `anon` (TIDAK PERLU LOGIN SAMA
--    SEKALI) dapat memanggil RPC ini untuk sales_order_id tenant MANA PUN
--    dan memicu transisi status (confirmed->delivering tanpa syarat apa
--    pun, atau ->delivered bila data delivery sudah menutupi penuh) --
--    cross-tenant state mutation oleh unauthenticated caller.
--
-- 2. finalize_delivery_item_quantities() -- SECURITY INVOKER (default),
--    sehingga RLS delivery_items/sales_order_items MELINDUNGI dari akses
--    LINTAS TENANT. Namun seorang driver authenticated dengan izin
--    delivery.execute pada delivery miliknya sendiri tetap bisa memanggil
--    RPC ini LANGSUNG, melewati SELURUH alur Telegram (evidence wajib,
--    reason code wajib, delivery_events audit trail, owner_alerts) yang
--    hanya ditegakkan di lib/delivery/workflow.ts, bukan oleh RPC itu
--    sendiri -- integrity bypass dalam tenant yang sama.
--
-- Fix: REVOKE EXECUTE dari PUBLIC/anon/authenticated untuk kedua fungsi
-- mutating ini, GRANT EXECUTE hanya ke service_role (satu-satunya role yang
-- dipakai apps/web -- lihat lib/supabase/admin.ts, dipanggil dari
-- app/api/webhooks/telegram/route.ts dan lib/delivery/actions.ts).
--
-- get_outstanding_quantity() TIDAK direstriksi -- read-only (STABLE SQL),
-- SECURITY INVOKER, sudah dilindungi RLS tenant-scoped pada
-- sales_order_items & delivery_items, dan dipakai untuk validasi awal (UX)
-- yang wajar diakses authenticated. anon tetap mendapat NULL (RLS
-- memblokir tanpa auth.uid()), tidak ada kebocoran data.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.sync_sales_order_delivery_status(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sales_order_delivery_status(UUID)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.finalize_delivery_item_quantities(UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_delivery_item_quantities(UUID, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.sync_sales_order_delivery_status IS
  'Sinkronisasi atomic sales_orders.status (lifecycle agregat) dari agregat delivery_items.received_quantity lintas seluruh delivery attempt milik order. Idempoten -- aman dipanggil berulang (retry, multiple attempts). SECURITY DEFINER -- EXECUTE dibatasi ke service_role saja (lihat 20260719000001_delivery_rpc_grant_hardening.sql); TIDAK boleh diberikan ke anon/authenticated karena tidak ada pengecekan tenant internal.';

COMMENT ON FUNCTION public.finalize_delivery_item_quantities IS
  'Satu-satunya jalur penulisan quantity delivery_items pada finalize. Atomic (FOR UPDATE terkunci pada sales_order_items, urutan id konsisten) dan menolak (RAISE EXCEPTION QUANTITY_EXCEEDS_OUTSTANDING, tidak silent clamp) bila SUM received_quantity lintas delivery attempt akan melebihi sales_order_items.quantity. EXECUTE dibatasi ke service_role saja (lihat 20260719000001_delivery_rpc_grant_hardening.sql) -- meski RLS melindungi dari akses lintas tenant, panggilan langsung oleh authenticated driver akan melewati evidence/reason-code/audit-trail/owner-alert yang ditegakkan di lib/delivery/workflow.ts.';
