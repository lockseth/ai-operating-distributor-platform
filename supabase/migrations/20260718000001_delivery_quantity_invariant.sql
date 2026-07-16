-- =============================================================================
-- Migration: Aggregate Delivery Quantity Invariant
--
-- Audit fix (commit acuan 400b114): dibuktikan live bahwa SUM
-- delivery_items.received_quantity lintas beberapa delivery attempt untuk
-- satu sales_order_item BISA melebihi sales_order_items.quantity tanpa
-- ditolak sama sekali (CHECK constraint yang ada di migration
-- 20260716000001 hanya per-baris, tidak lintas attempt). Contoh terbukti:
-- attempt A menerima 60/100, attempt B menerima 50/100 lagi -> total 110/100
-- diterima tanpa penolakan, dan order bahkan ditandai 'delivered'.
--
-- Fungsi ini SATU-SATUNYA jalur untuk menulis
-- received/rejected/returned/unresolved_quantity pada delivery_items --
-- atomic (row lock sales_order_items, urutan lock konsisten by id supaya
-- tidak deadlock), menolak (RAISE EXCEPTION, bukan silent clamp) bila
-- received_quantity yang diajukan melebihi outstanding (ordered dikurangi
-- total sudah diterima dari attempt LAIN yang sah).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.finalize_delivery_item_quantities(
  p_delivery_id UUID,
  p_item_outcomes JSONB -- [{delivery_item_id, received_quantity, rejected_quantity, returned_quantity, unresolved_quantity}]
) RETURNS JSONB AS $$
DECLARE
  v_item                JSONB;
  v_delivery_item_id     UUID;
  v_soi_id               UUID;
  v_ordered              NUMERIC;
  v_received_elsewhere   NUMERIC;
  v_outstanding          NUMERIC;
  v_new_received         NUMERIC;
  v_new_rejected         NUMERIC;
  v_new_returned         NUMERIC;
  v_new_unresolved       NUMERIC;
BEGIN
  -- Kunci seluruh sales_order_items yang terlibat LEBIH DULU, dalam urutan
  -- id yang konsisten -- mencegah deadlock antar finalize bersamaan pada
  -- delivery attempt berbeda yang menyentuh sales_order_item yang sama.
  PERFORM 1
  FROM public.sales_order_items soi
  WHERE soi.id IN (
    SELECT DISTINCT di.sales_order_item_id
    FROM public.delivery_items di
    WHERE di.id IN (
      SELECT (elem->>'delivery_item_id')::UUID
      FROM jsonb_array_elements(p_item_outcomes) elem
    )
  )
  ORDER BY soi.id
  FOR UPDATE;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_item_outcomes)
  LOOP
    v_delivery_item_id := (v_item->>'delivery_item_id')::UUID;
    v_new_received      := COALESCE((v_item->>'received_quantity')::NUMERIC, 0);
    v_new_rejected      := COALESCE((v_item->>'rejected_quantity')::NUMERIC, 0);
    v_new_returned      := COALESCE((v_item->>'returned_quantity')::NUMERIC, 0);
    v_new_unresolved    := COALESCE((v_item->>'unresolved_quantity')::NUMERIC, 0);

    SELECT di.sales_order_item_id INTO v_soi_id
    FROM public.delivery_items di
    WHERE di.id = v_delivery_item_id AND di.delivery_id = p_delivery_id;

    IF v_soi_id IS NULL THEN
      RAISE EXCEPTION 'DELIVERY_ITEM_NOT_FOUND: % bukan milik delivery %', v_delivery_item_id, p_delivery_id
        USING ERRCODE = 'no_data_found';
    END IF;

    SELECT soi.quantity INTO v_ordered
    FROM public.sales_order_items soi
    WHERE soi.id = v_soi_id;

    -- Total sudah diterima dari delivery attempt LAIN (baris ini sendiri
    -- dikecualikan) -- retry pada attempt yang sama dengan angka yang sama
    -- tetap idempotent, tidak pernah menabrak outstanding miliknya sendiri.
    SELECT COALESCE(SUM(di.received_quantity), 0) INTO v_received_elsewhere
    FROM public.delivery_items di
    WHERE di.sales_order_item_id = v_soi_id
      AND di.id <> v_delivery_item_id;

    v_outstanding := v_ordered - v_received_elsewhere;

    IF v_new_received > v_outstanding THEN
      RAISE EXCEPTION 'QUANTITY_EXCEEDS_OUTSTANDING'
        USING ERRCODE = 'check_violation',
              DETAIL = jsonb_build_object(
                'salesOrderItemId', v_soi_id,
                'outstanding', v_outstanding,
                'requested', v_new_received
              )::text;
    END IF;

    UPDATE public.delivery_items
    SET received_quantity   = v_new_received,
        rejected_quantity   = v_new_rejected,
        returned_quantity   = v_new_returned,
        unresolved_quantity = v_new_unresolved
    WHERE id = v_delivery_item_id;
  END LOOP;

  RETURN jsonb_build_object('ok', true);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.finalize_delivery_item_quantities IS
  'Satu-satunya jalur penulisan quantity delivery_items pada finalize. Atomic (FOR UPDATE terkunci pada sales_order_items, urutan id konsisten) dan menolak (RAISE EXCEPTION QUANTITY_EXCEEDS_OUTSTANDING, tidak silent clamp) bila SUM received_quantity lintas delivery attempt akan melebihi sales_order_items.quantity.';

-- ---------------------------------------------------------------------------
-- Helper read-only: outstanding quantity per sales_order_item (dipakai UI/
-- validasi awal & pembuatan delivery attempt baru -- lihat item 4 fix:
-- attempt baru default ke outstanding, bukan ordered_quantity asli).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_outstanding_quantity(p_sales_order_item_id UUID, p_exclude_delivery_item_id UUID DEFAULT NULL)
RETURNS NUMERIC AS $$
  SELECT soi.quantity - COALESCE((
    SELECT SUM(di.received_quantity)
    FROM public.delivery_items di
    WHERE di.sales_order_item_id = soi.id
      AND (p_exclude_delivery_item_id IS NULL OR di.id <> p_exclude_delivery_item_id)
  ), 0)
  FROM public.sales_order_items soi
  WHERE soi.id = p_sales_order_item_id
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION public.get_outstanding_quantity IS
  'Outstanding = ordered - total received dari delivery attempt lain. Read-only, dipakai untuk validasi awal (UX) dan default ordered_quantity delivery attempt baru. Sumber kebenaran otoritatif tetap finalize_delivery_item_quantities (atomic, locked).';
