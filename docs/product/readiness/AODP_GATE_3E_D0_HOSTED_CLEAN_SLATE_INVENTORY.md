# AODP — Gate 3E-D0: Hosted Clean-Slate Inventory & Cleanup Plan (AUDIT-ONLY)

Status: **AUDIT COMPLETE — NO MUTATION PERFORMED**. Ini adalah inventaris
read-only dan rencana cleanup untuk direview. Eksekusi destructive cleanup
memerlukan otorisasi eksplisit terpisah dari Founder (lihat §9).

Project hosted: **`mcbwgvtkhykrrtvbpeys`** (AODP-Waluyo-Demo),
`https://mcbwgvtkhykrrtvbpeys.supabase.co`. Audit dijalankan via service-role
Supabase client, read-only (`select` + `count`, `auth.admin.listUsers`,
`storage.listBuckets`) — tidak ada `insert`/`update`/`delete` yang
dieksekusi. Script audit: [scripts/adhoc-gate-3e-d0-hosted-inventory.mjs](../../../scripts/adhoc-gate-3e-d0-hosted-inventory.mjs),
[scripts/adhoc-gate-3e-d0-hosted-breakdown.mjs](../../../scripts/adhoc-gate-3e-d0-hosted-breakdown.mjs)
(keduanya ad-hoc, belum di-commit).

## 1. RESULT

**PASS** — inventaris berhasil dan konsisten, tidak ada orphan
auth/public.users, tidak ada akun `super_admin`, tidak ada storage bucket
tersisa, dan struktur FK dikonfirmasi dependency-safe untuk cleanup
company-scoped. Dua identitas yang secara eksplisit dilarang Founder
(`owner.demo@waluyo.aodp.test` dan `ptandratranscaterservices@gmail.com`)
dikonfirmasi masih aktif di hosted project — sesuai dugaan, keduanya masuk
scope cleanup.

## 2. Exact hosted project identity

| | |
|---|---|
| Project ref | `mcbwgvtkhykrrtvbpeys` |
| Project name | AODP-Waluyo-Demo |
| URL | `https://mcbwgvtkhykrrtvbpeys.supabase.co` |
| Audit timestamp (client clock) | 2026-08-05T00:35:46Z |

## 3. Pre-cleanup aggregate inventory

### 3.1 Tenants (`public.companies`) — 3 total

| Company ID | Slug | Nama | Dibuat |
|---|---|---|---|
| `2d49badc-5ebb-40f5-8467-73e1f36464c2` | `sumber-warna-alam-sudiada-demo` | PT. Sumber Warna Alam Sudiada | 2026-07-16 |
| `3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2` | `isolation-test-tenant-synthetic` | PT. Isolation Test Tenant (Synthetic) | 2026-07-16 |
| `90e6f03b-770b-4c4b-91fc-cf8ab522be71` | `pt-uat-gate-3e-c-c2-b2-0f3a28c9` | PT UAT Gate 3E-C-C2-B2 | 2026-08-03 |

Ketiganya adalah tenant demo/UAT/synthetic — **tidak ada tenant produksi
Pak Waluyo yang sudah live**. Ketiganya masuk scope cleanup penuh (lihat §4).

### 3.2 `public.users` — 8 total (dan `auth.users` — 8 total, 1:1 match)

| ID | Email | Company | Role | Aktif |
|---|---|---|---|---|
| `9da6f93f-1f60-43e0-86aa-6ff6c2296c58` | owner.demo@waluyo.aodp.test | demo | owner | true |
| `bc38396b-4f13-45b3-9a3a-cb79cab82a29` | admin.demo@waluyo.aodp.test | demo | admin | true |
| `60fefc86-0c69-45a8-9ca8-084de904d737` | sales.demo@waluyo.aodp.test | demo | sales | true |
| `f0d9eb66-a0d0-4307-aae5-7b67b2ba026c` | sales2.demo@waluyo.aodp.test | demo | sales | true |
| `4e32c324-6934-4971-bbcb-ff0ad95810e3` | owner.isolation@aodp.test | isolation | owner | true |
| `b413e193-ff04-4506-a335-2f8e6608ea56` | ptandratranscaterservices@gmail.com | uat-gate-3e-c-c2-b2 | owner | true |
| `c3563fa8-4aac-4181-818e-9c0445d466c9` | diaryofero@gmail.com | uat-gate-3e-c-c2-b2 | admin | true |
| `4f8d2395-e9cf-44ca-895d-23391094a8bd` | manglegendz@gmail.com | uat-gate-3e-c-c2-b2 | sales | true |

