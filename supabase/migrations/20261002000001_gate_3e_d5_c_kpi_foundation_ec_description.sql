-- =============================================================================
-- Gate 3E-D5-C — Perbarui deskripsi EFFECTIVE_CALL pada
-- initialize_sales_kpi_foundation supaya sesuai kontrak final Gate 3E-D5-B
-- (20261001000001): EC TIDAK LAGI wajib terhubung ke Sales Order.
--
-- CREATE OR REPLACE MURNI: body identik dengan versi live (20260930000001)
-- kecuali satu string deskripsi EFFECTIVE_CALL. Signature, RETURNS TABLE,
-- LANGUAGE, SECURITY DEFINER, search_path, kode KPI yang di-insert
-- (CALL/EFFECTIVE_CALL/ORDER_COUNT/REVENUE/NOO), ON CONFLICT target, audit
-- log, dan seluruh logika lain TIDAK berubah. Tidak ada perubahan GRANT/
-- REVOKE -- CREATE OR REPLACE mempertahankan grant existing.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.initialize_sales_kpi_foundation(
  p_company_id UUID,
  p_actor_id UUID
)
RETURNS TABLE(result_outcome TEXT, definition_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_role TEXT;
  v_inserted INTEGER := 0;
BEGIN
  SELECT r.name INTO v_actor_role
  FROM public.users u
  JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
  JOIN public.roles r ON r.id = ur.role_id
  WHERE u.id = p_actor_id
    AND u.company_id = p_company_id
    AND u.is_active = TRUE
    AND r.name IN ('owner','manager','super_admin')
  ORDER BY CASE r.name WHEN 'owner' THEN 1 WHEN 'super_admin' THEN 2 WHEN 'manager' THEN 3 END
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, 0;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::TEXT || ':sales-kpi-init', 1));

  INSERT INTO public.sales_kpi_definitions (
    company_id, code, name, description, unit, measurement_source,
    version, effective_from, created_by
  ) VALUES
    (
      p_company_id,
      'CALL',
      'Call',
      'Kunjungan operasional valid Salesman ke toko assignment/coverage.',
      'COUNT',
      'VALID_FIELD_VISIT',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'EFFECTIVE_CALL',
      'Effective Call',
      'Call valid yang melibatkan pertemuan dengan pihak toko serta aktivitas penjualan substantif -- dari Kunjungan Sales maupun dari Sales Order confirmed order_source FIELD_VISIT yang terhubung ke Call yang sama. Sales Order tidak wajib.',
      'COUNT',
      'CONFIRMED_FIELD_VISIT_ORDER',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'ORDER_COUNT',
      'Order Count',
      'Jumlah Sales Order confirmed pada periode ini -- semua channel/order_source (bukan hanya Telegram, bukan hanya FIELD_VISIT).',
      'COUNT',
      'CONFIRMED_SALES_ORDER_COUNT',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'REVENUE',
      'Revenue',
      'Total omzet (final_amount) Sales Order confirmed pada periode ini, dikurangi order yang dibatalkan -- semua channel/order_source.',
      'IDR',
      'CONFIRMED_SALES_ORDER_REVENUE',
      1,
      CURRENT_DATE,
      p_actor_id
    ),
    (
      p_company_id,
      'NOO',
      'NOO / Buka Toko Baru',
      'Jumlah toko baru produktif -- customer yang sales order confirmed PERTAMA KALInya jatuh pada periode ini, sepanjang histori tenant.',
      'COUNT',
      'FIRST_CONFIRMED_ORDER_PER_CUSTOMER',
      1,
      CURRENT_DATE,
      p_actor_id
    )
  ON CONFLICT (company_id, code, version) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted > 0 THEN
    INSERT INTO public.audit_logs (
      company_id, user_id, action, entity_type, entity_id, new_data,
      actor_type, event_category, module, source, outcome
    ) VALUES (
      p_company_id,
      p_actor_id,
      'sales_kpi.foundation_initialized',
      'sales_kpi_definitions',
      NULL,
      jsonb_build_object(
        'codes', jsonb_build_array('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE','NOO'),
        'definition_count', v_inserted,
        'ar_is_kpi', FALSE,
        'weighted_score_enabled', FALSE
      ),
      v_actor_role,
      'audit',
      'sales_kpi',
      'rpc',
      'success'
    );
  END IF;

  RETURN QUERY SELECT
    CASE WHEN v_inserted = 0 THEN 'already_initialized' ELSE 'initialized' END::TEXT,
    (
      SELECT COUNT(*)::INTEGER
      FROM public.sales_kpi_definitions d
      WHERE d.company_id = p_company_id
        AND d.superseded_at IS NULL
        AND d.code IN ('CALL','EFFECTIVE_CALL','ORDER_COUNT','REVENUE','NOO')
    );
END;
$$;
