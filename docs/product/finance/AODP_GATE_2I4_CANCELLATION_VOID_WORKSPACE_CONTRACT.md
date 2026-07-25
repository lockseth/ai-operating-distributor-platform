# AODP Gate 2I.4 — Cancellation & Invoice Void Workspace Contract (Freeze)

## 0. Status

**FREEZE, bukan implementasi.** Slice ini mengaktifkan tab **Cancellation &
Invoice Void** dan **Riwayat Audit** pada Finance Operations Workspace
(`AODP_GATE_2I_FINANCE_OPERATIONS_WORKSPACE_CONTRACT.md`, selanjutnya
"master contract"), menutup responsive hardening seluruh workspace, dan
mengunci keputusan G11 (retire `/dashboard/collection` lama). Tidak ada
migration/RPC/permission/tabel baru pada gate ini — backend Gate 2G
(`20260901000001_order_cancellation_invoice_void.sql`) sudah final/PASS dan
tidak disentuh.

Sumber kebenaran yang diverifikasi langsung untuk dokumen ini:
migration Gate 2G, `order-cancellation-invoice-void.integration.test.ts`,
`apps/web/src/lib/finance/queries.ts`/`actions.ts`/`error-messages.ts`,
`dashboard/finance/layout.tsx`, `components/finance/action-queue.tsx`,
`components/dashboard/status-badge.tsx`, `components/ui/confirm-dialog.tsx`,
`dashboard/finance/returns/[id]/page.tsx` + `components/finance/return-panels.tsx`
(pola request/decide terdekat), `20260819000001_activity_audit_log_foundation.sql`
(RLS `audit_logs`), `dashboard/owner/activity-log/page.tsx` +
`lib/audit-log/format.ts`, `dashboard/collection/page.tsx` (placeholder lama),
serta seluruh route `dashboard/finance/*` yang sudah ada (2I.1–2I.3) untuk
audit responsive.

---

## A. Batas Slice

- Mutation production HANYA lewat `request_order_cancellation_atomic` dan
  `approve_order_cancellation_atomic` (migration 20260901000001). Tidak ada
  tabel, enum, RPC, trigger, permission, atau ledger formula baru.
- `company_id`/`actor_id` SELALU dari `getAuthUser()` (session tepercaya),
  tidak pernah dari input browser — pola identik `orders/actions.ts` dan
  seluruh `lib/finance/actions.ts` existing.
- Read: session-scoped client (`lib/supabase/server.ts` `createClient()`),
  tunduk RLS `order_cancellations_select`/`invoice_voids_select`
  (`receivable.view`, migration 20260901000001 §5). Admin/service-role
  **hanya** di server action untuk memanggil RPC canonical (pola identik
  `actions.ts` existing).
- Tidak ada optimistic update pada request/decision cancellation — menunggu
  konfirmasi server, `revalidatePath()` sesudahnya (pola §5 master contract).

---

## B. Route & Navigasi

### B.1 Aktivasi tab

`FinanceSection` (`components/finance/finance-tab-nav.tsx`) diperluas dengan
field opsional `disabledReason?: string` (menggantikan tooltip statis
"Tersedia pada tahap implementasi berikutnya" untuk entry tanpa `href` dengan
alasan spesifik bila ada). `FINANCE_SECTIONS` di `dashboard/finance/layout.tsx`
menjadi dihitung per-user (layout sudah `async` dan sudah punya `user`):

| Tab | href | Kondisi |
|---|---|---|
| Cancellation & Invoice Void | `/dashboard/finance/cancellations` | Selalu aktif untuk user yang lolos guard layout (`receivable.view`) — sama seperti tab lain. |
| Riwayat Audit | `/dashboard/finance/audit` bila `user.roles.includes("owner")`, else `undefined` | **Owner-only** (lihat §H) — non-owner melihat tab non-aktif dengan `disabledReason="Hanya Owner yang dapat membuka Riwayat Audit"`, BUKAN tautan 404 dan BUKAN "tahap berikutnya" (alasannya permanen, bukan sementara). |

### B.2 `/dashboard/finance/cancellations` (list)

