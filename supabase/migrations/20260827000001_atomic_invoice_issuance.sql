-- =============================================================================
-- Migration: Atomic Invoice Issuance (Gate 2B)
--
-- Menutup Gate 2A ("Belum ada jalur produksi -- RPC atomik issue_invoice()")
-- dengan SATU boundary transaksi database: issue_invoice_atomic(). Ini
-- menjadi satu-satunya jalur resmi yang boleh:
--   1. Menerbitkan issued_documents (document_type='INVOICE', status='active')
--      lewat record_issued_document() (migration 20260812000002) -- snapshot
--      dibangun DI SINI, server-side, dari delivery_items.received_quantity +
--      sales_order_items (invariant #3 AODP_FINANCIAL_CONTRACT.md).
--   2. Memateralisasikan invoices + invoice_lines (migration 20260826000001)
--      dari snapshot yang SAMA PERSIS -- trigger Gate 2A (validate_invoice_
--      tenant/validate_invoice_line_tenant) menegakkan kesamaan ini sebagai
--      lapisan kedua, independen dari kebenaran fungsi ini.
--   3. Mencatat SATU opening debit di receivable_ledger (kontrak invariant
--      #2 -- piutang lahir hanya dari invoice resmi).
--   4. Mentransisikan sales_orders.status 'delivered' -> 'invoiced' --
--      jalur SATU-SATUNYA yang boleh melakukan ini (guard 20260825000001
--      sudah mengunci update_sales_order_status_atomic dari status ini,
--      persis menunggu fungsi ini).
-- Seluruhnya dalam SATU transaksi PL/pgSQL -- gagal di langkah mana pun
-- (termasuk trigger Gate 2A yang menolak insert) me-rollback SEMUANYA
-- (issued_documents, invoices, invoice_lines, receivable_ledger, status
-- order) tanpa efek samping apa pun (jaminan atomicity bawaan Postgres
-- function body, tidak butuh savepoint eksplisit).
--
-- Keputusan desain (diturunkan dari schema Gate 2A yang sudah dikunci, BUKAN
-- keputusan bisnis baru):
--   - invoices.delivery_id NOT NULL UNIQUE dan issued_documents (INVOICE)
--     mewajibkan source_delivery_id NOT NULL -- schema HANYA mendukung SATU
--     delivery per invoice. Fungsi ini karena itu menolak
--     (MULTI_DELIVERY_INVOICING_NOT_SUPPORTED) order yang cakupan
--     'delivered'-nya berasal dari LEBIH DARI SATU delivery attempt --
--     skenario itu butuh keputusan bisnis eksplisit (agregasi/pemecahan
--     invoice lintas delivery) yang belum ada di kontrak atau schema mana
--     pun, di luar scope gate ini.
--   - Order harus berstatus 'delivered' (lifecycle agregat, lihat
--     sync_sales_order_delivery_status, migration 20260717000001) DAN hanya
--     SATU delivery yang berkontribusi received_quantity > 0. Kombinasi
--     keduanya secara struktural MEMAKSA setiap delivery_items.received_
--     quantity pada delivery tsb SAMA PERSIS dengan sales_order_items.
--     quantity (agregat 'delivered' mensyaratkan SUM(received) >= ordered
--     lintas SEMUA delivery; CHECK per-baris delivery_items menjamin
--     received <= dispatched <= ordered; satu delivery yang berkontribusi
--     berarti SUM = baris itu sendiri) -- sehingga TIDAK ADA kuantitas
--     parsial yang butuh proration discount_amount. discount_amount/
--     unit_price disalin APA ADANYA dari sales_order_items (bukan
--     diprorata) -- proration hanya relevan untuk skenario multi-delivery
--     yang sudah ditolak di atas.
--   - line_total dihitung ulang (quantity * unit_price - discount_amount)
--     mengikuti formula CHECK invoice_lines, BUKAN disalin dari
--     sales_order_items.total_amount (kolom itu tidak punya CHECK formula
--     sendiri di schema existing -- menghitung ulang di sini mencegah
--     invoice_lines mewarisi kesalahan data upstream).
--   - Snapshot yang dibangun di sini mengikuti bentuk yang SAMA dengan
--     fixture uji Gate 2A (receivable-ledger-foundation.integration.test.ts)
--     -- documentType/documentNumber/documentDate/companyId/orderReference/
--     deliveryReference/paymentTermsDays/lines[]/totals/generatedAt.
--     Field tenant/store/salesman/signatures pada DocumentSnapshot TS
--     (lib/document-engine/types.ts) SENGAJA tidak diisi -- field itu tidak
--     divalidasi trigger Gate 2A mana pun dan hanya relevan untuk cetak/PDF
--     invoice, yang eksplisit OUT OF SCOPE gate ini.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.issue_invoice_atomic(
  p_company_id UUID,
  p_actor_id   UUID,
  p_order_id   UUID
) RETURNS TABLE(
  out_invoice_id          UUID,
  out_invoice_number      TEXT,
  out_issued_document_id  UUID,
  out_receivable_ledger_id UUID,
  out_total_amount        NUMERIC,
  out_order_status        VARCHAR
) AS $$
DECLARE
  v_actor_allowed        BOOLEAN;
  v_order_company_id     UUID;
  v_order_status         VARCHAR;
  v_order_number         VARCHAR;
  v_order_customer_id    UUID;
  v_order_payment_terms  INTEGER;
  v_delivery_ids         UUID[];
  v_delivery_id          UUID;
  v_delivery_reference   TEXT;
  v_soi_count            INTEGER;
  v_line_count           INTEGER;
  v_subtotal             NUMERIC(15,2);
  v_discount             NUMERIC(15,2);
  v_grand_total          NUMERIC(15,2);
  v_lines_snapshot       JSONB;
  v_business_date        DATE;
  v_due_date             DATE;
  v_document_number      TEXT;
  v_snapshot             JSONB;
  v_issued_document_id   UUID;
  v_invoice_id           UUID;
  v_ledger_id            UUID;
  v_inserted_lines       INTEGER;
  v_lines_total_check    NUMERIC(15,2);
BEGIN
  -- -------------------------------------------------------------------------
  -- 1. Actor/tenant/permission -- pola identik update_sales_order_status_atomic.
  -- -------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND perm.name = 'invoice.issue'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RAISE EXCEPTION 'FORBIDDEN: actor % tidak memiliki permission invoice.issue pada company %', p_actor_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- -------------------------------------------------------------------------
  -- 2. Lock + validasi source order. FOR UPDATE menyerialisasi seluruh
  --    percobaan issuance konkuren untuk order yang sama di sini.
  -- -------------------------------------------------------------------------
  SELECT company_id, status, order_number, customer_id, payment_terms_days
  INTO v_order_company_id, v_order_status, v_order_number, v_order_customer_id, v_order_payment_terms
  FROM public.sales_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND: %', p_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_order_company_id <> p_company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: order % bukan milik company %', p_order_id, p_company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_order_status <> 'delivered' THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATE: order % berstatus %, invoice hanya dapat diterbitkan dari status delivered', p_order_id, v_order_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_order_customer_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_CUSTOMER_REQUIRED: order % tidak memiliki customer_id -- invoice tidak dapat diterbitkan untuk order tanpa customer master', p_order_id
      USING ERRCODE = 'not_null_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE sales_order_id = p_order_id) THEN
    RAISE EXCEPTION 'ORDER_ALREADY_INVOICED: order % sudah memiliki invoice', p_order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- 3. Tentukan delivery sumber -- WAJIB tepat satu delivery yang
  --    berkontribusi received_quantity > 0 (lihat catatan desain di atas).
  -- -------------------------------------------------------------------------
  SELECT ARRAY_AGG(DISTINCT d.id) INTO v_delivery_ids
  FROM public.deliveries d
  JOIN public.delivery_items di ON di.delivery_id = d.id
  WHERE d.sales_order_id = p_order_id
    AND d.company_id = p_company_id
    AND di.received_quantity > 0;

  IF v_delivery_ids IS NULL OR array_length(v_delivery_ids, 1) = 0 THEN
    RAISE EXCEPTION 'NO_BILLABLE_LINES: order % tidak memiliki delivery_items dengan received_quantity > 0', p_order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF array_length(v_delivery_ids, 1) > 1 THEN
    RAISE EXCEPTION 'MULTI_DELIVERY_INVOICING_NOT_SUPPORTED: order % dicakup lebih dari satu delivery (%), belum didukung gate ini', p_order_id, array_length(v_delivery_ids, 1)
      USING ERRCODE = 'feature_not_supported';
  END IF;
  v_delivery_id := v_delivery_ids[1];

  -- Kunci delivery juga -- konsisten dengan pola lock berurutan repository
  -- (order lalu delivery), mencegah issue_delivery_note()/finalize lain
  -- menyisipkan perubahan di tengah transaksi ini.
  PERFORM 1 FROM public.deliveries WHERE id = v_delivery_id FOR UPDATE;

  SELECT COALESCE(delivery_number, id::text) INTO v_delivery_reference
  FROM public.deliveries WHERE id = v_delivery_id;

  -- -------------------------------------------------------------------------
  -- 4. Completeness pre-check -- SETIAP sales_order_item milik order ini
  --    wajib punya baris delivery_item eligible pada delivery terpilih DAN
  --    received_quantity harus SAMA PERSIS dengan quantity order (dijamin
  --    struktural oleh status='delivered' + single-delivery di atas -- di
  --    sini diverifikasi eksplisit, bukan diasumsikan).
  -- -------------------------------------------------------------------------
  SELECT COUNT(*) INTO v_soi_count
  FROM public.sales_order_items
  WHERE order_id = p_order_id;

  IF EXISTS (
    SELECT 1
    FROM public.sales_order_items soi
    LEFT JOIN public.delivery_items di
      ON di.sales_order_item_id = soi.id AND di.delivery_id = v_delivery_id
    WHERE soi.order_id = p_order_id
      AND (di.id IS NULL OR di.received_quantity IS DISTINCT FROM soi.quantity)
  ) THEN
    RAISE EXCEPTION 'INCOMPLETE_DELIVERY_COVERAGE: order % memiliki sales_order_item yang belum sepenuhnya diterima pada delivery %', p_order_id, v_delivery_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- 5. Hitung baris eligible + totals (SEKALI, dipakai untuk snapshot,
  --    invoice header, dan invoice_lines -- data sudah terkunci di atas,
  --    deterministik untuk sisa transaksi ini).
  -- -------------------------------------------------------------------------
  SELECT
    jsonb_agg(
      jsonb_build_object(
        'no', ln.rn,
        'productCode', ln.product_code,
        'productName', ln.product_name,
        'productType', NULL,
        'unit', ln.unit,
        'quantity', ln.quantity,
        'unitPrice', ln.unit_price,
        'discountAmount', ln.discount_amount,
        'lineTotal', ln.line_total
      ) ORDER BY ln.rn
    ),
    SUM(ln.quantity * ln.unit_price),
    SUM(ln.discount_amount),
    SUM(ln.line_total),
    COUNT(*)
  INTO v_lines_snapshot, v_subtotal, v_discount, v_grand_total, v_line_count
  FROM (
    SELECT
      ROW_NUMBER() OVER (ORDER BY soi.id) AS rn,
      p.sku AS product_code,
      COALESCE(p.name, soi.product_name_raw) AS product_name,
      COALESCE(soi.unit, p.unit) AS unit,
      di.received_quantity AS quantity,
      soi.unit_price AS unit_price,
      soi.discount_amount AS discount_amount,
      (di.received_quantity * soi.unit_price) - soi.discount_amount AS line_total
    FROM public.delivery_items di
    JOIN public.sales_order_items soi ON soi.id = di.sales_order_item_id
    LEFT JOIN public.products p ON p.id = soi.product_id
    WHERE di.delivery_id = v_delivery_id
      AND di.received_quantity > 0
  ) ln;

  IF v_line_count IS NULL OR v_line_count = 0 THEN
    RAISE EXCEPTION 'NO_BILLABLE_LINES: delivery % tidak memiliki baris eligible', v_delivery_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_line_count <> v_soi_count THEN
    RAISE EXCEPTION 'INCOMPLETE_ORDER_LINE_COVERAGE: order % memiliki % order item tapi hanya % baris eligible pada delivery %', p_order_id, v_soi_count, v_line_count, v_delivery_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- 6. Nomor dokumen + snapshot -- primitive canonical (allocate_document_
  --    number, validate_company_profile_complete) yang sama dengan
  --    issue_delivery_note() (migration 20260812000001).
  -- -------------------------------------------------------------------------
  PERFORM public.validate_company_profile_complete(p_company_id);

  v_business_date := (NOW() AT TIME ZONE 'Asia/Jakarta')::DATE;
  v_document_number := public.allocate_document_number(p_company_id, 'INVOICE', v_business_date);

  IF v_order_payment_terms IS NOT NULL THEN
    v_due_date := v_business_date + v_order_payment_terms;
  ELSE
    v_due_date := NULL;
  END IF;

  v_snapshot := jsonb_build_object(
    'documentType', 'INVOICE',
    'documentNumber', v_document_number,
    'documentDate', to_char(v_business_date, 'YYYY-MM-DD'),
    'companyId', p_company_id,
    'orderReference', v_order_number,
    'deliveryReference', v_delivery_reference,
    'paymentTermsDays', v_order_payment_terms,
    'lines', v_lines_snapshot,
    'totals', jsonb_build_object(
      'subtotal', v_subtotal,
      'totalDiscount', v_discount,
      'grandTotal', v_grand_total
    ),
    'generatedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  -- -------------------------------------------------------------------------
  -- 7. Terbitkan issued_documents (satu-satunya jalur: record_issued_document).
  -- -------------------------------------------------------------------------
  SELECT rid.out_id INTO v_issued_document_id
  FROM public.record_issued_document(
    p_company_id, 'INVOICE', p_order_id, v_delivery_id, v_document_number, v_snapshot, p_actor_id, NULL
  ) rid;

  -- -------------------------------------------------------------------------
  -- 8. Invoice header -- trigger trg_invoices_tenant (Gate 2A) memvalidasi
  --    ulang kesamaan dengan issued_documents.snapshot secara independen.
  -- -------------------------------------------------------------------------
  INSERT INTO public.invoices (
    company_id, issued_document_id, invoice_number, sales_order_id, delivery_id, customer_id,
    currency, issued_at, due_date, subtotal_amount, discount_amount, total_amount
  ) VALUES (
    p_company_id, v_issued_document_id, v_document_number, p_order_id, v_delivery_id, v_order_customer_id,
    'IDR', NOW(), v_due_date, v_subtotal, v_discount, v_grand_total
  )
  RETURNING id INTO v_invoice_id;

  -- -------------------------------------------------------------------------
  -- 9. Materialisasi invoice_lines -- set-based INSERT ... SELECT dari query
  --    yang SAMA PERSIS dengan langkah 5 (data terkunci, deterministik).
  --    Trigger trg_invoice_lines_tenant (Gate 2A) memvalidasi ulang tiap
  --    baris terhadap snapshot secara independen.
  -- -------------------------------------------------------------------------
  INSERT INTO public.invoice_lines (
    invoice_id, company_id, line_no, sales_order_item_id, delivery_item_id,
    product_id, product_code, product_name, unit, quantity, unit_price, discount_amount, line_total
  )
  SELECT
    v_invoice_id,
    p_company_id,
    ROW_NUMBER() OVER (ORDER BY soi.id),
    soi.id,
    di.id,
    soi.product_id,
    p.sku,
    COALESCE(p.name, soi.product_name_raw),
    COALESCE(soi.unit, p.unit),
    di.received_quantity,
    soi.unit_price,
    soi.discount_amount,
    (di.received_quantity * soi.unit_price) - soi.discount_amount
  FROM public.delivery_items di
  JOIN public.sales_order_items soi ON soi.id = di.sales_order_item_id
  LEFT JOIN public.products p ON p.id = soi.product_id
  WHERE di.delivery_id = v_delivery_id
    AND di.received_quantity > 0;

  GET DIAGNOSTICS v_inserted_lines = ROW_COUNT;
  IF v_inserted_lines <> v_line_count THEN
    RAISE EXCEPTION 'INVOICE_LINE_MATERIALIZATION_INCOMPLETE: invoice % mengharapkan % baris, hanya % ter-insert', v_invoice_id, v_line_count, v_inserted_lines
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Assertion eksplisit nilai materialisasi -- tidak berasumsi INSERT ...
  -- SELECT selalu lengkap/benar (instruksi gate), independen dari CHECK/
  -- trigger Gate 2A yang sudah menegakkan ini di level baris.
  SELECT COUNT(*), COALESCE(SUM(line_total), 0) INTO v_inserted_lines, v_lines_total_check
  FROM public.invoice_lines WHERE invoice_id = v_invoice_id;
  IF v_inserted_lines <> v_line_count OR v_lines_total_check <> v_grand_total THEN
    RAISE EXCEPTION 'INVOICE_LINE_TOTAL_MISMATCH: invoice % SUM(line_total)=% tidak sama dengan total_amount=%', v_invoice_id, v_lines_total_check, v_grand_total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- -------------------------------------------------------------------------
  -- 10. Opening debit receivable_ledger -- trigger trg_receivable_ledger_
  --     tenant (Gate 2A) memvalidasi ulang amount == invoices.total_amount;
  --     uq_receivable_ledger_one_opening_debit mencegah duplikasi.
  -- -------------------------------------------------------------------------
  INSERT INTO public.receivable_ledger (company_id, invoice_id, entry_type, direction, amount, created_by)
  VALUES (p_company_id, v_invoice_id, 'invoice_issued', 'debit', v_grand_total, p_actor_id)
  RETURNING id INTO v_ledger_id;

  -- -------------------------------------------------------------------------
  -- 11. Transisi status order -- SATU-SATUNYA jalur ke 'invoiced' (guard
  --     20260825000001 mengunci update_sales_order_status_atomic dari
  --     status ini persis untuk menunggu fungsi ini).
  -- -------------------------------------------------------------------------
  UPDATE public.sales_orders SET status = 'invoiced' WHERE id = p_order_id;

  -- -------------------------------------------------------------------------
  -- 12. Audit canonical -- pola sama dengan update_sales_order_status_atomic.
  -- -------------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'invoice.issued', 'invoices', v_invoice_id,
    jsonb_build_object('sales_order_id', p_order_id, 'sales_order_status', 'delivered'),
    jsonb_build_object('invoice_id', v_invoice_id, 'invoice_number', v_document_number, 'total_amount', v_grand_total, 'sales_order_status', 'invoiced'),
    NULL, 'audit', 'finance', 'web', 'success'
  );

  RETURN QUERY SELECT v_invoice_id, v_document_number, v_issued_document_id, v_ledger_id, v_grand_total, 'invoiced'::VARCHAR;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.issue_invoice_atomic IS
  'Satu-satunya jalur resmi penerbitan invoice (Gate 2B). Atomic: issued_documents (record_issued_document) + invoices + invoice_lines + receivable_ledger opening debit + transisi sales_orders.status delivered->invoiced dalam SATU transaksi -- gagal di langkah mana pun me-rollback seluruhnya. Menolak: FORBIDDEN (permission invoice.issue), ORDER_NOT_FOUND, TENANT_CONTEXT_MISMATCH, INVALID_ORDER_STATE (order bukan delivered), ORDER_CUSTOMER_REQUIRED, ORDER_ALREADY_INVOICED, NO_BILLABLE_LINES, MULTI_DELIVERY_INVOICING_NOT_SUPPORTED, INCOMPLETE_DELIVERY_COVERAGE/INCOMPLETE_ORDER_LINE_COVERAGE, INVOICE_LINE_MATERIALIZATION_INCOMPLETE/INVOICE_LINE_TOTAL_MISMATCH. Tidak menerima nominal/status apa pun dari caller -- seluruh nilai dihitung server-side dari delivery_items.received_quantity dan sales_order_items. Dipanggil hanya lewat service_role.';

REVOKE ALL ON FUNCTION public.issue_invoice_atomic(UUID, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_invoice_atomic(UUID, UUID, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- Permission -- 'invoice.issue', granted ke role finance yang sama dengan
-- 'receivable.view' (migration 20260826000001) MINUS 'sales' (preseden
-- containment 20260825000001: sales tidak pernah boleh menerbitkan invoice).
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('invoice.issue', 'invoice', 'issue', 'Menerbitkan invoice canonical (issue_invoice_atomic) dari order berstatus delivered milik company sendiri')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')
  AND p.name = 'invoice.issue'
ON CONFLICT DO NOTHING;
