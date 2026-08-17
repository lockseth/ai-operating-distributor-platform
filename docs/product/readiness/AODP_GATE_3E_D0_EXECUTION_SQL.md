# AODP — Gate 3E-D0: Execution SQL & Auth Cleanup (operator-run)

Mengikuti pola [Gate 3D-B3-F5](AODP_GATE_3D_B3_F5_HOSTED_UAT_CLEANUP_RUNBOOK.md)
dan §9 [inventory audit](AODP_GATE_3E_D0_HOSTED_CLEAN_SLATE_INVENTORY.md):
eksekusi destructive (SQL transaction + Admin API auth deletion) terhadap
project hosted `mcbwgvtkhykrrtvbpeys` dijalankan oleh **operator sendiri**
(Founder), bukan otomatis oleh Claude Code. Baseline sudah di-re-verifikasi
PASS dan snapshot non-secret sudah dibuat: lihat
[AODP_GATE_3E_D0_PRE_CLEANUP_SNAPSHOT.md](AODP_GATE_3E_D0_PRE_CLEANUP_SNAPSHOT.md).

## Langkah 1 — SQL transaction (Supabase Studio → SQL Editor, project `mcbwgvtkhykrrtvbpeys`)

Precondition assertions memverifikasi ulang exact count/ID sebelum DELETE
dieksekusi. Bila salah satu gagal, seluruh transaksi ROLLBACK otomatis —
tidak ada perubahan tersimpan.

