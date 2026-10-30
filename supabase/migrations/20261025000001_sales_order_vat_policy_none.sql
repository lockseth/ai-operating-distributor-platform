-- =============================================================================
-- Kebijakan PPN order: TANPA PPN (keputusan Founder 2026-10-30)
--
-- Template invoice terkunci (23 Juli 2026) dan issue_invoice_atomic menagih
-- total_amount tanpa PPN, tetapi order sebelumnya menyimpan tax_amount 11% dan
-- final_amount ber-PPN (dipakai daftar order, dashboard Owner, KPI Revenue,
-- Business Guard). Akibatnya angka order != angka invoice.
--
-- Penegakan SATU titik (bukan menyalin ulang tiap RPC terkunci yang menghitung
-- 0.11): trigger BEFORE pada sales_orders memaksa tax_amount = 0 dan
-- final_amount = total_amount - discount_amount setiap kali INSERT, atau UPDATE
-- yang menyentuh total_amount/discount_amount (create/update/submit/decide/
-- confirm). Order lama yang hanya berganti status TIDAK disentuh -- angka
-- historisnya tetap (tidak mengubah KPI Revenue yang sudah terkredit).
--
-- Berlaku untuk semua tenant saat ini. Bila suatu tenant nanti butuh PPN,
-- tambahkan tarif per-company di sini (belum perlu: YAGNI).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_sales_order_vat_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.tax_amount   := 0;
  NEW.final_amount := NEW.total_amount - NEW.discount_amount;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_sales_order_vat_policy() IS
  'Kebijakan tanpa PPN: tax_amount=0, final_amount=total_amount-discount_amount saat total/diskon ditulis. Lihat header migration 20261025000001.';

DROP TRIGGER IF EXISTS trg_sales_orders_vat_policy ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_vat_policy
  BEFORE INSERT OR UPDATE OF total_amount, discount_amount ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sales_order_vat_policy();