**Orphan check:** `auth.users` tanpa `public.users` = **0**. `public.users`
tanpa `auth.users` = **0**. Tidak ada akun dengan role `super_admin` —
konsisten dengan larangan Founder.

### 3.3 Business data — row count per tabel (89 tabel diperiksa, hasil dari `supabase/migrations/*.sql`)

Total keseluruhan: **406 baris** di seluruh tabel bisnis (di luar
`auth.users`). Tabel non-nol:

| Tabel | Total | demo | isolation | uat-gate-3e-c-c2-b2 |
|---|---|---|---|---|
| `roles` (system, `company_id IS NULL`) | 8 | — | — | — |
| `permissions` (system, no `company_id`) | 65 | — | — | — |
| `role_permissions` (system, no `company_id`) | 205 | — | — | — |
| `user_roles` | 8 | 4 | 1 | 3 |
| `products` | 6 | 5 | 1 | 0 |
| `customers` | 5 | 5 | 0 | 0 |
| `sales_orders` | 5 | 5 | 0 | 0 |
| `sales_order_items` | 6 | 6 (via `order_id`, no direct `company_id`) | 0 | 0 |
| `audit_logs` | 39 | 33 | 0 | 6 |
| `knowledge_product_aliases` | 8 | 8 | 0 | 0 |
| `knowledge_customer_aliases` | 9 | 9 | 0 | 0 |
| `customer_pics` | 5 | 5 | 0 | 0 |
| `customer_pic_history` | 9 | 9 | 0 | 0 |
| `customer_relationship_events` | 9 | 9 | 0 | 0 |
| `order_cancellation_disputes` | 1 | 1 | 0 | 0 |
| `salesman_coverage_areas` | 4 | 4 | 0 | 0 |
| `coverage_areas` | 3 | 3 | 0 | 0 |

Sisa **73 tabel lain** (deliveries, telegram_*, invoices, returns,
payments, KPI, automation, dispatch, dll.) = **0 baris** di ketiganya.
Detail lengkap 89-tabel di lampiran hasil script (§ referensi di atas).

### 3.4 Telegram identities, pairing/enrollment tokens, password-reset tokens

- `telegram_identities` = **0**
- `telegram_enrollment_tokens` (pairing) = **0**
- `tenant_user_password_reset_operations` (super-admin & Telegram
  self-service reset) = **0**
- `telegram_conversation_state`, `telegram_menu_conversation_state`,
  `telegram_update_events` = **0**

Tidak ada identitas Telegram atau token pairing/reset aktif yang tersisa
di hosted project saat ini.

### 3.5 Storage

`storage.listBuckets()` → **tidak ada bucket dikonfigurasi**. Tidak ada
object tenant tersimpan.

### 3.6 Orphan records

Tidak ditemukan orphan: `auth.users`↔`public.users` 1:1 match sempurna
(0/0), dan seluruh baris bisnis yang diperiksa memiliki `company_id` yang
merujuk ke salah satu dari 3 company di atas (tidak ada FK dangling —
`company_id` adalah `NOT NULL REFERENCES public.companies ON DELETE
CASCADE` di semua tabel tenant-scoped).

## 4. Data yang akan dihapus (destructive cleanup — belum dieksekusi)

Seluruh isi dari §3.1–§3.4 di atas:

- 3 companies (demo, isolation, UAT gate-3e-c-c2-b2) — termasuk
  `owner.demo@waluyo.aodp.test` yang secara eksplisit dilarang
  dipertahankan Founder.