```sql
BEGIN;

DO $$
DECLARE
  v_companies uuid[] := ARRAY[
    '2d49badc-5ebb-40f5-8467-73e1f36464c2'::uuid,
    '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2'::uuid,
    '90e6f03b-770b-4c4b-91fc-cf8ab522be71'::uuid
  ];
  v_count int;
BEGIN
  -- (a) exact 3 companies match, tidak lebih tidak kurang
  SELECT count(*) INTO v_count FROM public.companies WHERE id = ANY(v_companies);
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 3 target companies, found %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.companies;
  IF v_count <> 3 THEN
    RAISE EXCEPTION 'ABORT: total companies in DB = % (expected exactly 3 — baseline drifted)', v_count;
  END IF;

  -- (b) exact 8 public.users, semua company_id masuk scope
  SELECT count(*) INTO v_count FROM public.users;
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'ABORT: total public.users = % (expected exactly 8 — baseline drifted)', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.users WHERE company_id <> ALL(v_companies);
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: % public.users exist outside the 3 target companies', v_count;
  END IF;

  -- (c) exact 8 user_roles, semua company_id masuk scope
  SELECT count(*) INTO v_count FROM public.user_roles;
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'ABORT: total user_roles = % (expected exactly 8 — baseline drifted)', v_count;
  END IF;

  -- (d) tidak ada akun super_admin di scope (larangan Founder)
  SELECT count(*) INTO v_count
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE r.name = 'super_admin';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: found % super_admin role assignment(s) — must not exist per Founder rule', v_count;
  END IF;

  RAISE NOTICE 'PRECONDITION OK — proceeding with cascade delete of 3 companies';
END $$;

-- SCOPED SALES_ORDER_ITEMS PRE-DELETE (Founder-authorized 2026-08-05,
-- narrow exception): sales_order_items.product_id -> products.id has no
-- ON DELETE action (defaults to NO ACTION). Because sales_order_items is
-- ALSO cascade-deleted via a separate path (companies -> sales_orders ->
-- sales_order_items, both CASCADE), Postgres does not guarantee that
-- branch completes before the products branch's NO ACTION check fires
-- in the same statement. Confirmed via read-only diagnostic: all 6
-- in-scope rows' orders AND products belong to the 3 target companies —
-- no cross-tenant reference, no orphan. This precondition re-verifies
-- that before deleting anything.
DO $$
DECLARE
  v_companies uuid[] := ARRAY[
    '2d49badc-5ebb-40f5-8467-73e1f36464c2'::uuid,
    '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2'::uuid,
    '90e6f03b-770b-4c4b-91fc-cf8ab522be71'::uuid
  ];
  v_scoped_count int;
  v_total_count int;
  v_cross_tenant int;
BEGIN
  SELECT count(*) INTO v_total_count FROM public.sales_order_items;

  SELECT count(*) INTO v_scoped_count
    FROM public.sales_order_items soi
    JOIN public.sales_orders so ON so.id = soi.order_id
   WHERE so.company_id = ANY(v_companies);

  IF v_scoped_count <> 6 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 6 in-scope sales_order_items, found %', v_scoped_count;
  END IF;

  IF v_total_count <> v_scoped_count THEN
    RAISE EXCEPTION 'ABORT: sales_order_items total (%) does not match in-scope count (%) — possible cross-tenant/orphan rows', v_total_count, v_scoped_count;
  END IF;

  SELECT count(*) INTO v_cross_tenant
    FROM public.sales_order_items soi
    JOIN public.sales_orders so ON so.id = soi.order_id
    JOIN public.products p ON p.id = soi.product_id
   WHERE so.company_id = ANY(v_companies)
     AND (p.company_id IS NULL OR p.company_id <> ALL(v_companies));

  IF v_cross_tenant <> 0 THEN
    RAISE EXCEPTION 'ABORT: % sales_order_items reference a product outside the 3 target companies — cross-tenant reference', v_cross_tenant;
  END IF;

  RAISE NOTICE 'SALES_ORDER_ITEMS PRECONDITION OK — exactly 6 rows in scope, no cross-tenant/orphan';
END $$;

-- Exactly one scoped DELETE statement, wrapped only to assert the row
-- count via GET DIAGNOSTICS. Must remove exactly 6 rows or ROLLBACK.
DO $$
DECLARE
  v_companies uuid[] := ARRAY[
    '2d49badc-5ebb-40f5-8467-73e1f36464c2'::uuid,
    '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2'::uuid,
    '90e6f03b-770b-4c4b-91fc-cf8ab522be71'::uuid
  ];
  v_deleted int;
BEGIN
  DELETE FROM public.sales_order_items
   WHERE order_id IN (
     SELECT id FROM public.sales_orders WHERE company_id = ANY(v_companies)
   );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 6 THEN
    RAISE EXCEPTION 'ABORT: expected to delete exactly 6 sales_order_items, deleted % — rolling back', v_deleted;
  END IF;
  RAISE NOTICE 'sales_order_items pre-delete OK — % rows removed', v_deleted;
END $$;

-- SCOPED TRIGGER TOGGLE (Founder-authorized 2026-08-05, opsi 1):
-- customer_pic_history punya trigger immutability (trg_cph_no_delete,
-- lihat supabase/migrations/20260728000001_customer_pic_master.sql:184)
-- yang memblokir DELETE tanpa syarat, termasuk lewat cascade FK. Trigger
-- disuspend HANYA untuk transaksi ini, dipulihkan sebelum COMMIT di
-- bawah — TIDAK di-drop, tidak permanen. Bila transaksi ini ROLLBACK
-- (baik karena assertion gagal maupun sebab lain), suspensi ini ikut
-- di-rollback karena ALTER TABLE ... TRIGGER bersifat transactional DDL.
ALTER TABLE public.customer_pic_history DISABLE TRIGGER trg_cph_no_delete;

-- Cascade delete: satu statement menghapus companies + seluruh tabel
-- tenant-scoped (company_id ... ON DELETE CASCADE), termasuk public.users
-- dan user_roles. public.roles/permissions/role_permissions (system
-- catalog, company_id IS NULL) TIDAK tersentuh.
DELETE FROM public.companies
 WHERE id IN (
   '2d49badc-5ebb-40f5-8467-73e1f36464c2',
   '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2',
   '90e6f03b-770b-4c4b-91fc-cf8ab522be71'
 );

-- Pulihkan trigger SEBELUM assertion & COMMIT — wajib berjalan di jalur
-- sukses ini sebelum transaksi ditutup.
ALTER TABLE public.customer_pic_history ENABLE TRIGGER trg_cph_no_delete;

-- Post-delete assertion sebelum COMMIT — jaring pengaman ganda.
DO $$
DECLARE
  v_count int;
  v_trigger_state "char";
BEGIN
  SELECT count(*) INTO v_count FROM public.companies;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: public.companies still has % rows after DELETE — not committing', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.users;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: public.users still has % rows after cascade — not committing', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.customer_pic_history;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: public.customer_pic_history still has % rows after cascade — not committing', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.sales_order_items;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: public.sales_order_items still has % rows — not committing', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.roles;
  IF v_count <> 8 THEN
    RAISE EXCEPTION 'ABORT: public.roles changed from 8 to % — system catalog must stay intact', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.permissions;
  IF v_count <> 65 THEN
    RAISE EXCEPTION 'ABORT: public.permissions changed from 65 to % — system catalog must stay intact', v_count;
  END IF;

  -- Konfirmasi trigger immutability benar-benar sudah dipulihkan
  -- ('O' = origin/enabled) sebelum transaksi boleh ditutup.
  SELECT tgenabled INTO v_trigger_state
    FROM pg_trigger
   WHERE tgname = 'trg_cph_no_delete'
     AND tgrelid = 'public.customer_pic_history'::regclass;
  IF v_trigger_state IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'ABORT: trg_cph_no_delete not re-enabled (state=%) — refusing to commit with immutability guard off', v_trigger_state;
  END IF;
END $$;

COMMIT;
```