- Sumber data: `order_cancellations` join `sales_orders(order_number,
  customers(name))` (pola identik `fetchPendingCancellations` di
  `queries.ts`, tapi TANPA filter `status='requested'` — list ini
  menampilkan semua status, action queue yang membatasi ke `requested`).
- Kolom: nomor order, customer, status (`StatusBadge domain="cancellation"`
  — sudah ada di `status-badge.tsx`, tidak perlu extend), reason_code,
  diajukan oleh/waktu, diputuskan oleh/waktu (bila final).
- Ordering: `status='requested'` diprioritaskan (pola identik
  `RETURN_STATUS_PRIORITY`/`REFUND_STATUS_PRIORITY` di `queries.ts` — tambah
  `CANCELLATION_LIST_STATUS_PRIORITY` konstanta sejenis), lalu
  `requested_at DESC`.
- Limit: `.limit(200)` tanpa pagination penuh — konsisten `getReturnList`/
  `getRefundList` (volume cancellation diasumsikan rendah, sama seperti
  return/refund; BUKAN `getInvoiceList` yang memang berpaginasi karena
  volume tinggi).
- Empty/loading/error: pola identik `returns/page.tsx`/`credit/page.tsx`
  (`AlertCard` untuk `user.isDemo`, try/catch `loadError` + pesan generik,
  `EmptyState` bila kosong).
- Responsive: `DataTable` desktop (`hidden md:block`) + card-list mobile
  (`md:hidden`, inline `<li>` sama pola `action-queue.tsx`/`invoices/page.tsx`
  — BUKAN component generic terpisah, karena `RecordCardList` generic
  TIDAK PERNAH dibangun di 2I.1–2I.3 meski direncanakan sebagai GAP G6 di
  master contract; pola aktual yang berjalan adalah card-list inline
  per-halaman, kontrak ini mengikuti pola YANG SUDAH ADA, bukan yang
  direncanakan).

### B.3 `/dashboard/finance/cancellations/[id]` (detail, halaman penuh)

- Sumber: query baru `getCancellationDetail(companyId, cancellationId)` —
  order_cancellations + sales_orders + invoices (bila ada) +
  invoice_receivable_balances + keberadaan payment_allocation/credit_notes
  + invoice_voids (bila approved & invoiced) — lihat §E untuk preview.
- Cross-tenant: `null` untuk cancellation milik company lain (RLS +
  `.eq("company_id", companyId)`, pola identik `getReturnDetail`) →
  `notFound()` di page (pola identik `returns/[id]/page.tsx`).
- Aksi: `RequestCancellationPanel` (dipakai di halaman detail invoice, §B.4)
  dan `DecideCancellationPanel` (dipakai di halaman ini, §D).
- **Bukan drawer** — halaman `[id]` penuh (master contract §2.2), pola
  identik `returns/[id]/page.tsx`.

### B.4 Link dari invoice detail

`dashboard/finance/invoices/[id]/page.tsx` (belum menyebut cancellation sama
sekali — diverifikasi langsung) ditambah section "Ajukan Pembatalan Order"
(`RequestCancellationPanel`, permission `order_cancellation.request`,
disabled+alasan bila tidak punya izin — pola identik `RequestReturnPanel`)
DAN, bila invoice punya cancellation terkait, link ke
`/dashboard/finance/cancellations/[id]` (pola identik link retur/credit note
yang sudah ada di halaman itu, §6 master contract).

### B.5 `/dashboard/finance/audit` (Owner-only)

- Guard ganda: (1) `finance/layout.tsx` (`receivable.view`, guard existing);
  (2) page-level: `if (user.isDemo || !user.roles.includes("owner"))` →
  tampilkan `AlertCard` "Hanya Owner yang dapat membuka Riwayat Audit"
  (BUKAN `redirect()` — user sudah lolos layout guard, redirect ke
  `/dashboard` akan membingungkan; pola beda dari
  `dashboard/owner/activity-log/page.tsx` yang redirect karena route itu
  TIDAK dilindungi layout finance).
- Query: reuse pola `dashboard/owner/activity-log/page.tsx` PERSIS (session
  client, `applyAuditLogFilters`, `formatJakartaDateTime`, `redactSensitive`,
  `summarizeChange`) TAPI ditambah filter tetap `.eq("module", "finance")`
  (kontrak §H master: "module=finance"). Tidak membuat formatter/redaction
  baru — reuse `lib/audit-log/format.ts` (GAP G8 master contract sudah
  diselesaikan gate sebelumnya: `formatJakartaDateTime` sudah dipakai
  lintas modul finance, cukup import).