- 8 `auth.users` + 8 `public.users` + 8 `user_roles` — termasuk
  `ptandratranscaterservices@gmail.com` yang secara eksplisit dilarang
  dipakai sebagai Owner tenant lama.
- Seluruh 406 baris data bisnis tenant (products, customers, sales
  orders, audit logs, knowledge aliases, customer PIC, coverage areas,
  dispute, dll.) — semuanya cascade dari company_id.
- Tidak ada Telegram identity/token, password-reset token, atau storage
  object untuk dihapus (sudah kosong).

## 5. Data dan konfigurasi yang dipertahankan

- **Schema & migrations** — seluruh 90 file di `supabase/migrations/`,
  tidak disentuh.
- **`public.roles`** (8 baris, `company_id IS NULL`, `is_system_role =
  true`) — katalog role sistem (super_admin, owner, manager, sales,
  admin, warehouse, finance, driver). Tidak cascade dari companies,
  aman dipertahankan sebagai role reference.
- **`public.permissions`** (65 baris) dan **`public.role_permissions`**
  (205 baris) — katalog permission sistem, tidak punya `company_id` sama
  sekali, tidak tersentuh oleh cascade delete companies.
- Supabase project config, API keys, webhook config, Vercel
  deployment, dan seluruh kode production — tidak disentuh (di luar
  scope SQL cleanup).
- Tidak ada seed baru dan tidak ada akun pengganti yang dibuat.

## 6. Urutan cleanup dan rollback boundary (rencana, BELUM dieksekusi)

Temuan kunci dari pemetaan FK (`supabase/migrations/*.sql`): **semua**
tabel tenant-scoped punya `company_id UUID NOT NULL REFERENCES
public.companies (id) ON DELETE CASCADE`. Beberapa tabel turunan bisnis
(mis. `receivable_ledger → sales_orders/deliveries`, `returns →
invoices/sales_orders/deliveries`, `credit_notes → returns`,
`order_cancellations/invoice_voids → sales_orders/invoices`) memakai
**`ON DELETE RESTRICT`** pada kolom relasi bisnisnya (bukan `company_id`).

**Implikasi penting:** RESTRICT tsb HANYA aman jika seluruh baris yang
saling terkait dihapus dalam **satu statement/transaksi** yang sama
(`DELETE FROM public.companies WHERE id IN (...)`), karena Postgres
meng-cascade semua FK `company_id` secara bersamaan sebelum RI check
RESTRICT dievaluasi di akhir statement. **Jangan** menghapus tabel bisnis
satu-per-satu secara manual dengan urutan sendiri — itu akan menabrak
RESTRICT dan gagal di tengah jalan (atau lebih buruk, berhasil sebagian).

Rencana urutan (dependency-safe, transaction-safe):

1. **Snapshot/export metadata non-secret** (lihat §8) — dijalankan
   sebelum langkah destructive apa pun.
2. **Satu transaksi SQL**: `BEGIN; DELETE FROM public.companies WHERE id
   IN (3 UUID di §3.1); COMMIT;` — precondition assertion (`DO $$ ...
   RAISE EXCEPTION`) memverifikasi exact UUID/email/count sebelum delete
   dieksekusi, mengikuti pola yang sudah dipakai di
   [Gate 3D-B3-F5 runbook](AODP_GATE_3D_B3_F5_HOSTED_UAT_CLEANUP_RUNBOOK.md).
   Cascade otomatis membersihkan seluruh 406 baris bisnis + 8
   `public.users` + 8 `user_roles`. `public.roles`/`permissions`/
   `role_permissions` (system catalog) tidak tersentuh.
3. **Auth cleanup** (setelah §langkah 2 COMMIT sukses): hapus 8
   `auth.users` via Admin API (`supabase.auth.admin.deleteUser`) atau
   Studio UI — exact UUID allowlist dari §3.2, bukan wildcard.
