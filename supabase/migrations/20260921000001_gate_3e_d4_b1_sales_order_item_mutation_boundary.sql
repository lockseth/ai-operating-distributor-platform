-- =============================================================================
-- Gate 3E-D4-B1 -- Sales Order Item Mutation Boundary
--
-- Root cause (ditemukan saat audit Gate 3E-D4-A, persiapan special-price/
-- Owner approval): order_items_insert/update/delete (migration
-- 20260626000004_rls_policies.sql:273-301) HANYA memeriksa actor memegang
-- permission generik orders.create/update/delete DAN parent order berada di
-- company actor -- TIDAK PERNAH memeriksa:
--   a. status parent order (sales_order_items bisa dimutasi meski parent
--      sudah 'confirmed', 'invoiced', 'paid', dst -- termasuk lewat direct
--      PostgREST client, di luar seluruh RPC canonical);
--   b. kepemilikan order (order_items_update/delete tidak mensyaratkan
--      sales_id = auth.uid() sama sekali -- SEMBARANG user ber-permission
--      orders.update di tenant yang sama bisa mengubah item order Sales
--      LAIN, bukan cuma order sendiri).
--
-- Ini adalah jalur bypass direct-client yang PALING TAJAM terhadap seluruh
-- invariant harga/approval yang akan dibangun di gate berikutnya -- RPC
-- canonical (create/update draft, confirm) sudah benar (SECURITY DEFINER,
-- tenant+draft+ownership-scoped, lihat migration 20260822000001 dan
-- 20260919000001), tapi RLS pada sales_order_items sendiri tidak menutup
-- jalur di luar RPC itu sama sekali.
--
-- Fix (scope SEMPIT -- RLS/database mutation boundary SAJA, tidak ada
-- special_price_approvals/status baru/UI/WhatsApp/KPI pada gate ini):
--
-- 1. INSERT/UPDATE/DELETE sales_order_items untuk actor non-service-role
--    SEKARANG wajib: parent order company = company actor, DAN status
--    parent order = 'draft' (TANPA KECUALI -- termasuk untuk pemegang
--    orders.manage/role owner-manager; "item pada order confirmed atau
--    status final tidak boleh dimutasi langsung" berlaku universal, bukan
--    cuma untuk Sales -- lihat kontrak gate ini poin 2), DAN salah satu:
--      - actor memegang permission 'orders.manage' (hari ini: owner +
--        manager, lihat seed 20260707000001 -- admin TIDAK memegang
--        'orders.manage', jadi admin ikut dibatasi ke order miliknya
--        sendiri di jalur direct-client ini, PERSIS pola yang sudah berlaku
--        untuk sales_orders_update; RPC create/update_sales_order_atomic
--        tetap memberi admin ownership-bypass di JALUR RPC (service_role,
--        bypass RLS total) -- dua model ini TIDAK diselaraskan di gate ini,
--        sudah konsisten dengan model "permission canonical" existing yang
--        eksplisit diminta dipertahankan, bukan gap baru); ATAU
--      - order_id merujuk order milik actor sendiri (sales_id = auth.uid())
--        DAN actor memegang permission spesifik operasi (orders.create
--        untuk INSERT, orders.update untuk UPDATE, orders.delete untuk
--        DELETE -- role 'sales' TIDAK memegang orders.delete per seed,
--        sehingga delete langsung oleh Sales tetap ditolak seperti sebelum
--        gate ini; kapabilitas "hapus item" bagi Sales tetap tersedia
--        lewat RPC update_draft_sales_order_atomic yang melakukan
--        DELETE+INSERT sebagai SECURITY DEFINER -- TIDAK ADA role/
--        permission baru ditambahkan oleh gate ini).
--
-- 2. UPDATE memakai USING + WITH CHECK yang IDENTIK (bukan cuma USING) --
--    baris lama maupun baris hasil update wajib sama-sama lolos syarat di
--    atas, sehingga UPDATE tidak bisa dipakai untuk "mengeluarkan" item dari
--    constraint (mis. mengubah field lalu order berubah status di transaksi
--    lain secara bersamaan) TANPA baris hasil akhir tetap terverifikasi.
--
-- 3. Reparenting (memindahkan item ke order/company lain lewat
--    UPDATE ... SET order_id = ...) TIDAK bisa ditutup tuntas hanya lewat
--    USING/WITH CHECK RLS -- USING mengevaluasi baris LAMA, WITH CHECK
--    baris BARU, keduanya independen, sehingga actor yang punya akses ke
--    DUA order draft berbeda (mis. dua draft miliknya sendiri) tetap lolos
--    kedua pemeriksaan itu walau order_id berubah. Fix terpisah: trigger
--    BEFORE UPDATE yang menolak PERUBAHAN order_id secara mutlak, berlaku
--    untuk SEMUA role (termasuk service_role/RPC -- tidak masalah karena
--    TIDAK ADA RPC canonical yang pernah melakukan
--    UPDATE ... SET order_id, seluruhnya memakai pola DELETE lalu INSERT
--    ulang untuk mengganti item, lihat create_draft_sales_order_atomic/
--    update_draft_sales_order_atomic/create_sales_order_atomic/
--    update_sales_order_atomic).
--
-- Yang SENGAJA TIDAK diubah di gate ini (di luar scope, lihat kontrak):
--   - update_sales_order_atomic (RPC web) masih mengizinkan status order
--     'draft' ATAU 'confirmed' (migration 20260919000001:318) -- artinya
--     lewat RPC canonical (bukan direct client), item pada order confirmed
--     MASIH bisa diedit oleh actor ber-orders.update, termasuk Sales
--     pemilik order tsb. Ini adalah temuan terpisah dari audit Gate
--     3E-D4-A (§5.3 dampak ke KPI/invariant "perubahan harga setelah
--     approval") yang butuh keputusan produk sendiri (apakah koreksi
--     pasca-confirm sebelum invoice memang disengaja) -- BUKAN direct-
--     client bypass, dan mengubahnya akan melanggar kontrak gate ini "RPC
--     canonical untuk create/update draft yang sah harus tetap berfungsi"
--     serta "Jangan membuat ... perubahan KPI pada gate ini". Dilaporkan,
--     tidak diperbaiki di sini.
--   - Tidak ada role/permission/capability baru dibuat (kontrak poin 9) --
--     seluruh policy baru hanya mengombinasikan permission yang SUDAH ada
--     (orders.manage/create/update/delete) dengan syarat status+ownership
--     yang belum pernah diperiksa sebelumnya.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. order_items_insert -- tambah syarat status='draft' + ownership
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "order_items_insert" ON public.sales_order_items;

