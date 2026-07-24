# AODP Gate 2I — Finance Operations Workspace Contract (Freeze)

## 0. Status

**FREEZE, bukan implementasi.** Dokumen ini mengunci kontrak
produk/workflow Finance Operations Workspace — satu permukaan UI yang
menghubungkan backend finance Gate 2A–2H menjadi alur kerja manusia untuk
Finance dan Owner. Tidak ada perubahan production behavior pada gate ini:
tidak ada migration, RPC, komponen frontend, atau server action baru yang
dibuat. Implementasi dilakukan bertahap lewat Gate 2I.1–2I.5 (§13), masing-masing
lewat prompt terpisah setelah kontrak ini disetujui.

Urutan vertical slice AODP (`AODP_PRODUCT_CONSTITUTION.md`):

`Sales Order → Delivery Verification → Invoice → Collection → Owner Alert`

Gate 2A–2H membangun backend finance (ledger, invoice, collection, payment,
reconciliation, return/credit note, cancellation/void, customer credit/refund)
tetapi **tidak ada satupun yang punya UI atau service/query layer** — setiap
RPC hanya dipanggil dari `apps/web/src/lib/finance/*.integration.test.ts`.
Gate 2I menutup gap itu dengan satu kontrak workspace, bukan delapan
dashboard independen.

Gate acuan (source of truth):

- Gate 2A — `AODP_FINANCIAL_CONTRACT.md` + `20260826000001_receivable_ledger_foundation.sql`
  (invoice/receivable ledger, view `invoice_receivable_balances`).
- Gate 2B — `20260827000001_atomic_invoice_issuance.sql` (`issue_invoice_atomic`).
- Gate 2C — `20260828000001_collection_promise_foundation.sql`
  (`record_collection_activity`, `create_promise_to_pay`,
  `correct_promise_to_pay`, `cancel_promise_to_pay`, `mark_promise_broken`).
- Gate 2D — `20260829000001_payment_receipt_proof_allocation.sql`
  (`record_verified_payment_atomic`).
- Gate 2E — `20260830000001_payment_reconciliation_exception.sql`
  (`reconcile_verified_payment`, `correct_payment_reconciliation`, view
  `payment_reconciliation_exceptions`).
- Gate 2F — `20260831000001_return_credit_note_receivable_reduction.sql`
  (`request_return_atomic`, `verify_return_atomic`, `reverse_credit_note_atomic`
  — signature diperluas Gate 2H).
- Gate 2G — `20260901000001_order_cancellation_invoice_void.sql`
  (`request_order_cancellation_atomic`, `approve_order_cancellation_atomic`).
- Gate 2H — `20260902000001_customer_credit_ledger_refund.sql`
  (`request_refund_atomic`, `approve_refund_atomic`, view
  `customer_credit_balances`) + `AODP_GATE_2H_CUSTOMER_CREDIT_REFUND_CONTRACT.md`.

Semua nama RPC, tabel, view, permission, dan error code di dokumen ini
diambil langsung dari migration di atas — **tidak ada yang dikarang**. Bila
sebuah kebutuhan UI tidak didukung nama/struktur yang sudah ada, ditandai
**GAP** (lihat §14) dan bukan mutation baru.

---

## 1. Discovery Summary (dasar kontrak ini)

### 1.1 Routing & layout saat ini

- `(dashboard)/layout.tsx` adalah pass-through kosong; shell nyata ada di
  `(dashboard)/dashboard/layout.tsx` (Sidebar + Header + `{children}`).
- `(dashboard)/finance/page.tsx` sudah ada, isinya **hanya** `redirect("/dashboard/finance")`
  — shim ini dipertahankan apa adanya.
- `(dashboard)/dashboard/finance/page.tsx` (48 baris) adalah **placeholder**:
  guard role `finance`/`super_admin` via `roles.includes()` mentah, render
  `DashboardShell` + satu `StatCard` "Belum tersedia". Komentar di file ini
  eksplisit: `sales_orders.status` (`paid`/`invoiced`) **bukan** sumber
  kebenaran pembayaran/invoice — ini menjadi constraint keras §6.
- Tidak ada middleware role-based; `proxy.ts` → `updateSession()` hanya
  menangani auth/session, bukan permission per-route. Guard sebenarnya ada
  di level page (redirect) **dan** di level RLS Postgres
  (`public.user_has_permission(...)`).
- Tidak ada nav item "Finance" di sidebar hari ini (`components/layout/sidebar.tsx`).
  `/dashboard/finance` hanya terjangkau lewat `getDashboardHref()` (untuk
  user berrole finance) atau URL langsung.
- `/dashboard/collection` dan `/dashboard/risk` adalah halaman placeholder
  terpisah ("Segera Hadir"), bukan bagian dari workspace ini secara
  struktural — lihat §2.4 untuk batas eksplisit.

### 1.2 Role & permission model aktual

Role yang ada (seed `20260626000002_create_users_roles_permissions.sql`):
`super_admin, owner, manager, sales, admin, warehouse, finance, driver`.
Tidak ada role `platform` terpisah — halaman platform digate ke `super_admin`.

Helper resmi (`apps/web/src/lib/auth/permissions.ts`): `hasPermission()`,
`hasAnyPermission()`, `hasRole()`, `isSuperAdmin()`. **Tidak ada React
hook** `useRole`/`usePermission` — semua page adalah server component yang
memanggil `getAuthUser()` lalu redirect kondisional. Sebagian halaman
finance-adjacent memakai `roles.includes()` mentah (finance page, owner
page, collection page, risk page), sebagian memakai helper resmi (orders,
kpi). **Kontrak ini mewajibkan seluruh Finance Operations Workspace memakai
`hasPermission`/`hasAnyPermission`/`hasRole` dari `@/lib/auth/permissions.ts`**,
bukan `roles.includes()` mentah — menstandardkan pola yang sudah ada,
bukan pola baru.

Permission finance yang **sudah** ter-seed di database (tidak ada yang baru
diusulkan gate ini):

| Permission | Grantee roles (persis dari migration) |
|---|---|
| `receivable.view` | owner, manager, admin, super_admin, finance |
| `invoice.issue` | owner, manager, admin, super_admin, finance |
| `collection.record`, `collection.promise` | owner, manager, admin, super_admin, finance |
| `payment.record` | **owner, finance** (tidak termasuk manager/admin/super_admin) |
| `payment.reconcile` | **owner, finance** |
| `return.request` | owner, manager, admin, super_admin, finance |
| `return.verify`, `credit_note.reverse` | **owner saja** |
| `order_cancellation.request` | owner, manager, admin, super_admin, finance |
| `order_cancellation.approve` | **owner saja** |
| `refund.request` | **owner, finance** |
| `refund.approve` | **owner saja** |

