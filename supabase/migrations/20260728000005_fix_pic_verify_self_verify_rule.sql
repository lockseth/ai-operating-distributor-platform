-- =============================================================================
-- Fix: verify_customer_pic() — larangan self-verify terlalu ketat.
--
-- Requirement yang benar (Store & PIC Pre-Commit Reconciliation):
--   * Salesman TIDAK BOLEH memverifikasi PIC yang didaftarkannya sendiri --
--     tapi ini SUDAH ditegakkan sepenuhnya oleh role gate di atas (reviewer
--     wajib owner/manager/admin/super_admin; Salesman tidak pernah lolos
--     gate ini apa pun status created_by-nya).
--   * Admin/owner/manager yang berwenang BOLEH memverifikasi PIC meskipun
--     mereka sendiri yang membuat record PIC tersebut -- tenant kecil bisa
--     jadi hanya punya SATU admin/owner, mewajibkan reviewer kedua akan
--     membuat PIC tidak pernah bisa diverifikasi sama sekali di tenant
--     tersebut.
--
-- Root cause bug: baris "IF v_pic.created_by = p_reviewer_id THEN RETURN
-- self_verify_forbidden" memblokir SEMUA reviewer (termasuk admin/owner)
-- yang kebetulan sama dengan created_by, bukan hanya Salesman. Karena
-- Salesman terstruktur sudah tidak pernah lolos role gate, cek tambahan ini
-- HANYA berdampak pada admin/owner/manager -- justru kasus yang harus
-- diizinkan. Fix: hapus cek self_verify_forbidden sepenuhnya; role gate
-- sendirian sudah cukup dan tepat untuk menegakkan requirement di atas.
--
-- Alasan dan audit trail TETAP wajib untuk semua verification (p_reason
-- non-empty check tidak berubah).
-- Migration baru (bukan edit migration yang sudah diterapkan).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.verify_customer_pic(
  p_company_id UUID,
  p_customer_pic_id UUID,
  p_reviewer_id UUID,
  p_new_status TEXT,
  p_reason TEXT
)
RETURNS TABLE(result_outcome TEXT, new_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pic public.customer_pics%ROWTYPE;
BEGIN
  IF p_new_status NOT IN ('VERIFIED_BY_ADMIN', 'REVERIFY_REQUIRED', 'INACTIVE') THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::TEXT;
    RETURN;
  END IF;
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- Role gate: HANYA owner/manager/admin/super_admin yang lolos -- Salesman
  -- (termasuk Salesman yang mendaftarkan PIC ini sendiri) selalu berhenti
  -- di sini dengan 'forbidden'. Ini SATU-SATUNYA guard yang diperlukan untuk
  -- menegakkan "Salesman tidak boleh verifikasi PIC sendiri", sekaligus
  -- "actor tanpa permission ditolak" dan "cross-tenant ditolak" (company_id
  -- di JOIN membatasi pencarian ke tenant yang benar).
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_reviewer_id AND u.company_id = p_company_id AND u.is_active = TRUE
      AND r.name IN ('owner','manager','admin','super_admin')
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_pic FROM public.customer_pics WHERE id = p_customer_pic_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- (Cek self_verify_forbidden SENGAJA DIHAPUS -- lihat komentar migration.)

  UPDATE public.customer_pics
  SET validation_status = p_new_status, verified_by = p_reviewer_id, verified_at = NOW()
  WHERE id = p_customer_pic_id;

  INSERT INTO public.customer_pic_history (company_id, customer_pic_id, customer_id, change_type, field_name, old_value, new_value, reason, source, actor_id)
  VALUES (p_company_id, p_customer_pic_id, v_pic.customer_id, 'STATUS_CHANGED', 'validation_status', v_pic.validation_status, p_new_status, p_reason, 'ADMIN_DASHBOARD', p_reviewer_id);

  INSERT INTO public.customer_relationship_events (company_id, customer_id, customer_pic_id, event_type, severity, payload, actor_id)
  VALUES (
    p_company_id, v_pic.customer_id, p_customer_pic_id,
    CASE p_new_status
      WHEN 'VERIFIED_BY_ADMIN' THEN 'PIC_VERIFIED'
      WHEN 'REVERIFY_REQUIRED' THEN 'PIC_REVERIFY_REQUIRED'
      ELSE 'PIC_DEACTIVATED'
    END,
    CASE WHEN p_new_status = 'VERIFIED_BY_ADMIN' THEN 'info' ELSE 'medium' END,
    jsonb_build_object('old_status', v_pic.validation_status, 'new_status', p_new_status, 'reason', p_reason),
    p_reviewer_id
  );

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, old_data, new_data)
  VALUES (p_company_id, p_reviewer_id, 'customer_pic.verified', 'customer_pics', p_customer_pic_id,
    jsonb_build_object('validation_status', v_pic.validation_status),
    jsonb_build_object('validation_status', p_new_status, 'reason', p_reason));

  RETURN QUERY SELECT 'verified'::TEXT, p_new_status;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_customer_pic(UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_customer_pic(UUID, UUID, UUID, TEXT, TEXT)
  TO service_role;
