-- =============================================================================
-- Fix: PREVIEW DEDUP ACCURACY. commit_import_batch sebelumnya menghitung
-- v_created/v_updated per ENTITY BAWAH (mis. hanya toko yang dibuat/diupdate
-- untuk domain CUSTOMER_PIC), BUKAN per BARIS staging. Akibatnya untuk toko
-- dengan multi-PIC (1 toko + N baris PIC dalam satu batch), preview
-- menghitung N baris "CREATE" tapi commit_result.createdCount hanya
-- melaporkan 1 (toko-nya saja, PIC tidak pernah dihitung) -- preview dan
-- hasil commit TIDAK PERNAH sama persis, bukan sekadar beda kosmetik.
--
-- Fix: v_created/v_updated sekarang dihitung SATU KALI per baris staging
-- yang diproses (berdasarkan v_row.proposed_action), bukan per entity bawah
-- yang tersentuh. Invariant yang dijamin:
--   commit_result.createdCount + commit_result.updatedCount
--   == jumlah baris staging dengan proposed_action IN ('CREATE','UPDATE')
--   == batch.valid_rows + batch.warning_rows (baris yang lolos ke commit loop)
-- persis sama dengan apa yang ditampilkan preview.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.commit_import_batch(
  p_company_id UUID,
  p_batch_id   UUID,
  p_actor_id   UUID
)
RETURNS TABLE(result_outcome TEXT, detail TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_batch          public.import_batches%ROWTYPE;
  v_row            public.import_batch_rows%ROWTYPE;
  v_source_system  TEXT;
  v_customer_id    UUID;
  v_pic_id         UUID;
  v_product_id     UUID;
  v_ar_id          UUID;
  v_order_id       UUID;
  v_item           JSONB;
  v_pic_legacy_id  TEXT;
  v_created        INTEGER := 0;
  v_updated        INTEGER := 0;
  v_before         JSONB;
  v_last_order_before TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id AND u.company_id = p_company_id AND u.is_active = TRUE
      AND r.name IN ('owner','manager','admin','super_admin')
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_batch FROM public.import_batches
  WHERE id = p_batch_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_batch.status = 'COMMITTED' THEN
    RETURN QUERY SELECT 'already_committed'::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  IF v_batch.status NOT IN ('READY_TO_COMMIT', 'FAILED') THEN
    RETURN QUERY SELECT 'invalid_status'::TEXT, v_batch.status;
    RETURN;
  END IF;

  v_source_system := v_batch.source_system;

  BEGIN
    FOR v_row IN
      SELECT * FROM public.import_batch_rows
      WHERE batch_id = p_batch_id AND proposed_action IN ('CREATE','UPDATE')
      ORDER BY row_number
    LOOP
      IF v_batch.import_type = 'CUSTOMER_PIC' THEN
        SELECT id INTO v_customer_id FROM public.customers
        WHERE company_id = p_company_id AND legacy_source_system = v_source_system
          AND legacy_id = (v_row.normalized_data->>'store_legacy_code');

        IF v_customer_id IS NULL THEN
          IF v_row.proposed_action = 'UPDATE' AND v_row.detected_existing_id IS NOT NULL THEN
            SELECT to_jsonb(c.*) INTO v_before FROM public.customers c WHERE c.id = v_row.detected_existing_id;
            UPDATE public.customers SET
              name = COALESCE(NULLIF(v_row.normalized_data->>'store_name',''), name),
              phone = COALESCE(NULLIF(v_row.normalized_data->>'store_phone',''), phone),
              address = COALESCE(NULLIF(v_row.normalized_data->>'store_address',''), address),
              area = COALESCE(NULLIF(v_row.normalized_data->>'store_area',''), area),
              is_active = COALESCE((v_row.normalized_data->>'is_active')::BOOLEAN, is_active),
              legacy_source_system = v_source_system,
              legacy_id = v_row.normalized_data->>'store_legacy_code'
            WHERE id = v_row.detected_existing_id;
            v_customer_id := v_row.detected_existing_id;
            UPDATE public.import_batch_rows SET pre_update_snapshot = v_before WHERE id = v_row.id;
          ELSE
            INSERT INTO public.customers (
              company_id, code, name, phone, address, area, assigned_sales_id, is_active,
              legacy_source_system, legacy_id, import_batch_id, imported_at, created_by
            ) VALUES (
              p_company_id,
              COALESCE(NULLIF(v_row.normalized_data->>'store_legacy_code',''),
                'LEGACY-' || substring(replace(gen_random_uuid()::TEXT,'-','') FROM 1 FOR 10)),
              v_row.normalized_data->>'store_name',
              NULLIF(v_row.normalized_data->>'store_phone',''),
              NULLIF(v_row.normalized_data->>'store_address',''),
              NULLIF(v_row.normalized_data->>'store_area',''),
              NULLIF(v_row.normalized_data->>'assigned_sales_id','')::UUID,
              COALESCE((v_row.normalized_data->>'is_active')::BOOLEAN, TRUE),
              v_source_system, v_row.normalized_data->>'store_legacy_code', p_batch_id, NOW(), p_actor_id
            ) RETURNING id INTO v_customer_id;
          END IF;
        END IF;

        v_pic_legacy_id := COALESCE(
          NULLIF(v_row.normalized_data->>'pic_legacy_code',''),
          (v_row.normalized_data->>'store_legacy_code') || ':' || (v_row.normalized_data->>'pic_phone')
        );

        INSERT INTO public.customer_pics (
          company_id, customer_id, name, phone, email, roles, validation_status, created_by,
          legacy_source_system, legacy_id, import_batch_id, imported_at
        ) VALUES (
          p_company_id, v_customer_id, v_row.normalized_data->>'pic_name', v_row.normalized_data->>'pic_phone',
          NULLIF(v_row.normalized_data->>'pic_email',''),
          ARRAY(SELECT jsonb_array_elements_text(v_row.normalized_data->'pic_roles')),
          'UNVERIFIED', p_actor_id, v_source_system, v_pic_legacy_id, p_batch_id, NOW()
        ) RETURNING id INTO v_pic_id;

        UPDATE public.import_batch_rows
        SET committed_entity_id = v_pic_id, committed_entity_table = 'customer_pics'
        WHERE id = v_row.id;

      ELSIF v_batch.import_type = 'PRODUCT_PRICE' THEN
        IF v_row.proposed_action = 'UPDATE' AND v_row.detected_existing_id IS NOT NULL THEN
          SELECT to_jsonb(p.*) INTO v_before FROM public.products p WHERE p.id = v_row.detected_existing_id;
          UPDATE public.products SET
            name = COALESCE(NULLIF(v_row.normalized_data->>'name',''), name),
            unit = COALESCE(NULLIF(v_row.normalized_data->>'unit',''), unit),
            price = COALESCE((v_row.normalized_data->>'price')::NUMERIC, price),
            is_active = COALESCE((v_row.normalized_data->>'is_active')::BOOLEAN, is_active),
            legacy_source_system = v_source_system,
            legacy_id = v_row.normalized_data->>'product_legacy_code',
            import_batch_id = p_batch_id,
            imported_at = NOW()
          WHERE id = v_row.detected_existing_id;
          v_product_id := v_row.detected_existing_id;
          UPDATE public.import_batch_rows SET pre_update_snapshot = v_before WHERE id = v_row.id;
        ELSE
          INSERT INTO public.products (
            company_id, sku, name, unit, price, is_active,
            legacy_source_system, legacy_id, import_batch_id, imported_at, created_by
          ) VALUES (
            p_company_id, v_row.normalized_data->>'sku', v_row.normalized_data->>'name',
            COALESCE(NULLIF(v_row.normalized_data->>'unit',''), 'pcs'),
            COALESCE((v_row.normalized_data->>'price')::NUMERIC, 0),
            COALESCE((v_row.normalized_data->>'is_active')::BOOLEAN, TRUE),
            v_source_system, v_row.normalized_data->>'product_legacy_code', p_batch_id, NOW(), p_actor_id
          ) RETURNING id INTO v_product_id;
        END IF;

        UPDATE public.import_batch_rows
        SET committed_entity_id = v_product_id, committed_entity_table = 'products'
        WHERE id = v_row.id;

      ELSIF v_batch.import_type = 'OPEN_AR' THEN
        IF v_row.proposed_action = 'UPDATE' AND v_row.detected_existing_id IS NOT NULL THEN
          SELECT to_jsonb(a.*) INTO v_before FROM public.legacy_ar_invoices a WHERE a.id = v_row.detected_existing_id;
          UPDATE public.legacy_ar_invoices SET
            invoice_date = COALESCE((v_row.normalized_data->>'invoice_date')::DATE, invoice_date),
            due_date = NULLIF(v_row.normalized_data->>'due_date','')::DATE,
            original_amount = (v_row.normalized_data->>'original_amount')::NUMERIC,
            amount_paid = (v_row.normalized_data->>'amount_paid')::NUMERIC,
            outstanding_balance = (v_row.normalized_data->>'outstanding_balance')::NUMERIC,
            payment_terms = NULLIF(v_row.normalized_data->>'payment_terms',''),
            assigned_sales_id = NULLIF(v_row.normalized_data->>'assigned_sales_id','')::UUID,
            import_batch_id = p_batch_id,
            imported_at = NOW()
          WHERE id = v_row.detected_existing_id;
          v_ar_id := v_row.detected_existing_id;
          UPDATE public.import_batch_rows SET pre_update_snapshot = v_before WHERE id = v_row.id;
        ELSE
          INSERT INTO public.legacy_ar_invoices (
            company_id, customer_id, legacy_invoice_number, invoice_date, due_date,
            original_amount, amount_paid, outstanding_balance, payment_terms, assigned_sales_id,
            is_historical, legacy_source_system, legacy_id, import_batch_id, imported_at, created_by
          ) VALUES (
            p_company_id, (v_row.normalized_data->>'customer_id')::UUID,
            v_row.normalized_data->>'legacy_invoice_number',
            (v_row.normalized_data->>'invoice_date')::DATE,
            NULLIF(v_row.normalized_data->>'due_date','')::DATE,
            (v_row.normalized_data->>'original_amount')::NUMERIC,
            (v_row.normalized_data->>'amount_paid')::NUMERIC,
            (v_row.normalized_data->>'outstanding_balance')::NUMERIC,
            NULLIF(v_row.normalized_data->>'payment_terms',''),
            NULLIF(v_row.normalized_data->>'assigned_sales_id','')::UUID,
            TRUE, v_source_system, v_row.normalized_data->>'legacy_invoice_number',
            p_batch_id, NOW(), p_actor_id
          ) RETURNING id INTO v_ar_id;
        END IF;

        UPDATE public.import_batch_rows
        SET committed_entity_id = v_ar_id, committed_entity_table = 'legacy_ar_invoices'
        WHERE id = v_row.id;

      ELSIF v_batch.import_type IN ('OPEN_ORDER', 'HISTORICAL_ORDER') THEN
        SELECT last_order_at INTO v_last_order_before
        FROM public.customers WHERE id = (v_row.normalized_data->>'customer_id')::UUID;

        INSERT INTO public.sales_orders (
          company_id, order_number, customer_id, sales_id, status,
          total_amount, discount_amount, tax_amount, final_amount,
          delivery_date, is_historical, legacy_source_system, legacy_id,
          import_batch_id, imported_at, created_by
        ) VALUES (
          p_company_id,
          'LEGACY-' || (v_row.normalized_data->>'legacy_order_number'),
          (v_row.normalized_data->>'customer_id')::UUID,
          NULLIF(v_row.normalized_data->>'sales_id','')::UUID,
          v_row.normalized_data->>'status',
          COALESCE((v_row.normalized_data->>'total_amount')::NUMERIC, 0),
          COALESCE((v_row.normalized_data->>'discount_amount')::NUMERIC, 0),
          0,
          COALESCE((v_row.normalized_data->>'final_amount')::NUMERIC, 0),
          NULLIF(v_row.normalized_data->>'order_date','')::DATE,
          TRUE, v_source_system, v_row.normalized_data->>'legacy_order_number',
          p_batch_id, NOW(), p_actor_id
        ) RETURNING id INTO v_order_id;

        FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_row.normalized_data->'items', '[]'::jsonb)) LOOP
          INSERT INTO public.sales_order_items (
            order_id, product_id, quantity, unit_price, discount_amount, total_amount, legacy_outstanding_quantity
          ) VALUES (
            v_order_id, (v_item->>'product_id')::UUID,
            (v_item->>'quantity')::INTEGER, (v_item->>'unit_price')::NUMERIC,
            COALESCE((v_item->>'discount_amount')::NUMERIC, 0),
            (v_item->>'total_amount')::NUMERIC,
            NULLIF(v_item->>'legacy_outstanding_quantity','')::NUMERIC
          );
        END LOOP;

        IF v_row.normalized_data ? 'order_date' AND NULLIF(v_row.normalized_data->>'order_date','') IS NOT NULL THEN
          UPDATE public.customers SET
            last_order_at = CASE
              WHEN v_last_order_before IS NULL OR v_last_order_before < (v_row.normalized_data->>'order_date')::TIMESTAMPTZ
              THEN (v_row.normalized_data->>'order_date')::TIMESTAMPTZ
              ELSE v_last_order_before
            END
          WHERE id = (v_row.normalized_data->>'customer_id')::UUID;
        END IF;

        UPDATE public.import_batch_rows
        SET committed_entity_id = v_order_id, committed_entity_table = 'sales_orders'
        WHERE id = v_row.id;
      END IF;

      -- Hitung SATU KALI per baris staging (bukan per entity bawah yang
      -- tersentuh) -- ini yang menjamin createdCount+updatedCount persis
      -- sama dengan jumlah baris yang preview tampilkan sebagai CREATE/UPDATE.
      IF v_row.proposed_action = 'CREATE' THEN
        v_created := v_created + 1;
      ELSIF v_row.proposed_action = 'UPDATE' THEN
        v_updated := v_updated + 1;
      END IF;
    END LOOP;

  EXCEPTION WHEN OTHERS THEN
    UPDATE public.import_batches SET
      status = 'FAILED',
      failure_reason = SQLERRM,
      updated_at = NOW()
    WHERE id = p_batch_id;

    INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
    VALUES (p_company_id, p_actor_id, 'import.failed', 'import_batches', p_batch_id,
      jsonb_build_object('error', SQLERRM));

    RETURN QUERY SELECT 'failed'::TEXT, SQLERRM;
    RETURN;
  END;

  UPDATE public.import_batches SET
    status = 'COMMITTED',
    committed_at = NOW(),
    commit_result = jsonb_build_object('createdCount', v_created, 'updatedCount', v_updated),
    updated_at = NOW()
  WHERE id = p_batch_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, p_actor_id, 'import.committed', 'import_batches', p_batch_id,
    jsonb_build_object('createdCount', v_created, 'updatedCount', v_updated, 'importType', v_batch.import_type));

  RETURN QUERY SELECT 'committed'::TEXT, NULL::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.commit_import_batch(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_import_batch(UUID, UUID, UUID) TO service_role;
