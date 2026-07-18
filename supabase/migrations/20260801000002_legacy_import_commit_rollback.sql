-- =============================================================================
-- Legacy Data Onboarding & Import Foundation — atomic commit + safe rollback
-- (LANGKAH 9-12).
--
-- commit_import_batch(): satu transaksi PL/pgSQL per batch. Baris yang gagal
-- di tengah proses membatalkan SEMUA insert baris tsb (savepoint implisit
-- lewat BEGIN/EXCEPTION) tapi status FAILED tetap tersimpan di transaksi
-- luar -- tidak pernah meninggalkan half-import tanpa status, tidak pernah
-- membuat orphan (customers/customer_pics dihubungkan via FK CASCADE,
-- sales_orders/sales_order_items juga CASCADE).
--
-- rollback_import_batch(): hanya membalik entity yang DIBUAT/DIUBAH batch itu
-- sendiri (via committed_entity_id/committed_entity_table + pre_update_snapshot
-- untuk baris UPDATE). Menolak rollback bila entity sudah dirujuk transaksi
-- live baru di luar batch ini (order baru, delivery, atau PIC yang sudah
-- diverifikasi manual) -- mengembalikan daftar blocker, bukan memaksa hapus.
-- =============================================================================

ALTER TABLE public.import_batch_rows
  ADD COLUMN IF NOT EXISTS pre_update_snapshot JSONB;

COMMENT ON COLUMN public.import_batch_rows.pre_update_snapshot IS
  'Snapshot baris SEBELUM di-UPDATE oleh commit (hanya diisi saat proposed_action=UPDATE) -- dipakai rollback_import_batch untuk mengembalikan nilai asli.';

-- ---------------------------------------------------------------------------
-- commit_import_batch
-- ---------------------------------------------------------------------------

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
    -- Retry idempotent -- hasil yang sama, bukan commit kedua.
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
        -- Toko: cari yang sudah dibuat baris sebelumnya dalam batch yang sama
        -- (banyak PIC bisa merujuk satu toko), baru cek existing (UPDATE).
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
              -- import_batch_id/imported_at SENGAJA tidak ditimpa di sini --
              -- kolom itu berarti "dibuat oleh batch X", bukan "terakhir
              -- disentuh batch X". rollback_import_batch bergantung pada
              -- invarian ini untuk membedakan toko yang benar-benar dibuat
              -- batch ini (aman dihapus) vs toko existing yang hanya di-UPDATE
              -- (tidak boleh dihapus, hanya di-restore lewat pre_update_snapshot).
            WHERE id = v_row.detected_existing_id;
            v_customer_id := v_row.detected_existing_id;
            UPDATE public.import_batch_rows SET pre_update_snapshot = v_before WHERE id = v_row.id;
            v_updated := v_updated + 1;
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
            v_created := v_created + 1;
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
          v_updated := v_updated + 1;
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
          v_created := v_created + 1;
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
          v_updated := v_updated + 1;
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
          v_created := v_created + 1;
        END IF;

        UPDATE public.import_batch_rows
        SET committed_entity_id = v_ar_id, committed_entity_table = 'legacy_ar_invoices'
        WHERE id = v_row.id;

      ELSIF v_batch.import_type IN ('OPEN_ORDER', 'HISTORICAL_ORDER') THEN
        -- Order historis/open selalu CREATE baru (tidak ada semantik UPDATE
        -- order legacy -- order_number legacy dipakai apa adanya sebagai
        -- dedup key, baris duplikat sudah disaring jadi SKIP_DUPLICATE saat
        -- validasi).
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

        -- Trigger trg_sales_orders_update_customer sudah men-set
        -- customers.last_order_at = NOW() untuk status terminal -- dikoreksi
        -- di sini ke tanggal historis asli (tidak pernah dianggap order
        -- "baru saja terjadi").
        IF v_row.normalized_data ? 'order_date' AND NULLIF(v_row.normalized_data->>'order_date','') IS NOT NULL THEN
          UPDATE public.customers SET
            last_order_at = CASE
              WHEN last_order_at IS NULL OR last_order_at < (v_row.normalized_data->>'order_date')::TIMESTAMPTZ
              THEN (v_row.normalized_data->>'order_date')::TIMESTAMPTZ
              ELSE last_order_at
            END
          WHERE id = (v_row.normalized_data->>'customer_id')::UUID;
        END IF;

        UPDATE public.import_batch_rows
        SET committed_entity_id = v_order_id, committed_entity_table = 'sales_orders'
        WHERE id = v_row.id;
        v_created := v_created + 1;
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