Observasi penting yang harus dibekukan sebagai fakta produk (bukan bug):
**`super_admin` TIDAK termasuk** grantee `payment.record`, `payment.reconcile`,
`return.verify`, `credit_note.reverse`, `order_cancellation.approve`,
`refund.request`, `refund.approve`. Artinya hanya **Owner** dan (untuk
sebagian aksi) **Finance** yang bisa mengeksekusi sisi uang — bahkan
super_admin (platform operator) tidak. Sales, warehouse, driver tidak
mendapat satupun permission finance di atas.

Setiap RPC mem-`REVOKE ALL ... FROM PUBLIC, anon, authenticated` dan hanya
`GRANT EXECUTE ... TO service_role` — dipanggil lewat admin client dari
server action (pola sama seperti `apps/web/src/lib/orders/actions.ts`),
dan RPC itu sendiri melakukan pengecekan permission ulang di dalam body
(`JOIN role_permissions/permissions ... RAISE EXCEPTION 'FORBIDDEN'`). Jadi
guard UI adalah UX layer; RPC + RLS adalah source of truth otorisasi.

**Demo mode**: `DEMO_AUTH_USER` (`lib/auth/get-user.ts`) memberi role
`["owner"]` dengan daftar permission tetap yang **tidak memuat satupun**
permission finance di atas (`receivable.view`, `invoice.issue`, dst tidak
ada dalam daftar). **Keputusan dibekukan**: Finance Operations Workspace
**tidak didukung pada demo mode** di v1 — bila `user.isDemo === true`,
tampilkan banner "Fitur ini belum tersedia pada mode demo" dan sembunyikan
seluruh action button (read-only kosong). Ini menghindari scope creep
mengubah `DEMO_AUTH_USER` pada gate ini.

### 1.3 Data canonical (tabel/view yang dibaca, tidak ada yang baru)

| Domain | Tabel/view canonical |
|---|---|
| Invoice & Piutang | `invoices`, `invoice_lines`, `receivable_ledger`, view `invoice_receivable_balances` (`outstanding_balance`, `financial_status`) |
| Collection & Janji Bayar | `promises_to_pay`, `collection_activities` |
| Pembayaran & Verifikasi | `payment_receipts`, `payment_proofs`, `payment_allocations` |
| Exception Rekonsiliasi | `payment_reconciliations`, view `payment_reconciliation_exceptions` |
| Retur & Credit Note | `returns`, `return_items`, `credit_notes`, `credit_note_lines`, `credit_note_reversals` |
| Customer Credit & Refund | `customer_credit_ledger`, `refund_requests`, view `customer_credit_balances` |
| Cancellation & Invoice Void | `order_cancellations`, `invoice_voids` |
| Riwayat Audit | `audit_logs` (dibaca langsung, pola sama `dashboard/owner/activity-log/page.tsx`) |

**Tidak ada satupun query/service module** untuk domain-domain ini hari ini
(`apps/web/src/lib/finance/` hanya berisi integration test). Gate 2I.1
akan membuat `apps/web/src/lib/finance/queries.ts` (read) dan
`apps/web/src/lib/finance/actions.ts` (mutation wrapper RPC, pola identik
`apps/web/src/lib/orders/actions.ts`: `"use server"`, `getAuthUser()` +
`hasPermission()` guard, admin client, `revalidatePath`). Ini **GAP
implementasi**, bukan keputusan produk baru — dicatat di §14.

### 1.4 Komponen UI yang dapat dipakai ulang

Tersedia di `apps/web/src/components/ui/`: `PageHeader`, `SectionHeader`,
`DataTable<T>` (generic table + `EmptyState` otomatis), `EmptyState`,
`ChartCard`, `KpiCard`, `AiInsightCard`, `FilterBar`, loading skeleton
(`LoadingState`). Pola action-queue/"perlu perhatian" sudah ada:
`ActionsCard` (`components/executive/actions-card.tsx`) — render
`ExecutiveAction[]` dengan priority badge + deep link, dipakai di
`dashboard/owner/page.tsx`. Pola audit-log UI sudah ada di
`dashboard/owner/activity-log/page.tsx` + helper
`apps/web/src/lib/audit-log/format.ts` (`formatJakartaDateTime`,
`redactSensitive`, `summarizeChange`, label maps).

**Tidak tersedia** (dikonfirmasi — bukan asumsi): generic dialog/modal/drawer
component. `StatusBadge` (`components/dashboard/status-badge.tsx`) di-hardcode
untuk status sales order, tidak bisa dipakai langsung untuk status
invoice/payment/promise/return/refund/cancellation. Formatter currency ada
dua versi berbeda (`formatRupiah` di `lib/document-engine/monetary.ts` —
nilai persis; `formatIDR` lokal di `dashboard/owner/page.tsx` — bentuk
ringkas "Jt/M/Rb"). Formatter tanggal tidak seragam — hanya
`formatJakartaDateTime` di `lib/audit-log/format.ts` yang eksplisit
Asia/Jakarta, sisanya ad hoc per komponen. Keputusan format dibekukan di
§10.

---

## 2. Bentuk Workspace

### 2.1 Satu entry point

**Finance Operations** — route `/dashboard/finance`, menggantikan isi
placeholder `(dashboard)/dashboard/finance/page.tsx` (perubahan file
production ini masuk scope **Gate 2I.1**, bukan gate ini). Shim redirect
`(dashboard)/finance/page.tsx` tidak berubah.

### 2.2 Navigasi internal: sub-route, bukan client-only tab

Instruksi gate melarang "delapan dashboard independen" — bukan melarang
routing. Kontrak ini memilih **sub-route per section di bawah satu shell**,
karena:

- Konsisten dengan pola routing yang sudah dipakai di repo
  (`dashboard/customers/[id]`, `dashboard/orders/[id]`) — bukan pola baru.
- Memenuhi requirement test matrix #16 "deep link ke detail" secara native
  (URL langsung ke tab + item, bukan state client yang hilang saat refresh).
- Tetap satu produk: satu `layout.tsx` baru
  (`apps/web/src/app/(dashboard)/dashboard/finance/layout.tsx`, **GAP
  Gate 2I.1**) me-render tab nav yang konsisten di semua sub-route, dan
  satu guard permission di layout level (`receivable.view` minimum).

Struktur route (semua **GAP Gate 2I.1**, tidak dibuat gate ini):