- Pagination: identik `activity-log/page.tsx` (`PAGE_SIZE=20`, `range()`,
  `count: "exact"`).
- Filter: minimal `from`/`to`/`actor`/`action`/`entity`, reuse
  `AuditLogFilters` component ATAU subset kolom bila component itu terlalu
  general-purpose untuk scope finance — keputusan implementasi, tidak
  membuat filter UI baru dari nol.
- Error state: query gagal → pesan error eksplisit (pola `loadError`
  finance existing), **bukan** `EmptyState` yang menyamarkan kegagalan
  sebagai "belum ada aktivitas" (master contract §H: "error tidak boleh
  disamarkan sebagai empty").

---

## C. Request Cancellation

- Actor: Owner, Manager, Admin, Super Admin, Finance — permission
  `order_cancellation.request` (migration 20260901000001 §5, grantee
  persis: owner/manager/admin/super_admin/finance, **bukan sales**).
  Sales/Warehouse/Driver/non-auth ditolak server-side
  (`requirePermission` di `actions.ts`, pola identik `requestReturnAction`).
- Form (`RequestCancellationPanel`, `ConfirmDialog` existing — TIDAK
  membuat dialog baru): pilih satu `sales_order_id` eligible + `reason_code`
  (wajib non-empty, `REASON_CODE_REQUIRED`). Idempotency key
  `crypto.randomUUID()` di-generate SEKALI saat dialog dibuka (state
  `useState`, bukan di-generate ulang tiap klik submit) — pola identik
  `RequestReturnPanel`/`openDialog()`.
- Pilihan order eligible untuk UX (bukan authority): order milik company
  yang belum `status='cancelled'` DAN belum punya
  `order_cancellations.status='requested'` aktif — query read-model,
  RPC tetap validasi ulang (`ORDER_ALREADY_CANCELLED`,
  `ORDER_CANCELLATION_ALREADY_REQUESTED`) sebagai authority final.
- UI **tidak boleh** menyatakan request otomatis membatalkan order — label
  eksplisit: "Pengajuan ini akan menunggu keputusan Owner. Order dan invoice
  tidak berubah sampai disetujui." (mencerminkan RPC:
  `request_order_cancellation_atomic` TIDAK PERNAH menyentuh
  `sales_orders.status`/invoices/ledger — dikonfirmasi dari migration §6
  komentar function).

---

## D. Decision (Owner-only)

- `approve_order_cancellation_atomic` permission `order_cancellation.approve`
  **HANYA owner** (migration §5, `AND r.name = 'owner'` — diverifikasi
  langsung, bukan asumsi).
- Finance/Manager/Admin/Super Admin: tombol approve/reject **disabled**
  dengan alasan terlihat & accessible — label persis
  **"Hanya Owner yang dapat menyetujui atau menolak"** (pola identik
  `VerifyReturnPanel` non-owner state: `title`+`aria-describedby`+
  `sr-only` span).
- Server action (`approveOrderCancellationAction`, baru di `actions.ts`)
  mengecek `hasPermission(user.permissions, "order_cancellation.approve")`
  SEBELUM memanggil RPC — defense kedua (pola identik `verifyReturnAction`)
  — force-enable DOM tetap ditolak sebelum RPC (FIN-02-09).
- `ConfirmDialog` wajib sebelum approve maupun reject (pola identik
  `VerifyReturnPanel`, dua tombol terpisah "Setujui"/"Tolak" masing-masing
  membuka dialog dengan `decision` berbeda).
- Setelah final (`approved`/`rejected`): tombol hilang, diganti
  `StatusBadge` final + (bila rejected) `AlertCard` label **"Ditolak —
  Order dan Invoice tidak berubah"** (pola identik return `AlertCard`
  "Ditolak — Invoice tidak berubah" di `returns/[id]/page.tsx`). Retry ke
  URL lama tidak menghasilkan side effect kedua — RPC menolak
  `ORDER_CANCELLATION_ALREADY_RESOLVED` (dikunci `FOR UPDATE` sebelum
  validasi status, migration §7 bagian B), server action tidak menyamarkan
  error ini sebagai sukses.