-- ---------------------------------------------------------------------------
-- rollback_import_batch
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rollback_import_batch(
  p_company_id UUID,
  p_batch_id   UUID,
  p_actor_id   UUID,
  p_reason     TEXT
)
RETURNS TABLE(result_outcome TEXT, blockers JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_batch     public.import_batches%ROWTYPE;
  v_row       public.import_batch_rows%ROWTYPE;
  v_blockers  JSONB := '[]'::JSONB;
  v_customer_id UUID;
BEGIN
  IF p_reason IS NULL OR TRIM(p_reason) = '' THEN
    RETURN QUERY SELECT 'invalid_input'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.roles r ON r.id = ur.role_id
    WHERE u.id = p_actor_id AND u.company_id = p_company_id AND u.is_active = TRUE
      AND r.name IN ('owner','manager','admin','super_admin')
  ) THEN
    RETURN QUERY SELECT 'forbidden'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  SELECT * INTO v_batch FROM public.import_batches
  WHERE id = p_batch_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  IF v_batch.status = 'ROLLED_BACK' THEN
    RETURN QUERY SELECT 'already_rolled_back'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  IF v_batch.status != 'COMMITTED' THEN
    RETURN QUERY SELECT 'invalid_status'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  -- --- Kumpulkan blocker (tidak menghapus apa pun dulu) ---
  FOR v_row IN
    SELECT * FROM public.import_batch_rows
    WHERE batch_id = p_batch_id AND committed_entity_id IS NOT NULL
    ORDER BY row_number
  LOOP
    IF v_row.committed_entity_table = 'customer_pics' THEN
      IF EXISTS (
        SELECT 1 FROM public.customer_pics cp
        WHERE cp.id = v_row.committed_entity_id AND cp.validation_status != 'UNVERIFIED'
      ) THEN
        v_blockers := v_blockers || jsonb_build_object(
          'rowNumber', v_row.row_number, 'entityTable', 'customer_pics',
          'entityId', v_row.committed_entity_id, 'reason', 'PIC sudah diverifikasi/diubah statusnya'
        );
      END IF;
      SELECT customer_id INTO v_customer_id FROM public.customer_pics WHERE id = v_row.committed_entity_id;
      IF v_customer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.sales_orders so
        WHERE so.customer_id = v_customer_id AND so.import_batch_id IS DISTINCT FROM p_batch_id
      ) THEN
        v_blockers := v_blockers || jsonb_build_object(
          'rowNumber', v_row.row_number, 'entityTable', 'customers',
          'entityId', v_customer_id, 'reason', 'Toko sudah punya order live di luar batch ini'
        );
      END IF;

    ELSIF v_row.committed_entity_table = 'products' THEN
      IF EXISTS (SELECT 1 FROM public.sales_order_items soi WHERE soi.product_id = v_row.committed_entity_id) THEN
        v_blockers := v_blockers || jsonb_build_object(
          'rowNumber', v_row.row_number, 'entityTable', 'products',
          'entityId', v_row.committed_entity_id, 'reason', 'Produk sudah dipakai di order'
        );
      END IF;

    ELSIF v_row.committed_entity_table = 'sales_orders' THEN
      IF EXISTS (SELECT 1 FROM public.deliveries d WHERE d.sales_order_id = v_row.committed_entity_id) THEN
        v_blockers := v_blockers || jsonb_build_object(
          'rowNumber', v_row.row_number, 'entityTable', 'sales_orders',
          'entityId', v_row.committed_entity_id, 'reason', 'Order sudah punya delivery live'
        );
      END IF;
    END IF;
    -- legacy_ar_invoices: tidak ada downstream live reference di schema saat ini (tidak ada payment/collection module) -- selalu aman.
  END LOOP;

  IF jsonb_array_length(v_blockers) > 0 THEN
    RETURN QUERY SELECT 'blocked'::TEXT, v_blockers;
    RETURN;
  END IF;

  -- --- Tidak ada blocker: balikkan (hapus CREATE, restore UPDATE) ---
  FOR v_row IN
    SELECT * FROM public.import_batch_rows
    WHERE batch_id = p_batch_id AND committed_entity_id IS NOT NULL
    ORDER BY row_number DESC
  LOOP
    IF v_row.pre_update_snapshot IS NOT NULL THEN
      -- UPDATE row -- restore before-snapshot, jangan hapus (data existing sebelum import).
      IF v_row.committed_entity_table = 'customers' THEN
        UPDATE public.customers SET
          name = v_row.pre_update_snapshot->>'name', phone = v_row.pre_update_snapshot->>'phone',
          address = v_row.pre_update_snapshot->>'address', area = v_row.pre_update_snapshot->>'area',
          is_active = (v_row.pre_update_snapshot->>'is_active')::BOOLEAN,
          legacy_source_system = v_row.pre_update_snapshot->>'legacy_source_system',
          legacy_id = v_row.pre_update_snapshot->>'legacy_id',
          import_batch_id = NULLIF(v_row.pre_update_snapshot->>'import_batch_id','')::UUID,
          imported_at = NULLIF(v_row.pre_update_snapshot->>'imported_at','')::TIMESTAMPTZ
        WHERE id = v_row.committed_entity_id;
      ELSIF v_row.committed_entity_table = 'products' THEN
        UPDATE public.products SET
          name = v_row.pre_update_snapshot->>'name', unit = v_row.pre_update_snapshot->>'unit',
          price = (v_row.pre_update_snapshot->>'price')::NUMERIC,
          is_active = (v_row.pre_update_snapshot->>'is_active')::BOOLEAN,
          legacy_source_system = v_row.pre_update_snapshot->>'legacy_source_system',
          legacy_id = v_row.pre_update_snapshot->>'legacy_id',
          import_batch_id = NULLIF(v_row.pre_update_snapshot->>'import_batch_id','')::UUID
        WHERE id = v_row.committed_entity_id;
      ELSIF v_row.committed_entity_table = 'legacy_ar_invoices' THEN
        UPDATE public.legacy_ar_invoices SET
          invoice_date = (v_row.pre_update_snapshot->>'invoice_date')::DATE,
          due_date = NULLIF(v_row.pre_update_snapshot->>'due_date','')::DATE,
          original_amount = (v_row.pre_update_snapshot->>'original_amount')::NUMERIC,
          amount_paid = (v_row.pre_update_snapshot->>'amount_paid')::NUMERIC,
          outstanding_balance = (v_row.pre_update_snapshot->>'outstanding_balance')::NUMERIC,
          payment_terms = v_row.pre_update_snapshot->>'payment_terms',
          assigned_sales_id = NULLIF(v_row.pre_update_snapshot->>'assigned_sales_id','')::UUID
        WHERE id = v_row.committed_entity_id;
      END IF;
    ELSE
      -- CREATE row -- hapus. CASCADE menangani anak (customer_pics/sales_order_items).
      IF v_row.committed_entity_table = 'customer_pics' THEN
        DELETE FROM public.customer_pics WHERE id = v_row.committed_entity_id;
        -- Toko induk hanya dihapus jika toko itu sendiri dibuat oleh batch ini
        -- (import_batch_id = batch ini berarti "dibuat oleh batch ini" --
        -- lihat komentar di commit_import_batch; toko existing yang hanya
        -- di-UPDATE TIDAK menimpa import_batch_id, jadi tidak akan cocok di sini)
        -- dan semua PIC-nya sudah terhapus (toko bisa dipakai >1 baris PIC).
        DELETE FROM public.customers c
        WHERE c.import_batch_id = p_batch_id
          AND c.legacy_source_system = v_batch.source_system
          AND NOT EXISTS (SELECT 1 FROM public.customer_pics cp2 WHERE cp2.customer_id = c.id);
      ELSIF v_row.committed_entity_table IN ('products', 'legacy_ar_invoices', 'sales_orders') THEN
        EXECUTE format('DELETE FROM public.%I WHERE id = $1', v_row.committed_entity_table)
          USING v_row.committed_entity_id;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.import_batches SET
    status = 'ROLLED_BACK',
    rolled_back_at = NOW(),
    rollback_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_batch_id;

  INSERT INTO public.audit_logs (company_id, user_id, action, entity_type, entity_id, new_data)
  VALUES (p_company_id, p_actor_id, 'import.rolled_back', 'import_batches', p_batch_id,
    jsonb_build_object('reason', p_reason));

  RETURN QUERY SELECT 'rolled_back'::TEXT, NULL::JSONB;
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_import_batch(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollback_import_batch(UUID, UUID, UUID, TEXT) TO service_role;
