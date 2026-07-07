-- =============================================================================
-- Migration: Grant Schema Privileges
-- Grant standar Supabase untuk role API (anon/authenticated/service_role).
-- Di Supabase cloud grant ini terpasang otomatis; di local development
-- tabel yang dibuat via migration (role postgres) tidak mewarisinya.
-- Keamanan baris tetap ditegakkan oleh RLS di semua tabel.
-- =============================================================================

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES  IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