---

## E. Preview Dampak Sebelum Approve

`getCancellationDetail()` (baru, `queries.ts`) menghitung — READ-ONLY,
formula IDENTIK precondition RPC (migration §7 bagian D, TIGA lapis
independen), BUKAN authority — mapper deterministic:

| Kondisi order/invoice (dibaca langsung) | Prediksi tampil |
|---|---|
| `sales_orders.status` IN (draft, confirmed, processing, delivering) | "Order akan dibatalkan tanpa dampak ledger." |
| `sales_orders.status = 'delivered'` | Blocked: "Pembatalan memerlukan reversal delivery terlebih dahulu." (RPC: `DELIVERY_REVERSAL_REQUIRED`) |
| `status IN (invoiced, paid)`, invoice tunggal, TIDAK ADA `payment_allocation` di `receivable_ledger`, TIDAK ADA `credit_notes` menunjuk invoice, `outstanding_balance = invoices.total_amount` persis | "Approve akan membuat invoice void penuh sebesar Rp[total_amount] dan membatalkan order." |
| `status IN (invoiced, paid)` tapi salah satu dari tiga syarat di atas gagal | Blocked: tampilkan fakta settlement (ada payment allocation? ada credit note? outstanding berapa vs total?) yang menyebabkan blokir. (RPC: `INVOICE_SETTLEMENT_EXISTS`) |
| Invoice hilang (`INVOICE_RECORD_MISSING`) / lebih dari satu (`MULTIPLE_INVOICES_UNSUPPORTED`) / status di luar lifecycle Gate 2G (`INVALID_ORDER_STATUS_FOR_CANCELLATION`) | Blocked, pesan manusiawi generik — tidak menebak/mengubah data. |

Detail page WAJIB menampilkan sebelum decision: status order, nomor/status/
total invoice (bila ada), `outstanding_balance` canonical, ada/tidaknya
payment allocation, ada/tidaknya credit note, prediksi hasil approve
(tabel di atas), `reason_code`+`requested_by`+`requested_at`, dan bila
final: `decided_by`+`decided_at`+link `invoice_voids`/
`receivable_ledger` credit `invoice_void` (bila ada).

Preview TIDAK PERNAH jadi authority — RPC validasi ulang DI DALAM row lock
saat commit (migration §7 bagian D, lock `sales_orders`+`invoices` SEBELUM
eligibility check). Race (invoice dapat payment/credit note baru setelah
preview di-fetch, sebelum Owner klik approve) → RPC menolak
`INVOICE_SETTLEMENT_EXISTS` di dalam lock; server action menampilkan pesan
"Data telah berubah, silakan muat ulang" (pola §7.2 master contract,
FIN-11-03).

---

## F. Efek Backend (Tidak Berubah — Dikutip dari Migration, Bukan Diasumsikan)

Diverifikasi persis dari `approve_order_cancellation_atomic` (migration §7)
dan integration test (18 skenario, semuanya PASS terhadap Gate 2G):