| Route | Section | Tab label |
|---|---|---|
| `/dashboard/finance` | Ringkasan (default) | Ringkasan / Perlu Tindakan |
| `/dashboard/finance/invoices`, `/invoices/[id]` | Invoice & Piutang | Invoice & Piutang |
| `/dashboard/finance/collection` | Collection & Janji Bayar | Collection & Janji Bayar |
| `/dashboard/finance/payments`, `/payments/[id]` | Pembayaran & Verifikasi | Pembayaran & Verifikasi |
| `/dashboard/finance/reconciliation` | Exception Rekonsiliasi | Exception Rekonsiliasi |
| `/dashboard/finance/returns`, `/returns/[id]` | Retur & Credit Note | Retur & Credit Note |
| `/dashboard/finance/credit`, `/credit/[id]` | Customer Credit & Refund | Customer Credit & Refund |
| `/dashboard/finance/cancellations`, `/cancellations/[id]` | Cancellation & Invoice Void | Cancellation & Invoice Void |
| `/dashboard/finance/audit` | Riwayat audit finance | Riwayat Audit |

Detail view memakai **halaman `[id]` penuh, bukan drawer** — karena tidak
ada drawer primitive di design system (§1.4) dan membangunnya di luar scope
"jangan implementasi frontend" gate ini. Drawer boleh diusulkan sebagai
peningkatan UX di gate implementasi lanjutan, bukan requirement v1.

### 2.3 Sidebar

Tambah satu `NavItem` baru (**GAP Gate 2I.1**, file
`components/layout/sidebar.tsx`): `{ label: "Finance Operations", href:
"/dashboard/finance", permission: "receivable.view" }`. Memakai `permission`
(bukan `roles` array) — konsisten §1.2, dan otomatis benar untuk
owner/manager/admin/super_admin/finance tanpa hardcode daftar role.
Sales/warehouse/driver tidak melihat item ini (tidak ada grant
`receivable.view`).

### 2.4 Batas eksplisit dengan halaman lain

- `/dashboard/collection` (placeholder "Segera Hadir") **bukan** bagian
  workspace ini dan **tidak diubah** gate ini. Tab "Collection & Janji
  Bayar" di dalam Finance Operations adalah halaman baru dan terpisah.
  Keputusan retire/redirect halaman lama ke tab baru adalah keputusan
  produk terpisah — direkomendasikan sebagai follow-up di Gate 2I.4, bukan
  diasumsikan di sini.
- `/dashboard/risk` (Business Guard risk alert) **di luar scope** Gate 2I
  sepenuhnya — beda domain permission (`roles: [super_admin, owner,
  manager]`, tanpa finance), dan CLAUDE.md mengunci "Risk alert Business
  Guard tidak boleh bisa dihapus role sales" sebagai aturan terpisah yang
  tidak disentuh gate ini.

---

## 3. Antrean "Perlu Tindakan" (Action Queue Canonical)

Tidak ada tabel action-queue baru. Setiap item diturunkan dari query
read-only terhadap tabel/view existing (§1.3), digabung di
`apps/web/src/lib/finance/queries.ts` (**GAP Gate 2I.1**) — bukan
materialized view baru kecuali dinyatakan GAP performa (lihat catatan akhir
tabel).

| # | Item | Sumber data | Kondisi masuk | Role lihat | Role bertindak | Primary action | Secondary action | Deep link |
|---|---|---|---|---|---|---|---|---|
| 1 | Invoice jatuh tempo/overdue | `invoice_receivable_balances` | `financial_status IN ('outstanding','partially_paid')` AND `due_date <= today` | owner, manager, admin, super_admin, finance | owner, finance (`payment.record`) untuk catat bayar; owner/finance (`collection.promise`) untuk buat janji bayar | "Catat Pembayaran" | "Buat Janji Bayar" | `/dashboard/finance/invoices/[invoice_id]` |
| 2 | Janji bayar jatuh tempo/terlewat | `promises_to_pay` WHERE `status='open'` | `promised_date <= today` (belum diputuskan `mark_promise_broken`) | owner, manager, admin, super_admin, finance | owner, finance, manager, admin, super_admin (`collection.promise`) | "Tandai Wanprestasi" (`mark_promise_broken`) | "Koreksi Janji" (`correct_promise_to_pay`) | `/dashboard/finance/collection?promise=[id]` |
| 3 | Bukti pembayaran menunggu verifikasi | `payment_receipts` tanpa baris `payment_reconciliations` terkait, atau `payment_reconciliation_exceptions` classification≠matched belum dikoreksi | ada `payment_receipts` baru yang belum direkonsiliasi | owner, finance (`payment.reconcile` untuk melihat detail teknis; view umum `receivable.view`) | owner, finance (`payment.reconcile`) | "Rekonsiliasi" (`reconcile_verified_payment`) | "Lihat Bukti" | `/dashboard/finance/payments/[payment_receipt_id]` |
| 4 | Payment allocation/reconciliation exception | view `payment_reconciliation_exceptions` (`classification != 'matched'`) | baris terbaru per `payment_receipt_id` bukan `matched` | owner, finance | owner, finance (`payment.reconcile`, `correct_payment_reconciliation`) | "Koreksi Rekonsiliasi" | "Lihat Alokasi" | `/dashboard/finance/reconciliation?receipt=[id]` |
| 5 | Return menunggu keputusan | `returns` WHERE `status='requested'` | ada return baru | owner, manager, admin, super_admin, finance (lihat); owner (bertindak) | **owner saja** (`return.verify`) | "Approve/Reject Retur" (`verify_return_atomic`) | "Lihat Bukti Retur" | `/dashboard/finance/returns/[return_id]` |
| 6 | Refund menunggu keputusan Owner | `refund_requests` WHERE `status='requested'` | ada refund request baru | owner, finance (lihat, `refund.request` scope); **owner** bertindak | **owner saja** (`refund.approve`) | "Approve/Reject Refund" (`approve_refund_atomic`) | "Lihat Saldo Credit Note" | `/dashboard/finance/credit/[refund_id]` |
| 7 | Cancellation menunggu keputusan Owner | `order_cancellations` WHERE `status='requested'` | ada cancellation baru | owner, manager, admin, super_admin, finance (lihat); **owner** bertindak | **owner saja** (`order_cancellation.approve`) | "Approve/Reject Cancellation" (`approve_order_cancellation_atomic`) | "Lihat Dampak Invoice" | `/dashboard/finance/cancellations/[cancellation_id]` |
| 8 | Invoice void/reversal perlu perhatian | `invoice_voids` baru (24–72 jam terakhir, untuk visibilitas — bukan "perlu tindakan" karena void sudah final) ATAU `credit_note_reversals` baru | invoice void/reversal baru dibuat | owner, manager, admin, super_admin, finance | read-only (tidak ada aksi lanjutan — final state) | "Lihat Detail" | — | `/dashboard/finance/cancellations/[cancellation_id]` atau `/dashboard/finance/returns/[return_id]` |

