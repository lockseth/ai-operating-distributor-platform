-- =============================================================================
-- Sales Order Payment Terms -- immutability setelah confirmed (Founder
-- closure check 2026-07-23, melengkapi migration 20260812000003).
--
-- Aturan: payment_terms_days boleh diisi kapan pun SEBELUM/SAAT transisi
-- draft -> confirmed (mis. lewat SalesOrderTelegramRepository.confirmOrder()).
-- Begitu status sudah 'confirmed', payment_terms_days TIDAK BOLEH diubah
-- diam-diam lewat UPDATE langsung -- migration ini belum menyediakan
-- workflow revisi/audit resmi (di luar scope), jadi jalur satu-satunya yang
-- tersedia sekarang adalah PENOLAKAN, bukan revisi terkontrol. Pola sama
-- dengan prevent_delivery_number_mutation (migration 20260812000001).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.prevent_payment_terms_mutation_after_confirmed()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'confirmed' AND NEW.payment_terms_days IS DISTINCT FROM OLD.payment_terms_days THEN
    RAISE EXCEPTION 'PAYMENT_TERMS_DAYS_IMMUTABLE: sales_orders % sudah confirmed, payment_terms_days tidak dapat diubah langsung -- wajib lewat workflow revisi/audit (belum tersedia)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_sales_orders_payment_terms_immutable ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_payment_terms_immutable
  BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_terms_mutation_after_confirmed();