Jika muncul error `ABORT: ...` — transaksi rollback otomatis, tidak ada
perubahan. Laporkan pesan error sebelum mencoba lagi; jangan mengubah
script untuk "melewati" assertion.

## Langkah 1b — Post-COMMIT trigger re-verification (read-only, WAJIB sebelum lanjut ke Langkah 2)

Jalankan terpisah setelah `COMMIT` di atas sukses, untuk konfirmasi independen
(di luar transaksi yang sama) bahwa `trg_cph_no_delete` benar-benar aktif:

```sql
SELECT tgname, tgenabled,
       CASE tgenabled WHEN 'O' THEN 'ENABLED (origin)' ELSE 'NOT ENABLED — STOP' END AS status
  FROM pg_trigger
 WHERE tgname = 'trg_cph_no_delete'
   AND tgrelid = 'public.customer_pic_history'::regclass;
```

Ekspektasi: satu baris, `tgenabled = 'O'`, status `ENABLED (origin)`. Bila
tidak — **STOP**, jangan lanjut ke Langkah 2, laporkan hasilnya.

## Langkah 2 — Auth cleanup (SETELAH langkah 1 COMMIT sukses)

Exact UUID allowlist, bukan wildcard/email search. 8 ID ini hanya boleh
dieksekusi setelah langkah 1 di atas ter-COMMIT.

**Opsi A — Studio UI (direkomendasikan):** Authentication → Users → cari
tiap UUID di bawah → Delete user.

**Opsi B — script Admin API** (jalankan manual, tidak hardcode secret):

```js
// scripts/adhoc-gate-3e-d0-auth-cleanup.mjs
// Jalankan manual oleh operator: node scripts/adhoc-gate-3e-d0-auth-cleanup.mjs
// HANYA jalankan setelah SQL transaction (Langkah 1) sudah COMMIT sukses.
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";

const ENV_FILE = path.resolve(process.cwd(), ".env.demo.local");
const env = {};
for (const line of fs.readFileSync(ENV_FILE, "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const url = env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
const serviceRoleKey = env.SUPABASE_DEMO_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("Env demo tidak lengkap di .env.demo.local");
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// EXACT UUID allowlist dari snapshot pre-cleanup — jangan diganti wildcard.
const TARGET_UUIDS = [
  "9da6f93f-1f60-43e0-86aa-6ff6c2296c58", // owner.demo@waluyo.aodp.test
  "bc38396b-4f13-45b3-9a3a-cb79cab82a29", // admin.demo@waluyo.aodp.test
  "60fefc86-0c69-45a8-9ca8-084de904d737", // sales.demo@waluyo.aodp.test
  "f0d9eb66-a0d0-4307-aae5-7b67b2ba026c", // sales2.demo@waluyo.aodp.test
  "4e32c324-6934-4971-bbcb-ff0ad95810e3", // owner.isolation@aodp.test
  "b413e193-ff04-4506-a335-2f8e6608ea56", // ptandratranscaterservices@gmail.com
  "c3563fa8-4aac-4181-818e-9c0445d466c9", // diaryofero@gmail.com
  "4f8d2395-e9cf-44ca-895d-23391094a8bd", // manglegendz@gmail.com
];

for (const id of TARGET_UUIDS) {
  const { data, error } = await supabase.auth.admin.deleteUser(id);
  console.log(id, error ? `ERROR: ${error.message}` : "deleted", data ?? "");
}
```

File ini belum dibuat di repo — buat manual bila mau pakai Opsi B (dan
jangan commit, sama seperti dua script audit ad-hoc), atau pakai Opsi A
(Studio UI, tidak butuh file tambahan).

## Langkah 3 — Verifikasi akhir (read-only)

Jalankan ulang `node scripts/adhoc-gate-3e-d0-hosted-inventory.mjs` dan
konfirmasi:

- `companies (0)`
- `public.users (0 total)`
- `auth.users (0 total)`
- `GRAND TOTAL rows` = 278 (yaitu hanya `roles` 8 + `permissions` 65 +
  `role_permissions` 205 yang tersisa, sisanya 0)
- storage buckets tetap `(no buckets configured)`

Bila salah satu tidak cocok — **STOP**, jangan lanjut menutup gate,
laporkan penyimpangannya sebelum tindakan lanjutan.

## Langkah 4 — Setelah verifikasi PASS

Hapus dua script audit ad-hoc lokal (jangan commit):

```bash
rm scripts/adhoc-gate-3e-d0-hosted-inventory.mjs scripts/adhoc-gate-3e-d0-hosted-breakdown.mjs
```

Serta hapus `scripts/adhoc-gate-3e-d0-auth-cleanup.mjs` bila dibuat untuk
Opsi B (juga jangan commit).
