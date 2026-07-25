-- =============================================================================
-- Gate 3A finding (Auth/RBAC/RLS -- user nonaktif): get_user_company_id()
-- (migration 20260626000004_rls_policies.sql), yang menjadi dasar HAMPIR
-- SELURUH RLS policy tenant-scoped (company_id = get_user_company_id()) DAN
-- kedua helper turunannya (user_has_permission/user_has_role, keduanya
-- memanggil get_user_company_id() untuk resolve company_id), TIDAK PERNAH
-- memeriksa users.is_active. User yang di-nonaktifkan (is_active = FALSE)
-- tapi sesi/JWT Supabase Auth-nya masih valid dan baris user_roles belum
-- dihapus TETAP lolos seluruh RLS policy generik yang bergantung pada
-- ketiga fungsi ini -- deaktivasi user TIDAK benar-benar mencabut akses di
-- level RLS (hanya beberapa RPC/kebijakan tertentu yang secara eksplisit
-- mengecek is_active inline, mis. audit_logs_select).
--
-- Fix minimal, satu titik pusat: get_user_company_id() mengembalikan NULL
-- untuk user nonaktif -- setiap perbandingan "company_id = NULL" (RLS
-- policy langsung) dan setiap JOIN "... = get_user_company_id()" di dalam
-- user_has_permission()/user_has_role() otomatis mengevaluasi ke
-- NULL/FALSE, menolak akses tanpa mengubah satu pun RLS policy/definisi
-- fungsi lain.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_company_id()
RETURNS UUID AS $$
  SELECT company_id FROM public.users WHERE id = auth.uid() AND is_active = TRUE
$$ LANGUAGE sql SECURITY DEFINER STABLE;
