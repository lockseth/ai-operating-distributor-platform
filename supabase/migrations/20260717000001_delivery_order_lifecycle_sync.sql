-- =============================================================================
-- Migration: Sales Order Aggregate Lifecycle Sync
--
-- Gap-closure fix (commit 1adc2bb yang diaudit): sales_orders.status adalah
-- lifecycle AGREGAT order, terpisah dari deliveries.status (status per
-- delivery ATTEMPT, tetap dipertahankan apa adanya). Enum delivering/delivered
-- yang sudah ada sejak migration 003 tidak boleh menjadi dead state.
--
-- Fungsi ini SATU-SATUNYA jalur otomatis yang menyinkronkan status agregat
-- dari delivery — dipanggil dari lib/delivery/workflow.ts setelah dispatch
-- pertama dan setelah setiap finalize. Idempoten (menghitung ulang dari
-- sumber kebenaran setiap kali, bukan increment) dan atomic (FOR UPDATE
-- mengunci baris order selama komputasi, mencegah race condition saat lebih
-- dari satu delivery attempt untuk order yang sama di-finalize bersamaan).
--
-- Tidak menambah enum baru. Tidak mengganggu jalur manual StatusUpdater
-- (updateOrderStatusAction) yang sudah ada — itu tetap override manusia yang
-- valid dan independen dari sinkronisasi otomatis ini.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_sales_order_delivery_status(p_sales_order_id UUID)
RETURNS VARCHAR AS $$
DECLARE
  v_current_status  VARCHAR;
  v_fully_covered   BOOLEAN;
BEGIN
  -- Kunci baris order: dua delivery attempt yang finalize bersamaan untuk
  -- order yang sama akan diserialisasi di sini, bukan race saling menimpa.
  SELECT status INTO v_current_status
  FROM public.sales_orders
  WHERE id = p_sales_order_id
  FOR UPDATE;

  IF v_current_status IS NULL THEN
    RETURN NULL; -- order tidak ditemukan
  END IF;

  -- Hanya order yang sedang dalam siklus delivery yang disentuh. Status lain
  -- (draft, processing, invoiced, paid, cancelled, atau delivered yang sudah
  -- final) tidak pernah diubah mundur atau disilangkan oleh fungsi ini.
  IF v_current_status NOT IN ('confirmed', 'delivering') THEN
    RETURN v_current_status;
  END IF;

  -- Agregat lintas SELURUH delivery attempt milik order ini: apakah setiap
  -- sales_order_item sudah tertutup penuh oleh total received_quantity?
  -- Tidak ada double count -- setiap delivery_items row hanya dimutasi oleh
  -- attempt pemiliknya sendiri, SUM murni menjumlahkan apa yang benar-benar
  -- tercatat verified. Attempt yang gagal/ditolak/toko tutup otomatis
  -- berkontribusi 0 (received_quantity mereka memang 0 untuk item yang tidak
  -- diterima) -- tidak perlu pengecualian khusus.
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.sales_order_items soi
    WHERE soi.order_id = p_sales_order_id
      AND soi.quantity > COALESCE((
        SELECT SUM(di.received_quantity)
        FROM public.delivery_items di
        JOIN public.deliveries d ON d.id = di.delivery_id
        WHERE di.sales_order_item_id = soi.id
      ), 0)
  ) INTO v_fully_covered;

  IF v_fully_covered THEN
    UPDATE public.sales_orders SET status = 'delivered', delivered_at = COALESCE(delivered_at, NOW())
    WHERE id = p_sales_order_id;
    RETURN 'delivered';
  ELSIF v_current_status = 'confirmed' THEN
    -- Delivery pertama benar-benar mulai bergerak (dispatched) -- confirmed -> delivering.
    UPDATE public.sales_orders SET status = 'delivering' WHERE id = p_sales_order_id;
    RETURN 'delivering';
  ELSE
    -- Sudah 'delivering' dan belum tertutup penuh (partial / rejected /
    -- store_closed / failed / masih ada attempt berjalan) -- tetap terbuka,
    -- tidak pernah ditandai delivered.
    RETURN v_current_status;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.sync_sales_order_delivery_status IS
  'Sinkronisasi atomic sales_orders.status (lifecycle agregat) dari agregat delivery_items.received_quantity lintas seluruh delivery attempt milik order. Idempoten -- aman dipanggil berulang (retry, multiple attempts). Dipanggil dari lib/delivery/workflow.ts, tidak pernah dari client langsung.';