Untuk setiap item: **state sukses** = re-fetch queue setelah mutation
sukses (item hilang dari antrean bila kondisi masuk tidak lagi terpenuhi);
**state gagal** = toast error dengan pesan dari server action, item tetap
di antrean; **state loading** = skeleton row (pakai `LoadingState`
primitive existing); **state stale/conflict** = lihat §7.4.

**GAP performa (dicatat, tidak diasumsikan)**: bila jumlah invoice/promise
per company besar, query gabungan 8 sumber di atas setiap page-load bisa
lambat. Bila profiling di Gate 2I.1 menunjukkan ini masalah nyata, boleh
diusulkan server-side read model (view/materialized view) sebagai gate
implementasi terpisah — **tidak dibuat sekarang**, hanya dicatat sebagai
kemungkinan follow-up.

---

## 4. Role & Kewenangan

| Aksi | Owner | Finance | Manager/Admin | Super Admin | Sales/Warehouse/Driver | Non-auth | Cross-tenant |
|---|---|---|---|---|---|---|---|
| Lihat workspace (`receivable.view`) | ✅ | ✅ | ✅ | ✅ | ❌ tidak ada nav/route access | ❌ redirect login | ❌ RLS `company_id` blokir |
| Issue invoice (`invoice.issue`) — via alur delivery, bukan tombol manual di workspace ini (lihat §5.1) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Catat aktivitas/janji bayar (`collection.record`, `collection.promise`) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Catat pembayaran (`payment.record`) | ✅ | ✅ | ❌ **read-only** | ❌ **read-only** | ❌ | ❌ | ❌ |
| Rekonsiliasi (`payment.reconcile`) | ✅ | ✅ | ❌ **read-only** | ❌ **read-only** | ❌ | ❌ | ❌ |
| Ajukan retur (`return.request`) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Verifikasi retur / reverse credit note (`return.verify`, `credit_note.reverse`) | ✅ **satu-satunya** | ❌ read-only | ❌ read-only | ❌ read-only | ❌ | ❌ | ❌ |
| Ajukan cancellation (`order_cancellation.request`) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Approve cancellation (`order_cancellation.approve`) | ✅ **satu-satunya** | ❌ read-only | ❌ read-only | ❌ read-only | ❌ | ❌ | ❌ |
| Ajukan refund (`refund.request`) | ✅ | ✅ | ❌ read-only | ❌ read-only | ❌ | ❌ | ❌ |
| Approve refund (`refund.approve`) | ✅ **satu-satunya** | ❌ read-only | ❌ read-only | ❌ read-only | ❌ | ❌ | ❌ |
| Lihat riwayat audit finance | ✅ | ✅ (scoped ke module='finance') | ✅ (scoped) | ✅ (scoped) | ❌ | ❌ | ❌ |

Catatan wajib:

1. **Owner-only backend action tidak boleh ditampilkan sebagai tombol aktif
   ke Finance** — untuk role Finance, tombol "Verifikasi Retur", "Approve
   Refund", "Approve Cancellation" dirender **disabled dengan tooltip/label
   alasan** ("Hanya Owner yang dapat menyetujui"), bukan disembunyikan
   total — supaya Finance tetap tahu status/alasan tanpa bisa mengklik.
   Manager/Admin/Super Admin: sama, plus tombol `payment.record`,
   `payment.reconcile`, `refund.request` juga disabled dengan alasan (bukan
   permission mereka meski mereka bisa lihat).
2. Manager/Admin/Super Admin memang **memiliki** `invoice.issue`,
   `collection.record/promise`, `return.request`, `order_cancellation.request`
   di DB — tombol-tombol itu aktif untuk mereka, bukan read-only. Hanya
   4 aksi eksekusi uang (`payment.record`, `payment.reconcile`,
   `refund.request`, dan seluruh aksi approve/verify/reverse) yang
   dibatasi owner/finance atau owner saja.
3. Cross-tenant: seluruh query/RPC sudah scoped `company_id` dari
   `getAuthUser().company_id` dan RLS — workspace tidak menambah mekanisme
   isolasi baru, hanya mewarisi yang sudah ada.
4. Non-authorized (role tanpa permission apapun di atas — sales, warehouse,
   driver) yang mengakses URL langsung: redirect ke `/dashboard` (pola
   sama seperti halaman finance existing).

---

## 5. Detail Workflow per Domain

Pola umum berlaku ke semua domain kecuali disebutkan lain:

- **Confirmation dialog** wajib sebelum memanggil RPC apapun yang mengubah
  status (approve/reject/verify/reverse/record/reconcile) — **GAP**:
  belum ada komponen dialog reusable (§1.4); Gate 2I.1 membuat satu
  `ConfirmDialog` generic dipakai di semua domain, bukan dialog per-domain.
- **Idempotency**: setiap mutation yang RPC-nya menerima
  `p_idempotency_key` (payment record, promise create/correct/cancel/broken
  bila ada, refund request/approve, reconciliation) **wajib** dikirim
  idempotency key yang di-generate client **sekali per percobaan
  dialog-terbuka** (disimpan di state dialog, bukan di-generate ulang tiap
  klik submit) — supaya retry setelah network error memakai key yang sama
  dan RPC menolak duplikasi alih-alih membuat baris kedua.
- **Refresh/invalidation**: server action memanggil `revalidatePath()`
  untuk route workspace terkait setelah RPC sukses (pola
  `orders/actions.ts`) — bukan optimistic update (§10).