CREATE POLICY "order_items_insert" ON public.sales_order_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND o.status = 'draft'
        AND (
          public.user_has_permission('orders.manage')
          OR (o.sales_id = auth.uid() AND public.user_has_permission('orders.create'))
        )
    )
  );

-- -----------------------------------------------------------------------------
-- 2. order_items_update -- USING + WITH CHECK identik, status='draft' wajib
--    untuk SEMUA actor (termasuk pemegang orders.manage -- lihat catatan
--    kontrak poin 2 di header).
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "order_items_update" ON public.sales_order_items;

CREATE POLICY "order_items_update" ON public.sales_order_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND o.status = 'draft'
        AND (
          public.user_has_permission('orders.manage')
          OR (o.sales_id = auth.uid() AND public.user_has_permission('orders.update'))
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND o.status = 'draft'
        AND (
          public.user_has_permission('orders.manage')
          OR (o.sales_id = auth.uid() AND public.user_has_permission('orders.update'))
        )
    )
  );

-- -----------------------------------------------------------------------------
-- 3. order_items_delete -- syarat identik dengan insert/update (operasi
--    'orders.delete').
-- -----------------------------------------------------------------------------

DROP POLICY IF EXISTS "order_items_delete" ON public.sales_order_items;

CREATE POLICY "order_items_delete" ON public.sales_order_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.id = order_id
        AND o.company_id = public.get_user_company_id()
        AND o.status = 'draft'
        AND (
          public.user_has_permission('orders.manage')
          OR (o.sales_id = auth.uid() AND public.user_has_permission('orders.delete'))
        )
    )
  );

-- -----------------------------------------------------------------------------
-- 4. Anti-reparent trigger -- lihat catatan #3 di header kenapa ini tidak
--    bisa ditutup lewat RLS saja. RAISE EXCEPTION memakai SQLSTATE 23514
--    (check_violation) supaya konsisten dengan kelas error constraint
--    violation yang sudah dipakai di seluruh schema ini.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prevent_sales_order_item_reparent()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION 'sales_order_items.order_id tidak boleh diubah lewat UPDATE -- hapus dan insert ulang'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_order_items_prevent_reparent ON public.sales_order_items;

CREATE TRIGGER trg_sales_order_items_prevent_reparent
  BEFORE UPDATE ON public.sales_order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_sales_order_item_reparent();