- Pre-delivery approve: `sales_orders.status='cancelled'`,
  `order_cancellations.status='approved'`, **tanpa** `invoice_voids`/ledger
  entry apa pun (test #1).
- Delivered (belum invoiced) approve: ditolak `DELIVERY_REVERSAL_REQUIRED`,
  order tetap `delivered` (test #6).
- Invoiced/paid untouched approve: TEPAT SATU `invoice_voids` + TEPAT SATU
  `receivable_ledger` credit `entry_type='invoice_void'` sebesar
  `invoices.total_amount` PENUH, order `cancelled`, cancellation `approved`
  — atomic, satu transaksi (test #3, #11).
- Invoiced/paid tersentuh (payment/credit note) approve: ditolak
  `INVOICE_SETTLEMENT_EXISTS`, TANPA partial mutation (test #4, #5).
- Reject (Owner): hanya `order_cancellations.status='rejected'` + audit
  `order_cancellation.rejected` — order/invoice/ledger TIDAK berubah sama
  sekali (test #14).
- Concurrent approve pada cancellation SAMA: hanya SATU sukses, SATU
  `invoice_voids`/ledger entry (test #8, row lock `FOR UPDATE`).
- Tidak menyentuh `payment_receipts`, `payment_allocations`, `returns`,
  `credit_notes`, `refund_requests`, `customer_credit_ledger`, delivery,
  atau inventory — dikonfirmasi migration comment §DEFERRED + tidak ada
  referensi tabel-tabel itu di body kedua RPC selain SELECT read-only untuk
  precondition check (§E).

Workspace TIDAK PERNAH mereplikasi logic ini di client — seluruh angka
final pasca-approve dibaca dari `invoice_voids`/`receivable_ledger`
canonical, bukan dihitung ulang.

---

## G. Error Mapping

Diverifikasi 1:1 terhadap migration 20260901000001. Kode yang SUDAH ada di
`error-messages.ts` (generik, dipakai domain lain juga) TIDAK diduplikasi:

| Kode (sudah ada di `FINANCE_ERROR_MESSAGES`) | Pesan existing dipakai apa adanya |
|---|---|
| `FORBIDDEN` | "Anda tidak memiliki izin untuk melakukan aksi ini." |
| `TENANT_CONTEXT_MISMATCH` | "Data tidak ditemukan pada perusahaan Anda." |
| `REASON_CODE_REQUIRED` | "Alasan retur wajib diisi." — **catatan**: pesan generik ini ditulis untuk konteks retur; untuk cancellation pesan yang sama dipakai apa adanya (RPC error code identik `REASON_CODE_REQUIRED` untuk kedua domain), TIDAK dibuat pesan duplikat khusus cancellation — konsisten prinsip satu kode satu pesan di map ini. |
| `IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` | "Permintaan sebelumnya dengan data berbeda sudah diproses. Muat ulang halaman dan coba lagi." |
| `INVALID_DECISION` | "Keputusan tidak valid." |

Kode BARU (belum ada, wajib ditambah ke `FINANCE_ERROR_MESSAGES` —
migration §6/§7):

| Kode | Pesan Indonesia diusulkan |
|---|---|
| `ORDER_NOT_FOUND` | "Order tidak ditemukan." |
| `ORDER_ALREADY_CANCELLED` | "Order ini sudah berstatus dibatalkan." |
| `ORDER_CANCELLATION_ALREADY_REQUESTED` | "Order ini sudah memiliki pengajuan pembatalan yang belum diputuskan." |
| `ORDER_CANCELLATION_NOT_FOUND` | "Pengajuan pembatalan tidak ditemukan." |
| `ORDER_CANCELLATION_ALREADY_RESOLVED` | "Pengajuan ini sudah diputuskan sebelumnya. Muat ulang halaman untuk melihat status terbaru." |
| `DELIVERY_REVERSAL_REQUIRED` | "Order sudah terkirim — pembatalan memerlukan reversal delivery terlebih dahulu (belum didukung)." |
| `INVOICE_RECORD_MISSING` | "Order ini tidak memiliki data invoice yang valid untuk diproses." |
| `MULTIPLE_INVOICES_UNSUPPORTED` | "Order ini memiliki lebih dari satu invoice — belum didukung." |
| `INVOICE_SETTLEMENT_EXISTS` | "Invoice sudah memiliki pembayaran atau credit note aktif — pembatalan dengan invoice void tidak dapat dilakukan." |
| `INVALID_ORDER_STATUS_FOR_CANCELLATION` | "Status order saat ini tidak dapat diproses untuk pembatalan." |

Kode internal (nama constraint, `pg_temp`, dsb.) tidak pernah bocor ke UI —
`mapFinanceRpcError()` existing sudah menegakkan ini (fallback
`DEFAULT_FINANCE_ERROR_MESSAGE` untuk kode tak dikenal), tidak perlu
perubahan pada fungsi itu sendiri, hanya menambah entri map.

---

## H. Audit Evidence & Konflik RLS (WAJIB, Diaudit Bukan Diasumsikan)

**Temuan terverifikasi** (`20260819000001_activity_audit_log_foundation.sql`
baris 171–187, dan direplikasi perilakunya di
`dashboard/owner/activity-log/page.tsx` baris 253):

```
CREATE POLICY "audit_logs_select" ON public.audit_logs
  FOR SELECT USING (
    company_id = public.get_user_company_id()
    AND EXISTS (... AND r.name = 'owner')
  );
```

**Ini adalah policy SATU-SATUNYA untuk SELECT `audit_logs`** — tidak ada
policy tambahan untuk Finance/Manager/Admin/Super Admin. RLS berlaku penuh
untuk role `authenticated` (session-scoped client), tidak ada bypass selain
`service_role` (di luar cakupan RLS, dan workspace ini TIDAK diizinkan
memakai admin client untuk read — §A).

**Konflik eksplisit dengan master contract**: master contract §4 (tabel
Role & Kewenangan) menyatakan "Lihat riwayat audit finance" tersedia untuk
Owner **DAN** Finance/Manager/Super Admin ("scoped ke module='finance'").
Fakta RLS terverifikasi **bertentangan** dengan baris itu — tidak ada jalur
session-scoped SELECT `audit_logs` untuk role selain Owner, scoped
module apapun tidak relevan karena filter `module` diterapkan SETELAH RLS,
dan RLS sudah menolak baris tersebut sepenuhnya untuk non-owner.

**Keputusan dibekukan gate ini (opsi 1 dari instruksi gate — tanpa
migration)**:

1. `/dashboard/finance/audit` diimplementasikan **Owner-only** (§B.5) —
   tab non-aktif dengan alasan eksplisit bagi Finance/Manager/Admin/Super
   Admin, BUKAN 404, BUKAN silent empty state.
2. Master contract §4 baris "Lihat riwayat audit finance" **dicatat sebagai
   AMANDEMEN TERDOKUMENTASI** oleh temuan gate ini (backend Gate 1D-A
   `20260819000001` — bukan keputusan produk baru dari gate ini, melainkan
   fakta backend yang lebih ketat dari yang diasumsikan master contract
   saat ditulis) — bukan gate ini yang mengubah RLS, RLS sudah begini
   sebelum gate ini ditulis.
3. **FIN-14-03 (master matrix, actor=Finance) TIDAK dapat PASS** — Finance
   tidak dapat mengakses `/dashboard/finance/audit` sama sekali di bawah
   RLS terverifikasi, sehingga precondition test ini (Finance membuka
   detail audit entry) mustahil tercapai. Status ditandai **BLOCKED**
   pada traceability (§Test Matrix dokumen terpisah), bukan diklaim PASS.
4. **Follow-up direkomendasikan** (bukan dibuat gate ini): gate
   schema/RLS terpisah untuk memperluas SELECT `audit_logs` ke
   Finance/Manager/Admin/Super Admin dengan scope `module='finance'` bila
   produk memang menghendaki akses lebih luas — di luar scope dokumentasi
   ini untuk mengusulkan desain policy tersebut.

Audit query (§B.5) tetap: company-scoped, `module='finance'`, bounded
(`PAGE_SIZE=20`), deterministic (`created_at DESC`), error eksplisit bukan
disamarkan `EmptyState`, memakai `formatJakartaDateTime`/`redactSensitive`
existing — tidak ada raw JSON sensitif dirender.

---

## I. Responsive Hardening

Enumerasi konkret (diverifikasi lewat grep `md:hidden`/`DataTable` di
seluruh `dashboard/finance/**` dan `components/finance/**`), bukan klaim
"semua responsive":

**Sudah punya card-list mobile (tidak disentuh gate ini kecuali regresi
ditemukan saat verifikasi manual)**:
`dashboard/finance/invoices/page.tsx`, `dashboard/finance/returns/page.tsx`,
`dashboard/finance/credit/page.tsx`, `components/finance/action-queue.tsx`
(halaman Ringkasan).

**Belum punya card-list mobile — WAJIB disentuh gate ini (FIN-13-01/02)**:

| File | Kondisi saat ini | Perubahan |
|---|---|---|
| `dashboard/finance/payments/page.tsx` | `DataTable` langsung, tanpa `md:hidden` card fallback (diverifikasi, baris ~108) | Tambah card-list mobile inline, pola identik `invoices/page.tsx`, bungkus `DataTable` existing dengan `hidden md:block`. |
| `components/finance/collection-panel.tsx` | Dua `DataTable` (promise list, activity list) tanpa card fallback (diverifikasi) | Tambah card-list mobile inline untuk kedua list. |

**Sudah inherently mobile-safe (bukan tabel lebar, struktur `<div>`
list/card native)** — tidak perlu perubahan: `components/finance/
reconciliation-panel.tsx` (diverifikasi: tidak memakai `DataTable`/`<table>`
sama sekali).

**Baru dibuat gate ini, WAJIB responsive sejak awal (bukan retrofit)**:
`dashboard/finance/cancellations/page.tsx`, `dashboard/finance/audit/page.tsx`
— keduanya mengikuti pola card-list inline yang sama (§B.2, §B.5).

**Detail pages** (`invoices/[id]`, `payments/[id]`, `returns/[id]`,
`credit/[id]`, `cancellations/[id]` baru): bukan tabel baris-per-record
lebar (layout card/grid, bukan tabel horizontal panjang) — `invoices/[id]`
memakai `DataTable compact` untuk lines/ledger (tabel pendek per kolom,
bukan pola yang memaksa horizontal scroll di 375px berdasarkan struktur
kolomnya) — diverifikasi TIDAK memerlukan card-list terpisah, tapi
**wajib dicek manual saat verifikasi** (FIN-13-01/02 browser-UAT) karena
tidak ada cara statis memastikan lebar kolom tanpa merender.

**`ConfirmDialog` mobile**: component existing sudah `max-w-md` +
`p-4` pada overlay (`fixed inset-0 ... p-4`), tombol Setujui/Tolak/Batal
sudah cukup besar (`px-3.5 py-2`) — perlu verifikasi visual 375px
(FIN-13-03) untuk memastikan tidak ada mis-tap, TIDAK PERNAH mengubah
component (dipakai lintas domain, perubahan struktur berisiko regresi
domain lain) kecuali defect nyata ditemukan.

---

## J. Keputusan G11 — LOCK

`(dashboard)/dashboard/collection/page.tsx` (placeholder "Segera Hadir",
diverifikasi: guard `roles.includes()` mentah — bukan `hasPermission`,
4 feature card statis, tidak ada data nyata) diganti isinya menjadi:

```tsx
import { redirect } from "next/navigation";

export default function CollectionRedirectPage() {
  redirect("/dashboard/finance/collection");
}
```

Tidak ada auth check di file ini — otorisasi final dijaga
`(dashboard)/dashboard/finance/layout.tsx` (`receivable.view`) yang
membungkus destination redirect, pola identik shim existing
`(dashboard)/finance/page.tsx` → `redirect("/dashboard/finance")` (master
contract §2.1, tidak diubah). `/dashboard/risk` tidak disentuh (di luar
scope, master contract §2.4).

---

## Rencana File Implementasi (Allowed List)

**File baru (maksimum 6 file produksi)**:

1. `apps/web/src/app/(dashboard)/dashboard/finance/cancellations/page.tsx` — list (§B.2)
2. `apps/web/src/app/(dashboard)/dashboard/finance/cancellations/[id]/page.tsx` — detail (§B.3)
3. `apps/web/src/app/(dashboard)/dashboard/finance/audit/page.tsx` — Owner-only audit (§B.5)
4. `apps/web/src/components/finance/cancellation-panels.tsx` — `RequestCancellationPanel` + `DecideCancellationPanel` (§C/§D)

**File dimodifikasi (maksimum 8 file)**:

5. `apps/web/src/lib/finance/queries.ts` — tambah `getCancellationList`,
   `getCancellationDetail`, fungsi audit list finance (module='finance'
   filter) — TIDAK mengubah fungsi existing.
6. `apps/web/src/lib/finance/actions.ts` — tambah
   `requestOrderCancellationAction`, `approveOrderCancellationAction` —
   pola identik `requestReturnAction`/`verifyReturnAction`.
7. `apps/web/src/lib/finance/error-messages.ts` — tambah 10 entri §G.
8. `apps/web/src/app/(dashboard)/dashboard/finance/layout.tsx` — aktifkan
   href Cancellation & Invoice Void (selalu) dan Riwayat Audit (kondisional
   owner-only, §B.1).
9. `apps/web/src/components/finance/finance-tab-nav.tsx` — tambah field
   `disabledReason?: string` pada `FinanceSection`, render alasan spesifik
   bila ada (fallback ke teks generik existing bila tidak).
10. `apps/web/src/components/finance/action-queue.tsx` — aktifkan
    `deriveDetailHref` untuk `cancellation_pending` (→
    `/dashboard/finance/cancellations/[id]`) dan `invoice_void_notice` (→
    `/dashboard/finance/cancellations/[id]`, sesuai master §3 tabel item 8).
11. `apps/web/src/app/(dashboard)/dashboard/finance/invoices/[id]/page.tsx` —
    tambah section request cancellation + link cancellation terkait (§B.4).
12. `apps/web/src/app/(dashboard)/dashboard/collection/page.tsx` — ganti
    isi jadi redirect (§J, G11).

**Responsive-only (maksimum 2 file, §I)**:

13. `apps/web/src/app/(dashboard)/dashboard/finance/payments/page.tsx`
14. `apps/web/src/components/finance/collection-panel.tsx`

**File test (maksimum 4 file)** — level sesuai test matrix §11 master
contract dan traceability dokumen terpisah:

- `apps/web/src/lib/finance/error-messages.test.ts` (unit — bila belum ada
  file test untuk mapper ini, verifikasi saat implementasi; bila sudah ada,
  extend) — cakup mapping 10 kode baru.
- `apps/web/src/components/finance/cancellation-panels.test.tsx`
  (component) — owner-only disabled state, dialog flow.
- `apps/web/src/app/(dashboard)/dashboard/collection/redirect.test.ts`
  ATAU setara — cakup FIN-16 redirect behavior bila pola test existing
  mendukung route-level test (verifikasi pola saat implementasi, jangan
  membuat test harness baru).
- Server-action-level integration test untuk
  `requestOrderCancellationAction`/`approveOrderCancellationAction` bila
  pola existing (`*.integration.test.ts`) menunjukkan test actions.ts
  terpisah dari RPC integration test Gate 2G (Gate 2G punya integration
  test RPC sendiri yang TIDAK disentuh — test baru ini menguji lapisan
  server action: permission guard, error mapping, revalidatePath).

**Forbidden files** (tidak boleh disentuh gate ini):

- `supabase/migrations/20260901000001_order_cancellation_invoice_void.sql`
  dan `order-cancellation-invoice-void.integration.test.ts` (Gate 2G,
  locked/PASS).
- `supabase/migrations/20260819000001_activity_audit_log_foundation.sql`
  (RLS `audit_logs`, locked — §H tidak mengusulkan perubahan di sini).
- `dashboard/owner/activity-log/page.tsx`, `lib/audit-log/format.ts`
  (di-reuse via import, tidak dimodifikasi).
- `dashboard/risk/*` (di luar scope, master §2.4).
- `components/ui/confirm-dialog.tsx`, `components/ui/data-table.tsx`,
  `components/dashboard/status-badge.tsx` (reuse apa adanya — StatusBadge
  domain `cancellation`/`invoice_void` SUDAH ADA, tidak perlu extend).
- `lib/finance/queries.ts` fungsi-fungsi existing di luar penambahan §G/§B —
  tidak ada refactor.
- `DEMO_AUTH_USER` (`lib/auth/get-user.ts`) — tidak diubah (master §1.2/§12
  G12, keputusan final: unsupported di demo mode).

---

## Bukan Bagian Gate 2I.4 (Eksplisit)

- Tidak ada migration/RPC/permission/tabel baru.
- Tidak ada perubahan RLS `audit_logs` — konflik §H didokumentasikan,
  bukan diperbaiki di sini.
- Tidak ada perubahan `/dashboard/risk`.
- Tidak ada perubahan `DEMO_AUTH_USER`.
- Tidak ada component generic baru di luar `cancellation-panels.tsx` —
  card-list mobile mengikuti pola inline yang SUDAH berjalan (§B.2/§I),
  bukan `RecordCardList` generic yang direncanakan tapi tidak pernah
  dibangun.
- FIN-18-01 s.d. FIN-18-06 (browser E2E lintas-workspace) tetap Gate 2I.5,
  tidak dipindah ke acceptance gate ini.