- **Error handling**: RPC error (`RAISE EXCEPTION` dengan kode seperti
  `FORBIDDEN`, `AMOUNT_EXCEEDS_OUTSTANDING`, dll) ditangkap server action,
  di-mapping ke pesan Indonesia yang sudah manusiawi, dilempar sebagai
  `Error` (pola sama `orders/actions.ts`), ditampilkan sebagai toast/inline
  error di form — **RPC error code asli tidak boleh bocor mentah ke UI**
  (selaras CLAUDE.md: "Jangan mengekspos logika internal di respons API
  publik").

### 5.1 Invoice & Piutang (Gate 2A/2B)

- **List view**: `DataTable` atas `invoice_receivable_balances`, kolom
  lihat §6.
- **Manual issuance tidak ada tombol di workspace ini** — `issue_invoice_atomic`
  memerlukan `p_order_id` dengan order berstatus `delivered` dan tepat satu
  delivery; ini bagian alur Delivery Verification (vertical slice
  `Sales Order → Delivery Verification → Invoice`), bukan tindakan yang
  diinisiasi dari Finance workspace. **GAP produk**: bila Finance perlu
  memicu issuance manual dari sini (bukan otomatis dari delivery), ini
  perlu keputusan produk terpisah — **tidak diasumsikan** di kontrak ini.
  Workspace ini murni **membaca** invoice yang sudah terbit.
- **Detail view**: `/dashboard/finance/invoices/[id]` — header invoice +
  breakdown `invoice_lines` + riwayat `receivable_ledger` untuk invoice
  tsb + link ke order/delivery/payment/return/credit note/refund terkait
  (lihat §6).
- **Filter**: nomor invoice, customer, rentang tanggal terbit/jatuh tempo,
  `financial_status`, aging bucket.
- **Status label**: `outstanding` → "Belum Dibayar", `partially_paid` →
  "Dibayar Sebagian", `paid` → "Lunas".
- **Audit evidence**: `invoice.issued` (dibuat di alur delivery, bukan di
  sini) — workspace hanya menampilkan entri ini di riwayat audit invoice,
  tidak membuatnya.

### 5.2 Collection & Janji Bayar (Gate 2C)

- **List view**: `promises_to_pay` (status `open`/`broken` prioritas atas)
  + `collection_activities` sebagai riwayat per invoice.
- **RPC canonical**: `record_collection_activity`, `create_promise_to_pay`,
  `correct_promise_to_pay`, `cancel_promise_to_pay`, `mark_promise_broken`.
- **Status label**: `open` → "Aktif", `corrected` → "Dikoreksi",
  `cancelled` → "Dibatalkan", `broken` → "Wanprestasi".
- **Validasi UI sebelum submit** (mencerminkan validasi RPC, bukan
  duplikasi logic — hanya UX pre-check): nominal janji ≤ outstanding
  invoice saat ini, tanggal janji ≥ hari ini. RPC tetap sumber kebenaran
  final (`AMOUNT_EXCEEDS_OUTSTANDING`, `PROMISE_DATE_IN_PAST`).
- **Cegah double-promise**: hanya satu `open` promise per invoice
  (`ACTIVE_PROMISE_EXISTS`) — UI menyembunyikan tombol "Buat Janji Bayar"
  bila invoice sudah punya promise `open`, ganti dengan "Koreksi"/"Batalkan".
- **Audit**: `collection.attempt_recorded`, `collection.outcome_recorded`,
  `collection.promise_created`, `collection.promise_corrected`,
  `collection.promise_cancelled`, `collection.promise_broken`.

### 5.3 Pembayaran & Verifikasi (Gate 2D)

- **List view**: `payment_receipts` + join `payment_allocations` (invoice
  mana saja yang menerima alokasi) + `payment_proofs` (jumlah bukti
  terlampir).
- **RPC canonical**: `record_verified_payment_atomic(p_company_id,
  p_actor_id, p_method, p_amount, p_proofs, p_allocations,
  p_transfer_reference, p_idempotency_key)`.
- **Form input wajib**: minimal 1 proof (`PROOF_REQUIRED`), minimal 1
  alokasi invoice (`ALLOCATION_REQUIRED`), total alokasi harus sama dengan
  `p_amount` (`ALLOCATION_TOTAL_MISMATCH`) — UI menampilkan running total
  vs nominal pembayaran secara real-time sebagai bantuan, bukan
  menggantikan validasi server.
- **Cegah double-allocation**: satu invoice tidak boleh muncul dua kali
  dalam satu form alokasi (`DUPLICATE_INVOICE_IN_ALLOCATION`); alokasi
  tidak boleh melebihi outstanding invoice saat commit
  (`ALLOCATION_EXCEEDS_OUTSTANDING` — dicek ulang di dalam row lock server,
  bukan dari snapshot yang dikirim client, sehingga aman dari stale data).
- **Status label**: tidak ada status di `payment_receipts` sendiri — status
  yang relevan datang dari reconciliation (§5.4).
- **Audit**: `payment.recorded`.

### 5.4 Exception Rekonsiliasi (Gate 2E)

- **List view**: view `payment_reconciliation_exceptions`
  (`classification != 'matched'`).
- **RPC canonical**: `reconcile_verified_payment(p_company_id, p_actor_id,
  p_payment_receipt_id, p_method, p_idempotency_key)`,
  `correct_payment_reconciliation(...)` (wajib `p_reason`, tidak boleh
  kosong — `REASON_REQUIRED`).
- **Status label**: `matched` → "Cocok", `partially_matched` → "Cocok
  Sebagian", `unmatched` → "Tidak Cocok", `overpaid` → "Kelebihan Bayar".
  `shortpaid` ada di domain CHECK tapi **tidak pernah** diproduksi RPC
  manapun (limitation Gate 2E terdokumentasi) — UI tidak perlu
  menampilkannya sebagai kemungkinan hasil aktif, hanya sebagai nilai enum
  yang secara teori valid.
- **Append-only, bukan status transition**: setiap reconcile/correct
  menulis baris baru (`previous_reconciliation_id` menunjuk baris
  sebelumnya) — UI menampilkan **riwayat** reconciliation per payment
  receipt, bukan satu baris yang di-update.
- **Cegah double-verification**: `reconcile_verified_payment` mengunci
  `payment_receipts` FOR UPDATE sebelum idempotency check — bila dua user
  klik "Rekonsiliasi" bersamaan pada payment yang sama, request kedua akan
  menunggu lock lalu (dengan idempotency key berbeda) tetap diproses
  sebagai correction baru, bukan silent duplicate. UI: setelah submit
  pertama sukses, sembunyikan tombol "Rekonsiliasi" awal dan ganti dengan
  "Koreksi Rekonsiliasi" (state berbeda, `p_reason` wajib).
- **Audit**: `reconciliation.matched/partially_matched/unmatched/overpaid`
  (pertama kali), `reconciliation.corrected`/`reconciliation.unmatched_again`
  (koreksi berikutnya).

### 5.5 Retur & Credit Note (Gate 2F)

- **List view**: `returns` (prioritaskan `status='requested'`) + link ke
  `credit_notes` bila sudah `approved`.
- **RPC canonical**: `request_return_atomic(...)` (semua role dengan
  `return.request`), `verify_return_atomic(...)` (**owner only**,
  `p_decision` approve/reject).
- **Data wajib terlihat sebelum keputusan Owner**: nominal retur per item,
  outstanding invoice saat ini, hasil kalkulasi `applied_amount =
  LEAST(total, outstanding)` dan `customer_credit_amount = total - applied`
  **ditampilkan sebagai preview sebelum tombol approve diklik** (read-only
  query, bukan re-implementasi formula RPC di client — angka final tetap
  dari response RPC setelah commit).
- **Status label**: `requested` → "Menunggu Verifikasi", `approved` →
  "Disetujui", `rejected` → "Ditolak".
- **Reject tidak boleh divisualisasikan seolah membatalkan invoice** — label
  eksplisit "Ditolak — Invoice tidak berubah" saat status `rejected`.
- **RETURN_ALREADY_RESOLVED**: setelah `verify_return_atomic` dipanggil
  sekali (approve atau reject), tombol approve/reject hilang, diganti label
  status final — mencegah percobaan approve kedua kalinya di UI (RPC juga
  menolak di server sebagai pertahanan kedua).
- **Audit**: `return.requested`, `return.rejected`/`return.approved`,
  `credit_note.issued`, `credit_note.applied` (hanya bila
  `applied_amount>0`), `receivable.adjusted`.

### 5.6 Customer Credit & Refund (Gate 2H)

- **List view**: `refund_requests` (prioritaskan `status='requested'`) +
  `customer_credit_balances` (per `credit_note_id`: `ledger_balance`,
  `pending_reserved`, `available_balance`).
- **RPC canonical**: `request_refund_atomic(p_company_id, p_actor_id,
  p_credit_note_id, p_amount, p_method, p_proof_reference,
  p_transaction_date, p_idempotency_key)` (owner/finance),
  `approve_refund_atomic(p_company_id, p_actor_id, p_refund_id, p_decision)`
  (**owner only**).
- **Single credit-note bucket — WAJIB, bukan opsi UX**: form refund request
  **wajib** memilih tepat satu `credit_note_id` dari picker yang menampilkan
  `available_balance` per credit note (bukan saldo gabungan semua credit
  note customer). Dilarang keras (kontrak Gate 2H §3): tidak boleh ada
  input "refund dari saldo customer" yang mengagregasi lintas credit note,
  tidak boleh ada FIFO/"pakai bucket tertua dulu", tidak boleh ada
  penggabungan beberapa credit note dalam satu request. `refund_requests.credit_note_id`
  adalah `NOT NULL` tunggal secara struktural — UI harus mencerminkan
  batasan ini secara eksplisit, bukan menyembunyikannya di belakang UX
  yang terlihat seperti saldo tunggal.
- **Reversal interaction**: bila credit note sudah `reversed`
  (`credit_note_reversals`), refund request baru pada credit note tsb
  **ditolak** (`CREDIT_NOTE_REVERSED`) — UI menyembunyikan tombol "Ajukan
  Refund" untuk credit note yang sudah reversed, tampilkan label "Sudah
  Direverse". Sebaliknya, bila ada refund `requested` (pending) atau
  `approved` pada credit note, tombol "Reverse Credit Note" (`credit_note.reverse`,
  owner only, di tab Retur & Credit Note) disabled dengan alasan
  (`PENDING_REFUND_EXISTS` / `REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN`).
- **Status label**: `requested` → "Menunggu Persetujuan", `approved` →
  "Disetujui", `rejected` → "Ditolak".
- **Idempotent approve retry**: bila `approve_refund_atomic` dipanggil dua
  kali dengan refund yang sudah `approved` (retry jaringan), RPC
  mengembalikan hasil pertama tanpa menulis ulang
  (`out_already_exists=TRUE`) — UI tidak perlu mekanisme retry khusus,
  cukup kirim ulang dengan payload sama bila submit gagal karena timeout.
- **Audit**: `customer_credit.refund_requested`,
  `customer_credit.refund_approved` (di-dedupe oleh partial unique index
  di `audit_logs` per refund — invariant produksi, bukan test-only),
  `customer_credit.refund_rejected`, `customer_credit.credit_reversed`.

### 5.7 Cancellation & Invoice Void (Gate 2G)

- **List view**: `order_cancellations` (prioritaskan `status='requested'`).
- **RPC canonical**: `request_order_cancellation_atomic(...)` (owner/manager/
  admin/super_admin/finance), `approve_order_cancellation_atomic(p_company_id,
  p_actor_id, p_cancellation_id, p_decision)` (**owner only**).
- **Preview dampak SEBELUM approve** (§9): berdasarkan status order saat
  ini, tampilkan salah satu dari tiga skenario yang akan terjadi bila
  di-approve:
  1. Order belum `delivered` → dibatalkan tanpa dampak ledger.
  2. Order `delivered` (belum invoiced) → **tidak bisa langsung di-approve
     di sini**, RPC menolak dengan `DELIVERY_REVERSAL_REQUIRED` — UI
     menampilkan pesan ini sebagai penjelasan, bukan tombol yang gagal
     tanpa konteks.
  3. Order `invoiced`/`paid` → bila invoice masih "polos" (tidak ada
     payment allocation, tidak ada credit note apapun, outstanding =
     total_amount persis), approve akan membuat `invoice_voids` sebesar
     **seluruh** `total_amount`. Bila salah satu syarat gagal, RPC menolak
     `INVOICE_SETTLEMENT_EXISTS` — UI **wajib** menampilkan status
     settlement invoice (ada pembayaran? ada credit note?) di halaman
     detail cancellation sebelum Owner mengklik approve, bukan hanya
     menampilkan error setelah klik gagal.
- **Reject tidak boleh terlihat seperti membatalkan invoice/order** — label
  eksplisit "Ditolak — Order dan Invoice tidak berubah".
- **Audit**: `order_cancellation.requested/rejected/approved`,
  `invoice.voided`, `receivable.adjusted`.

---

## 6. Invoice & Outstanding — Tampilan Minimal (Bekukan)

Kolom wajib pada list dan detail invoice, **seluruhnya dari
`invoice_receivable_balances`/`invoices`/`receivable_ledger`** — dilarang
menghitung ulang outstanding dengan formula UI terpisah:

- Nomor invoice (`invoices.invoice_number`)
- Customer/outlet (`invoices.customer_id` → join `customers.name`)
- Tanggal terbit (`invoices.created_at` atau kolom issued date — verifikasi
  nama kolom persis saat Gate 2I.1 implementasi, tidak diasumsikan di sini)
- Jatuh tempo (`invoices.due_date`)
- Nilai invoice (`invoices.total_amount`)
- Total terbayar/teralokasi (turunan `receivable_ledger` entry_type
  `payment_allocation`)
- Credit note reduction (turunan `receivable_ledger` entry_type
  `credit_note`/`credit_note_reversal`)
- Outstanding canonical (`invoice_receivable_balances.outstanding_balance`)
- Aging/overdue (turunan `due_date` vs hari ini — perhitungan tampilan,
  bukan nilai finansial, boleh dihitung di UI)
- Status collection (promise `open`/`broken` terkait, bila ada)
- Link ke: order asal, delivery asal, payment receipt terkait, return/credit
  note terkait, refund terkait (via `credit_notes.invoice_id`)

---

## 7. Payment & Reconciliation — Alur Manusia

```
proof masuk (payment_receipts + payment_proofs)
  → review/verifikasi (reconcile_verified_payment)
  → allocation (payment_allocations, dibuat bersamaan record_verified_payment_atomic)
  → matched | partially_matched | unmatched | overpaid (payment_reconciliations)
  → resolution/audit (correct_payment_reconciliation bila perlu, atau selesai)
```

Catatan struktural: di backend aktual, **allocation terjadi di dalam RPC
yang sama dengan pencatatan payment** (`record_verified_payment_atomic`
menerima `p_allocations` sekaligus), bukan langkah terpisah setelah proof
masuk. Reconciliation (`reconcile_verified_payment`) adalah langkah
**setelahnya** yang mengklasifikasi hasil alokasi tsb terhadap total
pembayaran. UI harus mencerminkan urutan nyata ini: form "Catat Pembayaran"
menggabungkan proof + alokasi dalam satu submit, lalu (baik otomatis
dipicu maupun via tombol "Rekonsiliasi" manual di action queue #3)
klasifikasi muncul terpisah.

### 7.1 Cegah double verification/allocation

Dijamin backend (row lock + unique constraint), diperkuat UI dengan
menyembunyikan/mendisable tombol setelah state berubah (§5.3, §5.4) — bukan
mekanisme UI baru, hanya mencerminkan state canonical.

### 7.2 Cegah keputusan pada data stale

Setiap detail page melakukan fetch ulang sebelum render tombol aksi (server
component, bukan client cache lama). Untuk aksi yang butuh nominal terkini
(alokasi, refund, retur), form menampilkan `outstanding_balance` /
`available_balance` yang diambil pada saat halaman dibuka **dan** RPC
menghitung ulang nilai yang sama di dalam row lock saat commit — bila
berbeda (race dengan aksi lain), RPC menolak dengan error spesifik
(`ALLOCATION_EXCEEDS_OUTSTANDING`, `REFUND_EXCEEDS_AVAILABLE_BALANCE`, dst)
dan UI menampilkan pesan "Data telah berubah, silakan muat ulang" +
tombol refresh (lihat §11 test matrix kategori stale/concurrent).

### 7.3 Cegah Finance mengambil aksi Owner-only

Tombol tidak dirender aktif untuk role tanpa permission RPC terkait (§4) —
dicek server-side di server action sebelum RPC dipanggil (defense kedua
setelah UI hide/disable), sehingga meskipun tombol dipaksa aktif lewat DOM
manipulation, server action tetap menolak sebelum RPC dipanggil.

### 7.4 Cegah retry menghasilkan duplicate mutation

Idempotency key (§5 pola umum) — RPC yang menerima `p_idempotency_key`
menolak retry dengan payload berbeda (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`/
`IDEMPOTENCY_KEY_PAYMENT_MISMATCH`) dan mengembalikan hasil yang sama untuk
retry dengan payload identik.

---

## 8. Return, Credit Note, Customer Credit, Refund — Tampilan (Bekukan)

- Nilai return: `return_items` (quantity per line) × harga dari
  `invoice_lines` terkait.
- Pengurangan receivable: `credit_notes.applied_amount`.
- Customer credit amount: `credit_notes.customer_credit_amount`.
- Available balance: view `customer_credit_balances.available_balance`
  (`ledger_balance - pending_reserved`).
- Pending reservation: `customer_credit_balances.pending_reserved` (jumlah
  refund `requested` yang belum diputuskan).
- Approved refund: `refund_requests` WHERE `status='approved'`, dengan
  `method`, `proof_reference`, `transaction_date`.
- Remaining balance: `available_balance` setelah refund approved
  (langsung dari view yang sama, tidak dihitung ulang di UI).
- Reversal state: keberadaan baris di `credit_note_reversals` untuk
  `credit_note_id` tsb (boolean tampilan "Sudah Direverse" / tidak).
- Alasan request/reject: kolom `reason_code`/`reason` pada `returns`,
  `order_cancellations`; untuk refund, keputusan `rejected` tidak memiliki
  kolom alasan terstruktur di migration Gate 2H — bila UI butuh alasan
  reject, catat sebagai **GAP** (tidak ada kolom `rejection_reason` di
  `refund_requests` per migration yang dibaca).
- Bukti/reference pembayaran refund: `refund_requests.proof_reference`.
- **Larangan tegas**: UI tidak boleh menawarkan FIFO atau penggabungan
  beberapa credit note dalam satu refund (§5.6) — ini bukan preferensi
  desain, ini kontrak Gate 2H yang dikutip langsung.

---

## 9. Cancellation & Void — Hubungan yang Harus Terlihat

Sebelum Owner menekan approve pada `order_cancellations`, halaman detail
menampilkan (query read-only, bukan hasil RPC):

- Status order saat ini (`sales_orders.status`).
- Status invoice terkait (bila ada) dan `outstanding_balance`-nya.
- Apakah ada `payment_allocations` menyentuh invoice tsb (ya/tidak).
- Apakah ada `credit_notes` (reversed atau tidak) menyentuh invoice tsb
  (ya/tidak).
- Prediksi hasil approve: "Order akan dibatalkan tanpa dampak ledger" /
  "Approve akan memerlukan reversal delivery lebih dulu" / "Approve akan
  membuat invoice void sebesar Rp[total_amount] penuh" / "Approve akan
  ditolak: invoice sudah memiliki pembayaran/credit note" — dipilih
  berdasarkan state di atas, bukan setelah RPC dipanggil dan gagal.

Reject: label "Ditolak — Order dan Invoice tidak berubah" (§5.7).

---

## 10. UX & Responsive Behavior (Bekukan)

- **Desktop**: `DataTable<T>` existing untuk semua list.
- **Mobile**: **GAP** — tidak ada varian card-list di design system hari
  ini; Gate 2I.1 membuat satu component generic (mis. `RecordCardList`)
  yang dipakai seluruh domain, bukan card list per-domain.
- **Detail**: halaman `[id]` penuh, bukan drawer (§2.2).
- **Confirmation dialog**: satu `ConfirmDialog` generic baru (§5, GAP
  Gate 2I.1), dipakai semua aksi sensitif.
- **Status badge**: `StatusBadge` existing di-extend (bukan dibuat dari
  nol) untuk menerima status invoice/payment/promise/return/refund/
  cancellation selain status sales order yang sudah ada — **GAP
  implementasi**, keputusan produk: satu component badge untuk semua
  domain finance, bukan badge per-domain.
- **Action disabled**: selalu disertai alasan singkat terlihat (tooltip
  atau caption di bawah tombol), tidak pernah disabled tanpa penjelasan
  (§4 catatan 1).
- **Pagination/filter/search**: pola sama `DataTable` + `FilterBar`
  existing (dipakai di `dashboard/owner/activity-log`).
- **Currency**: **`formatRupiah`** (`lib/document-engine/monetary.ts`) —
  nilai persis, **bukan** compact "Jt/M/Rb" — dipilih karena workspace ini
  adalah alat pengambilan keputusan finansial (Owner harus melihat angka
  pasti sebelum approve/reject), bukan ringkasan eksekutif. Compact
  formatter (`formatIDR` lokal di `dashboard/owner/page.tsx`) tetap
  eksklusif untuk executive dashboard, tidak dipakai di sini.
- **Tanggal**: **`formatJakartaDateTime`** (`lib/audit-log/format.ts`)
  dijadikan formatter tanggal/waktu canonical untuk seluruh workspace —
  **GAP kecil**: fungsi ini saat ini didefinisikan lokal di modul
  audit-log, perlu dipindah/di-reexport sebagai util bersama
  (`lib/shared/datetime.ts` atau tetap di tempat lalu diimpor lintas
  modul) — keputusan produk: satu formatter, bukan reinvent per halaman
  seperti pola lama.
- **Refresh setelah action**: `revalidatePath()` server-side (§5 pola
  umum), bukan client refetch manual.
- **Optimistic update**: **tidak dipakai sama sekali** di workspace ini —
  seluruh aksi finansial menunggu konfirmasi server sebelum UI berubah,
  sesuai instruksi gate ("action keuangan sensitif sebaiknya menunggu
  konfirmasi server"). Ini keputusan final, bukan default yang bisa
  di-override per domain.
- **Design system global**: tidak diubah gate ini atau gate implementasi
  turunannya — `ConfirmDialog`, `RecordCardList`, extended `StatusBadge`
  adalah komponen baru yang **menambah**, bukan mengubah, primitive yang
  sudah ada.

---

## 11. Test Matrix

Lihat `docs/product/finance/AODP_GATE_2I_FINANCE_OPERATIONS_WORKSPACE_TEST_MATRIX.md`.

---

## 12. GAP Register (Konsolidasi)

| # | GAP | Domain | Alasan | Target Gate |
|---|---|---|---|---|
| G1 | `apps/web/src/lib/finance/queries.ts` (read model) belum ada | Semua | Backend Gate 2A–2H tidak punya query layer sama sekali | 2I.1 |
| G2 | `apps/web/src/lib/finance/actions.ts` (server action wrapper RPC) belum ada | Semua mutation | Sama seperti G1, pola meniru `orders/actions.ts` | 2I.1 |
| G3 | `apps/web/src/app/(dashboard)/dashboard/finance/layout.tsx` (shell + tab nav + guard) belum ada | Workspace shell | Kebutuhan navigasi §2.2 | 2I.1 |
| G4 | Sidebar `NavItem` "Finance Operations" belum ada | Navigasi | §2.3 | 2I.1 |
| G5 | Generic `ConfirmDialog` component tidak ada di design system | Semua aksi sensitif | §1.4, §10 | 2I.1 |
| G6 | Generic mobile card-list component tidak ada | Semua list | §10 | 2I.1 |
| G7 | `StatusBadge` hanya mendukung status sales order | Semua status domain finance | §10 | 2I.1 atau 2I.2 (sesuai domain yang diimplementasi lebih dulu) |
| G8 | Formatter tanggal canonical (`formatJakartaDateTime`) masih lokal di modul audit-log | Semua tampilan tanggal | §10 | 2I.1 |
| G9 | Tidak ada kolom alasan reject terstruktur di `refund_requests` | Customer Credit & Refund | §8 | Perlu keputusan produk terpisah (bukan asumsi Gate 2I) — dicatat, tidak dibuat |
| G10 | Kemungkinan kebutuhan server-side read model bila query action-queue gabungan lambat | Action Queue | §3 catatan performa | Follow-up bila terbukti perlu, bukan sekarang |
| G11 | Retire/redirect `/dashboard/collection` placeholder lama ke tab baru | Collection & Janji Bayar | §2.4 | Follow-up gate terpisah, direkomendasikan 2I.4 |
| G12 | Demo mode tidak mendukung permission finance apapun | Semua | §1.2 — keputusan: unsupported di v1, bukan gap yang perlu ditutup segera | Tidak dijadwalkan (keputusan produk, lihat §1.2) |

---

## 13. Rencana Implementasi Bertahap

Urutan mengikuti rekomendasi instruksi gate — divalidasi cocok dengan
urutan ketergantungan data nyata (read model harus ada sebelum aksi bisa
dibangun; invoice/payment adalah domain dengan volume dan urgensi
tertinggi berdasarkan action queue §3; return/credit/refund bergantung
pada data invoice/payment yang sudah tampil; cancellation/void diletakkan
setelah karena secara backend juga bergantung pada state invoice yang
sudah dipetakan payment/credit-nya, §9):

- **Gate 2I.1**: Workspace shell (`layout.tsx`, sidebar nav, `ConfirmDialog`,
  card-list component, extended `StatusBadge`, formatter canonical),
  `queries.ts` read model, action queue read-only (tanpa tombol aksi aktif
  dulu — hanya tampilan dan deep link).
- **Gate 2I.2**: Invoice & Piutang (read, sudah dari 2I.1) + aksi
  Collection & Janji Bayar + Pembayaran & Verifikasi + Exception
  Rekonsiliasi (domain dengan volume transaksi harian tertinggi).
- **Gate 2I.3**: Return & Credit Note + Customer Credit & Refund (bergantung
  pada invoice/payment yang sudah bisa dilihat dari 2I.2 untuk konteks
  outstanding/settlement).
- **Gate 2I.4**: Cancellation & Invoice Void (butuh visibilitas payment
  allocation + credit note dari 2I.2/2I.3 untuk preview dampak §9), audit
  evidence penuh di semua domain, responsive hardening (mobile card-list
  final polish), keputusan G11 (retire `/dashboard/collection` lama).
- **Gate 2I.5**: Browser E2E dan Owner/Finance UAT lintas seluruh
  workspace.

---

## 14. Bukan Bagian Gate 2I (Eksplisit)

- Tidak ada migration/RPC/permission/tabel baru.
- Tidak ada perubahan pada `/dashboard/risk` (Business Guard).
- Tidak ada perubahan `DEMO_AUTH_USER` (§1.2).
- Tidak ada perubahan design system global di luar penambahan
  `ConfirmDialog`/card-list/badge extension yang dicatat sebagai GAP
  implementasi Gate 2I.1.
- Tidak ada keputusan final soal retire `/dashboard/collection` lama (G11)
  — hanya direkomendasikan sebagai follow-up.