4. **Rollback boundary**: langkah 2 (SQL transaction) dan langkah 3
   (Admin API auth deletion) adalah **dua boundary terpisah**. Langkah 2
   rollback otomatis penuh bila precondition gagal (belum COMMIT = belum
   ada perubahan). Langkah 3 **tidak bisa di-rollback** oleh Supabase
   (auth user deletion permanen) — karena itu langkah 3 baru boleh
   jalan setelah langkah 2 dikonfirmasi COMMIT sukses dan diverifikasi.

## 7. Risiko constraint/cascade/orphan

- **Risiko utama**: menjalankan cleanup tabel-per-tabel manual (bukan
  cascade dari `companies`) akan menabrak `ON DELETE RESTRICT` di rantai
  receivable/returns/credit-note dan gagal di tengah. Mitigasi: selalu
  hapus lewat `DELETE FROM public.companies` dalam satu statement.
- **`sales_order_items`** tidak punya kolom `company_id` langsung (hanya
  `order_id → sales_orders`, `ON DELETE CASCADE`) — otomatis ikut
  terhapus saat `sales_orders` cascade dari company, tidak perlu
  penanganan terpisah.
- **auth.users tidak ikut cascade dari `public.companies`** (arah FK
  terbalik: `public.users.id → auth.users.id ON DELETE CASCADE`, bukan
  sebaliknya) — auth cleanup WAJIB langkah terpisah (§6 langkah 3), atau
  8 identitas Telegram/login lama tetap bisa dipakai untuk sign-in
  meski profil tenant-nya sudah hilang.
- **Tidak ada orphan risk untuk Telegram/pairing/reset-token** — seluruh
  tabel terkait sudah 0 baris.
- **`public.roles`/`permissions`/`role_permissions` aman** — tidak
  punya FK ke `companies`, tidak akan ikut terhapus meski salah pakai
  `TRUNCATE ... CASCADE` sembarangan (tapi tetap: jangan pernah pakai
  `TRUNCATE` tanpa daftar tabel eksplisit).

## 8. Verifikasi keadaan kosong (rencana, dijalankan setelah cleanup nanti)

Read-only, dijalankan setelah §6 langkah 2 dan 3 selesai:

```sql
SELECT 'companies' AS t, count(*) FROM public.companies
UNION ALL SELECT 'users', count(*) FROM public.users
UNION ALL SELECT 'user_roles', count(*) FROM public.user_roles
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'customers', count(*) FROM public.customers
UNION ALL SELECT 'sales_orders', count(*) FROM public.sales_orders
UNION ALL SELECT 'audit_logs', count(*) FROM public.audit_logs
UNION ALL SELECT 'roles (should stay 8)', count(*) FROM public.roles
UNION ALL SELECT 'permissions (should stay 65)', count(*) FROM public.permissions;
```

Ekspektasi: semua baris `0` kecuali `roles` (tetap 8) dan `permissions`
(tetap 65). Plus re-run
`scripts/adhoc-gate-3e-d0-hosted-inventory.mjs` penuh dan konfirmasi
`GRAND TOTAL rows` = 0 dan `auth.users` = 0.

Snapshot/export metadata non-secret untuk keperluan rollback administratif
akan dibuat sesaat sebelum eksekusi destructive (berisi §3 di atas plus
timestamp final — TIDAK berisi password, token, hash, service-role key,
atau credential apa pun).

## 9. STOP — otorisasi destructive cleanup

Tahap ini **AUDIT-ONLY**. Tidak ada mutasi yang dijalankan terhadap
hosted project. Rencana cleanup di §4–§8 di atas siap dieksekusi, tetapi
**menunggu otorisasi eksplisit terpisah dari Founder** sebelum:

1. Snapshot/export metadata non-secret dibuat, lalu
2. SQL transaction (§6 langkah 2) dijalankan, lalu
3. Auth cleanup Admin API (§6 langkah 3) dijalankan.

Mengikuti pola Gate 3D-B3-F5: eksekusi SQL/Admin API sebaiknya dilakukan
oleh operator sendiri (bukan otomatis oleh Claude Code), mengingat sifat
permanent data deletion di database hosted.
