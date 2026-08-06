-- =============================================================================
-- Gate 3E-D4-B2 -- Canonical Confirmed-Order Mutation Boundary
--
-- Root cause (dicatat sebagai temuan terpisah, BUKAN diperbaiki, di header
-- migration 20260921000001_gate_3e_d4_b1_sales_order_item_mutation_boundary.sql
-- baris 72-84): Gate 3E-D4-B1 menutup bypass direct-client pada
-- sales_order_items (RLS), tapi RPC canonical public.update_sales_order_atomic
-- (migration 20260919000001:318) MASIH menerima parent order berstatus
-- 'draft' ATAU 'confirmed' -- artinya lewat jalur RPC canonical yang sah
-- (bukan direct client), item pada order confirmed MASIH bisa diedit oleh
-- actor mana pun ber-orders.update, termasuk Sales pemilik order tsb sendiri
-- dan Owner/Admin/orders.manage lewat ownership-bypass RPC. Ini melanggar
-- invariant "item order hanya boleh dimutasi ketika parent order draft" yang
-- justru sudah ditegakkan di level RLS oleh Gate 3E-D4-B1 -- RPC (SECURITY
-- DEFINER, bypass RLS total) adalah satu-satunya jalur yang belum ikut
-- ditutup.
--
-- Fix (scope SEMPIT -- enforcement RPC SAJA, lihat kontrak gate: tidak ada
-- schema special-price/approval/WhatsApp/UI approval/role baru, tidak ada
-- workflow koreksi baru):
--
-- 1. update_sales_order_atomic sekarang HANYA menerima parent order
--    berstatus 'draft' (sebelumnya: 'draft' ATAU 'confirmed'). Order
--    confirmed/invoiced/paid/cancelled/status final lain SEKARANG ditolak
--    ('invalid_status') TANPA KECUALI -- termasuk untuk actor
--    ownership-bypass (owner/manager/admin/super_admin), persis pola
--    universal yang sudah dipakai order_items_update di Gate 3E-D4-B1 (tidak
--    ada bypass Owner/Admin/orders.manage terhadap aturan draft-only, sesuai
--    kontrak gate ini poin 3).
-- 2. Row lock parent order (SELECT ... FOR UPDATE) SUDAH ADA di RPC ini
--    sejak migration 20260919000001 (baris 303-306) dan di
--    confirm_sales_order_atomic (migration 20260822000001, baris 952-955) --
--    KEDUANYA mengunci baris sales_orders yang sama sebelum memeriksa/mengubah
--    status, sehingga race update-vs-confirm SUDAH fail-closed secara
--    struktural (transaksi kedua yang menunggu lock akan membaca status
--    ter-update oleh transaksi pertama setelah commit, bukan snapshot basi).
--    TIDAK ADA locking baru yang perlu ditambahkan -- gate ini HANYA
--    mengetatkan pemeriksaan status yang sudah dilindungi lock tsb.
-- 3. Tenant-scoped (company_id) dan ownership checks (ownership-bypass role
--    array, sales_id = p_actor_id untuk non-bypass) TIDAK diubah sama sekali
--    -- hanya kondisi status yang dipersempit.
-- 4. create_sales_order_atomic, create_draft_sales_order_atomic, dan
--    update_draft_sales_order_atomic TIDAK disentuh -- ketiganya sudah
--    draft-only atau selalu insert status='draft' (lihat audit caller di
--    bawah), tidak ada overload/versi lain dari update_sales_order_atomic
--    yang aktif di schema ini.
--
-- Audit caller (dibuktikan sebelum implementasi, bukan asumsi):
--   - apps/web/src/lib/orders/actions.ts (updateOrderAction) -- SATU-SATUNYA
--     caller aplikasi untuk update_sales_order_atomic, dipanggil lewat
--     service-role (getAdminClient()), pesan error 'invalid_status'
--     diselaraskan di file yang sama pada commit yang sama dengan migration
--     ini.
--   - Telegram workflow TIDAK PERNAH memanggil update_sales_order_atomic --
--     kanal itu eksklusif memakai create_draft_sales_order_atomic/
--     update_draft_sales_order_atomic yang sudah draft-only sejak awal
--     (migration 20260822000001, tidak berubah oleh gate ini).
--   - UI (app/(dashboard)/dashboard/orders/[id]/page.tsx dan
--     .../[id]/edit/page.tsx) sebelumnya menawarkan "Edit Order" untuk
--     status draft ATAUPUN confirmed -- diselaraskan pada commit yang sama
--     agar tidak menawarkan mutation yang backend sekarang tolak (kontrak
--     gate ini: "Selaraskan caller/UI agar tidak menawarkan mutation yang
--     backend akan tolak").
--
-- Yang SENGAJA TIDAK diubah (di luar scope, lihat kontrak):
--   - Tidak ada workflow koreksi order confirmed baru. Koreksi pasca-confirm
--     (jika dibutuhkan produk) adalah keputusan terpisah untuk gate
--     mendatang, bukan gate ini (kontrak poin 7).
--   - update_sales_order_status_atomic dan cancel_sales_order_atomic (RPC
--     transisi status, bukan mutasi item) TIDAK disentuh -- gate ini murni
--     tentang mutasi ITEM/field order via update_sales_order_atomic, bukan
--     transisi status itu sendiri.
--   - Tidak ada role/permission/capability baru (kontrak poin 3 & 10) --
--     enforcement hanya mempersempit kondisi status yang sudah diperiksa.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_sales_order_atomic(
  p_company_id UUID,
  p_actor_id UUID,
  p_order_id UUID,
  p_customer_id UUID,
  p_sales_id UUID,
  p_notes TEXT,
  p_delivery_date DATE,
  p_discount_amount NUMERIC,
  p_items JSONB
)
RETURNS TABLE(result_outcome TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_allowed BOOLEAN;
  v_actor_bypasses_ownership BOOLEAN;
  v_effective_sales_id UUID;
  v_order public.sales_orders%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_total_amount NUMERIC;
  v_tax_amount NUMERIC;
  v_final_amount NUMERIC;
  v_item_count INTEGER;
  v_invalid_product_count INTEGER;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.user_roles ur ON ur.user_id = u.id AND ur.company_id = u.company_id
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE u.id = p_actor_id
      AND u.company_id = p_company_id
      AND u.is_active = TRUE
      AND p.name = 'orders.update'
  ) INTO v_actor_allowed;

  IF NOT v_actor_allowed THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = p_actor_id
      AND ur.company_id = p_company_id
      AND r.name IN ('owner', 'manager', 'admin', 'super_admin')
  ) INTO v_actor_bypasses_ownership;

  -- Gate 3E-D3-A: sama seperti create -- non-bypass actor tidak bisa
  -- memindahkan order ke sales_id lain lewat parameter update.
  v_effective_sales_id := CASE WHEN v_actor_bypasses_ownership THEN p_sales_id ELSE p_actor_id END;

  SELECT * INTO v_order
  FROM public.sales_orders
  WHERE id = p_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT;
    RETURN;
  END IF;

  IF NOT v_actor_bypasses_ownership AND v_order.sales_id IS DISTINCT FROM p_actor_id THEN
    RETURN QUERY SELECT 'forbidden'::TEXT;
    RETURN;
  END IF;

  -- Gate 3E-D4-B2: draft-only, TANPA KECUALI -- termasuk actor
  -- ownership-bypass (owner/manager/admin/super_admin). Sebelumnya menerima
  -- 'draft' ATAU 'confirmed' (migration 20260919000001:318) -- itu adalah
  -- jalur bypass canonical yang ditutup gate ini. Baris parent order SUDAH
  -- dikunci (FOR UPDATE, di atas) sebelum pemeriksaan ini, dan
  -- confirm_sales_order_atomic mengunci baris yang sama sebelum mengubah
  -- status -- race update-vs-confirm fail-closed lewat lock tsb, bukan
  -- pemeriksaan status semata.
  IF v_order.status != 'draft' THEN
    RETURN QUERY SELECT 'invalid_status'::TEXT;
    RETURN;
  END IF;

  SELECT * INTO v_customer
  FROM public.customers c
  WHERE c.id = p_customer_id AND c.company_id = p_company_id;

  IF p_customer_id IS NULL OR NOT FOUND THEN
    RETURN QUERY SELECT 'invalid_customer'::TEXT;
    RETURN;
  END IF;

  -- Gate 3E-D3-A: lihat catatan customer_not_owned di create_sales_order_atomic.
  IF NOT v_actor_bypasses_ownership
     AND v_customer.assigned_sales_id IS NOT NULL
     AND v_customer.assigned_sales_id <> v_effective_sales_id THEN
    RETURN QUERY SELECT 'customer_not_owned'::TEXT;
    RETURN;
  END IF;

  IF v_effective_sales_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_effective_sales_id AND u.company_id = p_company_id
  ) THEN
    RETURN QUERY SELECT 'invalid_sales_id'::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_item_count FROM jsonb_array_elements(p_items);
  IF v_item_count = 0 THEN
    RETURN QUERY SELECT 'no_items'::TEXT;
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_invalid_product_count
  FROM jsonb_to_recordset(p_items) AS x(product_id UUID)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.products pr WHERE pr.id = x.product_id AND pr.company_id = p_company_id
  );
  IF v_invalid_product_count > 0 THEN
    RETURN QUERY SELECT 'invalid_product'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE(SUM(x.total_amount), 0) INTO v_total_amount
  FROM jsonb_to_recordset(p_items) AS x(total_amount NUMERIC);
  v_tax_amount := ROUND((v_total_amount - p_discount_amount) * 0.11, 2);
  v_final_amount := v_total_amount - p_discount_amount + v_tax_amount;

  DELETE FROM public.sales_order_items WHERE order_id = p_order_id;

  INSERT INTO public.sales_order_items (
    order_id, product_id, quantity, unit_price, discount_amount, total_amount, notes
  )
  SELECT p_order_id, x.product_id, x.quantity, x.unit_price, x.discount_amount, x.total_amount, x.notes
  FROM jsonb_to_recordset(p_items) AS x(
    product_id UUID, quantity INTEGER, unit_price NUMERIC,
    discount_amount NUMERIC, total_amount NUMERIC, notes TEXT
  );

  UPDATE public.sales_orders
  SET customer_id = p_customer_id,
      sales_id = v_effective_sales_id,
      notes = p_notes,
      delivery_date = p_delivery_date,
      total_amount = v_total_amount,
      discount_amount = p_discount_amount,
      tax_amount = v_tax_amount,
      final_amount = v_final_amount
  WHERE id = p_order_id;

  INSERT INTO public.audit_logs (
    company_id, user_id, action, entity_type, entity_id, old_data, new_data,
    actor_type, event_category, module, source, outcome
  ) VALUES (
    p_company_id, p_actor_id, 'order.update', 'sales_orders', p_order_id,
    jsonb_build_object(
      'order_number', v_order.order_number, 'customer_id', v_order.customer_id,
      'final_amount', v_order.final_amount
    ),
    jsonb_build_object(
      'order_number', v_order.order_number, 'customer_id', p_customer_id,
      'item_count', v_item_count, 'final_amount', v_final_amount
    ),
    NULL, 'audit', 'orders', 'web', 'success'
  );

  RETURN QUERY SELECT 'updated'::TEXT;
END;
$$;

-- CREATE OR REPLACE mempertahankan grants existing (signature identik) --
-- REVOKE/GRANT diulang eksplisit sebagai defense-in-depth, konsisten dengan
-- pola migration 20260822000001 (bukan perubahan privilege, hanya
-- memastikan tidak ada drift).
REVOKE ALL ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_order_atomic(UUID, UUID, UUID, UUID, UUID, TEXT, DATE, NUMERIC, JSONB)
  TO service_role;
