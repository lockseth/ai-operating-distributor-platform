-- =============================================================================
-- Migration: Canonical Invoice & Receivable Ledger Foundation (Gate 2A)
--
-- Membangun fondasi SCHEMA-ONLY untuk segmen Invoice -> Collection sesuai
-- docs/product/finance/AODP_FINANCIAL_CONTRACT.md (freeze v1.0). Tidak ada
-- RPC penerbitan invoice, atomic writer, payment allocation, credit note,
-- atau UI pada migration ini -- lihat catatan "DEFERRED" di setiap section.
--
-- Reuse decision (Gate 2A audit, lihat laporan akhir untuk detail):
--   - issued_documents (document_type='INVOICE', status='active') TETAP
--     satu-satunya source of truth untuk snapshot dokumen (nominal/line/
--     harga/diskon per AODP_DOCUMENT_CONSTITUTION). invoices/invoice_lines
--     DI BAWAH BUKAN snapshot paralel yang bisa drift -- keduanya adalah
--     materialisasi QUERYABLE dari snapshot tsb, divalidasi SAMA DENGAN
--     issued_documents.snapshot pada saat INSERT (trigger di bawah) dan
--     tidak pernah bisa di-UPDATE sesudahnya (full immutability trigger),
--     sehingga tidak ada jalur drift.
--   - delivery_items.received_quantity tetap satu-satunya dasar kuantitas
--     tertagih (invariant #3 kontrak) -- ditegakkan trigger validasi baris.
--   - sales_orders/sales_orders.status TIDAK disentuh sama sekali di sini.
--
-- Tiga tabel baru:
--   1. invoices          -- entitas finansial "invoice", lahir 1:1 dari satu
--                            row issued_documents (INVOICE, active).
--   2. invoice_lines      -- baris queryable per delivery_item yang ditagih.
--   3. receivable_ledger  -- buku besar piutang append-only (debit/kredit).
--
-- Plus: view read-only invoice_receivable_balances (derived balance/status,
-- security_invoker) -- satu-satunya cara membaca saldo piutang.
--
-- DEFERRED ke Gate 2B/2C (TIDAK dikerjakan di sini, lihat laporan akhir):
--   - RPC atomik "issue_invoice()" (document snapshot + invoices +
--     invoice_lines + receivable_ledger opening debit dalam satu transaksi).
--   - Payment receipt/proof/allocation, reconciliation, credit note --
--     entitasnya belum ada; receivable_ledger.entry_type sengaja HANYA
--     mengizinkan 'invoice_issued' sekarang (lihat instruksi gate #13),
--     diperluas lewat ALTER CHECK migration terpisah saat entitasnya lahir.
--   - Revisi invoice (supersede) -- issued_documents sudah mendukung
--     versioning dokumen, tetapi bagaimana revisi memengaruhi invoices/
--     receivable_ledger BELUM diputuskan di sini. Struktur minimal saat ini:
--     invoices.issued_document_id UNIQUE + invoices.delivery_id UNIQUE
--     (satu invoice per delivery/issued_documents version). Revisi invoice
--     resmi adalah desain Gate 2B yang eksplisit di luar scope ini.
--   - Sinkronisasi sales_orders.status ('invoiced'/'paid') dari tabel ini --
--     tetap dikunci oleh 20260824000001/20260825000001, tidak diubah.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. invoices -- entitas finansial. Lahir 1:1 dari issued_documents
--    (document_type='INVOICE', status='active') yang sudah ada.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoices (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  issued_document_id  UUID          NOT NULL UNIQUE REFERENCES public.issued_documents (id) ON DELETE RESTRICT,
  invoice_number      TEXT          NOT NULL,
  sales_order_id      UUID          NOT NULL REFERENCES public.sales_orders (id) ON DELETE RESTRICT,
  delivery_id         UUID          NOT NULL UNIQUE REFERENCES public.deliveries (id) ON DELETE RESTRICT,
  customer_id         UUID          NOT NULL REFERENCES public.customers (id) ON DELETE RESTRICT,
  currency            VARCHAR(3)    NOT NULL DEFAULT 'IDR',
  issued_at           TIMESTAMPTZ   NOT NULL,
  due_date            DATE,
  subtotal_amount     NUMERIC(15,2) NOT NULL CHECK (subtotal_amount >= 0),
  discount_amount     NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total_amount        NUMERIC(15,2) NOT NULL CHECK (total_amount >= 0),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (subtotal_amount - discount_amount = total_amount),
  CHECK (due_date IS NULL OR due_date >= issued_at::date),
  UNIQUE (company_id, invoice_number)
);

CREATE INDEX idx_invoices_company_id     ON public.invoices (company_id, issued_at DESC);
CREATE INDEX idx_invoices_customer_id    ON public.invoices (customer_id);
CREATE INDEX idx_invoices_sales_order_id ON public.invoices (sales_order_id);

COMMENT ON TABLE public.invoices IS
  'Entitas finansial "invoice" (AODP_FINANCIAL_CONTRACT.md invariant #1/#2) -- lahir HANYA dari issued_documents (INVOICE, active) yang bersesuaian (issued_document_id UNIQUE, divalidasi trg_invoices_tenant). Immutable total penuh (trg_invoices_immutable) -- tidak ada UPDATE/DELETE sama sekali sesudah INSERT. Status finansial (outstanding/partially_paid/paid) TIDAK disimpan di sini -- lihat view invoice_receivable_balances.';
COMMENT ON COLUMN public.invoices.invoice_number IS
  'Disalin dari issued_documents.document_number pada saat INSERT (divalidasi sama persis oleh trigger) -- bukan dialokasikan ulang di sini, satu-satunya alokasi nomor tetap allocate_document_number().';
COMMENT ON COLUMN public.invoices.delivery_id IS
  'UNIQUE -- satu invoice per delivery (selaras uq_issued_documents_active_source). Revisi invoice (issued_documents version baru untuk delivery yang sama) BELUM didukung tabel ini -- deferred ke Gate 2B, lihat catatan migration di atas.';
COMMENT ON COLUMN public.invoices.due_date IS
  'NULL diperbolehkan (selaras sales_orders.payment_terms_days yang NULL-safe) -- Document Engine yang menegakkan PAYMENT_TERMS_INCOMPLETE di application layer, bukan constraint di sini.';

-- ---------------------------------------------------------------------------
-- 2. invoice_lines -- baris queryable per delivery_item yang ditagih.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoice_lines (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id           UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  company_id           UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  line_no              INTEGER       NOT NULL CHECK (line_no > 0),
  sales_order_item_id  UUID          NOT NULL REFERENCES public.sales_order_items (id) ON DELETE RESTRICT,
  delivery_item_id     UUID          NOT NULL REFERENCES public.delivery_items (id) ON DELETE RESTRICT,
  product_id           UUID          REFERENCES public.products (id) ON DELETE SET NULL,
  product_code         TEXT,
  product_name         TEXT          NOT NULL,
  unit                 TEXT,
  quantity             NUMERIC(15,3) NOT NULL CHECK (quantity > 0),
  unit_price           NUMERIC(15,2) NOT NULL CHECK (unit_price >= 0),
  discount_amount      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  line_total           NUMERIC(15,2) NOT NULL CHECK (line_total >= 0),
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (line_total = (quantity * unit_price) - discount_amount),
  UNIQUE (invoice_id, line_no),
  UNIQUE (invoice_id, delivery_item_id)
);

CREATE INDEX idx_invoice_lines_invoice_id ON public.invoice_lines (invoice_id);
CREATE INDEX idx_invoice_lines_company_id ON public.invoice_lines (company_id);

COMMENT ON TABLE public.invoice_lines IS
  'Baris finansial queryable per invoice -- satu baris per delivery_item yang ditagih (UNIQUE invoice_id+delivery_item_id). quantity/unit_price/discount_amount/line_total divalidasi SAMA PERSIS dengan issued_documents.snapshot->lines pada INSERT (trg_invoice_lines_tenant) dan tidak pernah berubah sesudahnya (trg_invoice_lines_immutable). quantity tidak boleh melebihi delivery_items.received_quantity (invariant #3 kontrak).';

-- ---------------------------------------------------------------------------
-- 3. receivable_ledger -- buku besar piutang append-only.
--
-- entry_type sengaja HANYA mengizinkan 'invoice_issued' pada gate ini
-- (instruksi gate #13) -- 'payment_allocation'/'credit_note' ditambahkan
-- lewat ALTER ... CHECK migration terpisah saat entitasnya benar-benar ada
-- (Gate 2B/2C). direction (debit/credit) adalah bagian struktural definisi
-- ledger itu sendiri (kontrak §2: saldo = SUM(debit) - SUM(kredit)) --
-- mengizinkan kedua nilai dari awal TIDAK sama dengan membuat entitas kredit
-- baru; Gate 2A tidak pernah menghasilkan baris credit (dijamin CHECK di
-- bawah: entry_type='invoice_issued' => direction='debit').
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.receivable_ledger (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID          NOT NULL REFERENCES public.companies (id) ON DELETE CASCADE,
  invoice_id  UUID          NOT NULL REFERENCES public.invoices (id) ON DELETE RESTRICT,
  entry_type  VARCHAR(30)   NOT NULL CHECK (entry_type IN ('invoice_issued')),
  direction   VARCHAR(10)   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  created_by  UUID          REFERENCES public.users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CHECK (entry_type <> 'invoice_issued' OR direction = 'debit')
);

CREATE UNIQUE INDEX uq_receivable_ledger_one_opening_debit
  ON public.receivable_ledger (invoice_id)
  WHERE entry_type = 'invoice_issued' AND direction = 'debit';

CREATE INDEX idx_receivable_ledger_invoice_id ON public.receivable_ledger (invoice_id, created_at);
CREATE INDEX idx_receivable_ledger_company_id ON public.receivable_ledger (company_id, created_at DESC);

COMMENT ON TABLE public.receivable_ledger IS
  'Buku besar piutang append-only (AODP_FINANCIAL_CONTRACT.md §3 invariant #5, §5). Tidak ada UPDATE/DELETE sama sekali (trg_receivable_ledger_immutable). Maksimal SATU opening debit (entry_type=invoice_issued, direction=debit) per invoice (uq_receivable_ledger_one_opening_debit). entry_type HANYA invoice_issued pada gate ini -- lihat catatan di atas.';
COMMENT ON COLUMN public.receivable_ledger.direction IS
  'debit menambah saldo piutang, credit menguranginya (kontrak §2). Gate 2A hanya pernah menghasilkan direction=debit (CHECK entry_type=invoice_issued => direction=debit) -- kolom sudah mengizinkan credit untuk payment allocation/credit note pada Gate 2B/2C tanpa migration struktural baru (instruksi gate #12).';

-- ---------------------------------------------------------------------------
-- Immutability -- full block: TIDAK ADA UPDATE/DELETE sama sekali sesudah
-- INSERT untuk ketiga tabel (lebih ketat dari issued_documents yang masih
-- mengizinkan transisi status active->superseded -- invoices/invoice_lines/
-- receivable_ledger tidak punya kolom status semacam itu di Gate 2A).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_invoice_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVOICE_IMMUTABLE: invoice % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'INVOICE_IMMUTABLE: invoice % tidak dapat diubah setelah diterbitkan', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_invoices_immutable ON public.invoices;
CREATE TRIGGER trg_invoices_immutable
  BEFORE UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.prevent_invoice_mutation();

CREATE OR REPLACE FUNCTION public.prevent_invoice_line_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'INVOICE_LINE_IMMUTABLE: baris invoice % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'INVOICE_LINE_IMMUTABLE: baris invoice % tidak dapat diubah setelah diterbitkan', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_invoice_lines_immutable ON public.invoice_lines;
CREATE TRIGGER trg_invoice_lines_immutable
  BEFORE UPDATE OR DELETE ON public.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_invoice_line_mutation();

CREATE OR REPLACE FUNCTION public.prevent_receivable_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'RECEIVABLE_LEDGER_APPEND_ONLY: entry % tidak dapat dihapus', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RAISE EXCEPTION 'RECEIVABLE_LEDGER_APPEND_ONLY: entry % tidak dapat diubah -- koreksi wajib berupa entry baru', OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_receivable_ledger_immutable ON public.receivable_ledger;
CREATE TRIGGER trg_receivable_ledger_immutable
  BEFORE UPDATE OR DELETE ON public.receivable_ledger
  FOR EACH ROW EXECUTE FUNCTION public.prevent_receivable_ledger_mutation();

-- ---------------------------------------------------------------------------
-- Tenant/consistency validation -- FK referential integrity saja tidak
-- menegakkan company_id yang sama maupun kesesuaian nominal dengan snapshot
-- immutable (pola sama dengan validate_issued_document_tenant, migration
-- 20260812000002). Dijalankan BEFORE INSERT -- sesudahnya baris immutable.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_invoice_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_doc              public.issued_documents%ROWTYPE;
  v_order_company    UUID;
  v_order_customer   UUID;
  v_delivery_company UUID;
  v_delivery_order   UUID;
  v_customer_company UUID;
  v_snapshot_totals  JSONB;
BEGIN
  SELECT * INTO v_doc FROM public.issued_documents WHERE id = NEW.issued_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ISSUED_DOCUMENT_NOT_FOUND: %', NEW.issued_document_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_doc.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: issued_document % bukan milik company %', NEW.issued_document_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_doc.document_type <> 'INVOICE' OR v_doc.status <> 'active' THEN
    RAISE EXCEPTION 'ISSUED_DOCUMENT_NOT_ACTIVE_INVOICE: dokumen % bertipe %/status % -- invoice hanya boleh lahir dari INVOICE aktif', v_doc.id, v_doc.document_type, v_doc.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_doc.source_order_id IS DISTINCT FROM NEW.sales_order_id OR v_doc.source_delivery_id IS DISTINCT FROM NEW.delivery_id THEN
    RAISE EXCEPTION 'INVOICE_SOURCE_MISMATCH: invoice harus merujuk source_order_id/source_delivery_id yang sama dengan issued_document %', v_doc.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_doc.document_number <> NEW.invoice_number THEN
    RAISE EXCEPTION 'INVOICE_NUMBER_MISMATCH: invoice_number harus sama persis dengan issued_documents.document_number (%)', v_doc.document_number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id, customer_id INTO v_order_company, v_order_customer
  FROM public.sales_orders WHERE id = NEW.sales_order_id;
  IF v_order_company IS NULL THEN
    RAISE EXCEPTION 'SALES_ORDER_NOT_FOUND: %', NEW.sales_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_order_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: sales_order % bukan milik company %', NEW.sales_order_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_order_customer <> NEW.customer_id THEN
    RAISE EXCEPTION 'INVOICE_CUSTOMER_MISMATCH: customer_id harus sama dengan sales_orders.customer_id'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id, sales_order_id INTO v_delivery_company, v_delivery_order
  FROM public.deliveries WHERE id = NEW.delivery_id;
  IF v_delivery_company IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_NOT_FOUND: %', NEW.delivery_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_delivery_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: delivery % bukan milik company %', NEW.delivery_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_delivery_order IS DISTINCT FROM NEW.sales_order_id THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_MISMATCH: delivery % milik order %, bukan order %', NEW.delivery_id, v_delivery_order, NEW.sales_order_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT company_id INTO v_customer_company FROM public.customers WHERE id = NEW.customer_id;
  IF v_customer_company IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: %', NEW.customer_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_customer_company <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: customer % bukan milik company %', NEW.customer_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_snapshot_totals := v_doc.snapshot -> 'totals';
  IF v_snapshot_totals IS NULL THEN
    RAISE EXCEPTION 'INVOICE_SNAPSHOT_TOTALS_MISSING: issued_document % tidak memiliki snapshot.totals', v_doc.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (v_snapshot_totals->>'subtotal')::NUMERIC IS DISTINCT FROM NEW.subtotal_amount
     OR (v_snapshot_totals->>'totalDiscount')::NUMERIC IS DISTINCT FROM NEW.discount_amount
     OR (v_snapshot_totals->>'grandTotal')::NUMERIC IS DISTINCT FROM NEW.total_amount THEN
    RAISE EXCEPTION 'INVOICE_TOTAL_SNAPSHOT_MISMATCH: subtotal/discount/total invoice harus sama persis dengan issued_documents.snapshot.totals'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_invoice_tenant IS
  'BEFORE INSERT guard invoices: issued_document wajib INVOICE/active milik tenant sama dan source_order_id/source_delivery_id sama persis; sales_order/delivery/customer wajib satu tenant dan konsisten relasinya; subtotal/discount/total wajib sama persis dengan issued_documents.snapshot.totals (mencegah invoices.total_amount drift dari snapshot immutable).';

DROP TRIGGER IF EXISTS trg_invoices_tenant ON public.invoices;
CREATE TRIGGER trg_invoices_tenant
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_tenant();

CREATE OR REPLACE FUNCTION public.validate_invoice_line_tenant()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice          public.invoices%ROWTYPE;
  v_soi_order_id     UUID;
  v_di_delivery_id   UUID;
  v_di_soi_id        UUID;
  v_di_received      NUMERIC;
  v_snapshot_line    JSONB;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT order_id INTO v_soi_order_id FROM public.sales_order_items WHERE id = NEW.sales_order_item_id;
  IF v_soi_order_id IS NULL THEN
    RAISE EXCEPTION 'SALES_ORDER_ITEM_NOT_FOUND: %', NEW.sales_order_item_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_soi_order_id <> v_invoice.sales_order_id THEN
    RAISE EXCEPTION 'INVOICE_LINE_ORDER_MISMATCH: sales_order_item % bukan milik order invoice %', NEW.sales_order_item_id, v_invoice.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT delivery_id, sales_order_item_id, received_quantity
  INTO v_di_delivery_id, v_di_soi_id, v_di_received
  FROM public.delivery_items WHERE id = NEW.delivery_item_id;
  IF v_di_delivery_id IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ITEM_NOT_FOUND: %', NEW.delivery_item_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_di_delivery_id <> v_invoice.delivery_id THEN
    RAISE EXCEPTION 'INVOICE_LINE_DELIVERY_MISMATCH: delivery_item % bukan milik delivery invoice %', NEW.delivery_item_id, v_invoice.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_di_soi_id <> NEW.sales_order_item_id THEN
    RAISE EXCEPTION 'INVOICE_LINE_ITEM_MISMATCH: delivery_item % tidak merujuk sales_order_item %', NEW.delivery_item_id, NEW.sales_order_item_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.quantity > v_di_received THEN
    RAISE EXCEPTION 'INVOICE_QUANTITY_EXCEEDS_RECEIVED: quantity % melebihi received_quantity % pada delivery_item %', NEW.quantity, v_di_received, NEW.delivery_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT elem INTO v_snapshot_line
  FROM public.issued_documents doc, jsonb_array_elements(doc.snapshot -> 'lines') elem
  WHERE doc.id = v_invoice.issued_document_id
    AND (elem->>'no')::INT = NEW.line_no;

  IF v_snapshot_line IS NULL THEN
    RAISE EXCEPTION 'INVOICE_LINE_SNAPSHOT_NOT_FOUND: tidak ada snapshot.lines dengan no=% pada issued_document %', NEW.line_no, v_invoice.issued_document_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (v_snapshot_line->>'quantity')::NUMERIC IS DISTINCT FROM NEW.quantity
     OR (v_snapshot_line->>'unitPrice')::NUMERIC IS DISTINCT FROM NEW.unit_price
     OR (v_snapshot_line->>'discountAmount')::NUMERIC IS DISTINCT FROM NEW.discount_amount
     OR (v_snapshot_line->>'lineTotal')::NUMERIC IS DISTINCT FROM NEW.line_total THEN
    RAISE EXCEPTION 'INVOICE_LINE_SNAPSHOT_MISMATCH: quantity/unit_price/discount_amount/line_total baris % harus sama persis dengan issued_documents.snapshot.lines', NEW.line_no
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_invoice_line_tenant IS
  'BEFORE INSERT guard invoice_lines: sales_order_item/delivery_item wajib konsisten dengan order/delivery invoice induk; quantity tidak boleh melebihi delivery_items.received_quantity (invariant #3 kontrak); quantity/unit_price/discount_amount/line_total wajib sama persis dengan issued_documents.snapshot.lines[no] (mencegah drift dari snapshot immutable).';

DROP TRIGGER IF EXISTS trg_invoice_lines_tenant ON public.invoice_lines;
CREATE TRIGGER trg_invoice_lines_tenant
  BEFORE INSERT ON public.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_invoice_line_tenant();

CREATE OR REPLACE FUNCTION public.validate_receivable_ledger_entry()
RETURNS TRIGGER AS $$
DECLARE
  v_invoice public.invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_invoice FROM public.invoices WHERE id = NEW.invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND: %', NEW.invoice_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_invoice.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'TENANT_CONTEXT_MISMATCH: invoice % bukan milik company %', NEW.invoice_id, NEW.company_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.entry_type = 'invoice_issued' AND NEW.amount <> v_invoice.total_amount THEN
    RAISE EXCEPTION 'RECEIVABLE_LEDGER_OPENING_AMOUNT_MISMATCH: opening debit % harus sama dengan invoices.total_amount % pada invoice %', NEW.amount, v_invoice.total_amount, v_invoice.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.validate_receivable_ledger_entry IS
  'BEFORE INSERT guard receivable_ledger: invoice_id wajib satu tenant dengan entry; entry_type=invoice_issued wajib amount == invoices.total_amount (opening debit selalu menyamai total invoice, mencegah saldo awal yang salah). uq_receivable_ledger_one_opening_debit (partial unique index) menegakkan maksimal satu opening debit per invoice.';

DROP TRIGGER IF EXISTS trg_receivable_ledger_tenant ON public.receivable_ledger;
CREATE TRIGGER trg_receivable_ledger_tenant
  BEFORE INSERT ON public.receivable_ledger
  FOR EACH ROW EXECUTE FUNCTION public.validate_receivable_ledger_entry();

-- ---------------------------------------------------------------------------
-- Derived read model -- satu-satunya cara membaca saldo/status finansial.
-- security_invoker: view berjalan dengan privilege+RLS pemanggil, BUKAN
-- pembuat view -- tenant isolation otomatis mengikuti RLS invoices/
-- receivable_ledger di bawah, tidak perlu policy terpisah untuk view ini.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.invoice_receivable_balances
WITH (security_invoker = true) AS
SELECT
  i.id                                                              AS invoice_id,
  i.company_id                                                      AS company_id,
  i.invoice_number                                                  AS invoice_number,
  i.total_amount                                                    AS total_amount,
  COALESCE(led.total_debit, 0)                                      AS total_debit,
  COALESCE(led.total_credit, 0)                                     AS total_credit,
  (COALESCE(led.total_debit, 0) - COALESCE(led.total_credit, 0))    AS outstanding_balance,
  CASE
    WHEN (COALESCE(led.total_debit, 0) - COALESCE(led.total_credit, 0)) <= 0 THEN 'paid'
    WHEN (COALESCE(led.total_debit, 0) - COALESCE(led.total_credit, 0)) < i.total_amount THEN 'partially_paid'
    ELSE 'outstanding'
  END                                                                AS financial_status
FROM public.invoices i
LEFT JOIN (
  SELECT
    invoice_id,
    SUM(amount) FILTER (WHERE direction = 'debit')  AS total_debit,
    SUM(amount) FILTER (WHERE direction = 'credit') AS total_credit
  FROM public.receivable_ledger
  GROUP BY invoice_id
) led ON led.invoice_id = i.id;

COMMENT ON VIEW public.invoice_receivable_balances IS
  'Derived read model (AODP_FINANCIAL_CONTRACT.md §2/§4) -- total_debit/total_credit/outstanding_balance/financial_status DIHITUNG dari receivable_ledger, tidak pernah disimpan sebagai kolom independen. security_invoker=true -- tenant isolation mengikuti RLS invoices/receivable_ledger milik pemanggil. paid = saldo <= 0 (termasuk saldo kredit negatif dari credit note pada gate mendatang, lihat test matrix §7); partially_paid = 0 < saldo < total; outstanding = saldo == total (belum ada kredit sama sekali).';

-- ---------------------------------------------------------------------------
-- Permission + RLS.
-- ---------------------------------------------------------------------------

INSERT INTO public.permissions (name, module, action, description) VALUES
  ('receivable.view', 'receivable', 'view', 'View canonical invoice & receivable ledger milik company sendiri')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r, public.permissions p
WHERE r.company_id IS NULL
  AND r.name IN ('owner', 'manager', 'admin', 'super_admin', 'finance')
  AND p.name = 'receivable.view'
ON CONFLICT DO NOTHING;

ALTER TABLE public.invoices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receivable_ledger ENABLE ROW LEVEL SECURITY;

-- SELECT-only untuk authenticated -- TIDAK ADA policy INSERT/UPDATE/DELETE
-- untuk siapa pun (RLS default-deny operasi yang tidak punya policy),
-- diperkuat REVOKE eksplisit di bawah supaya tidak bergantung pada RLS saja.
CREATE POLICY "invoices_select" ON public.invoices
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "invoice_lines_select" ON public.invoice_lines
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

CREATE POLICY "receivable_ledger_select" ON public.receivable_ledger
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND public.user_has_permission('receivable.view')
  );

-- Defense-in-depth (instruksi gate E): REVOKE mutasi langsung dari
-- anon/authenticated di level grant, terpisah dari RLS. service_role TIDAK
-- terdampak (masih GRANT ALL dari 20260707000003_grant_schema_privileges.sql).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoices, public.invoice_lines, public.receivable_ledger
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.invoices, public.invoice_lines, public.receivable_ledger TO authenticated;
GRANT SELECT ON public.invoice_receivable_balances TO authenticated;
