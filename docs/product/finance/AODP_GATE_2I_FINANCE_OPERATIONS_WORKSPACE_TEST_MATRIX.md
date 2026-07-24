# AODP Gate 2I — Finance Operations Workspace Test Matrix (Freeze)

## 0. Status

Dokumen ini adalah matrix skenario yang **wajib lulus** terhadap
`docs/product/finance/AODP_GATE_2I_FINANCE_OPERATIONS_WORKSPACE_CONTRACT.md`
sebelum masing-masing sub-gate implementasi (2I.1–2I.5) dianggap selesai.
Belum ada implementasi pada gate ini — matrix ini adalah **spesifikasi
test**, bukan hasil test run.

Domain notation dipakai di kolom **Domain**:

- `WS` = Workspace shell, routing, action queue (Gate 2I.1)
- `INV` = Invoice & Piutang
- `COL` = Collection & Janji Bayar
- `PAY` = Pembayaran & Verifikasi
- `REC` = Exception Rekonsiliasi
- `RET` = Retur & Credit Note
- `CCR` = Customer Credit & Refund
- `CXL` = Cancellation & Invoice Void
- `AUD` = Riwayat Audit Finance

Setiap baris: **ID | Domain | Actor | Preconditions | Action | Expected UI |
Expected backend effect | Expected audit | Level | Gate target**.

Level: `unit` (fungsi murni/formatter/mapper), `component` (React
component terisolasi), `integration` (server action + RPC test, pola sama
`apps/web/src/lib/finance/*.integration.test.ts`), `browser-UAT`
(end-to-end lewat browser).

---

## 1. Routing & Navigation Visibility

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-01-01 | WS | Owner | Login, role owner | Buka sidebar | Item "Finance Operations" tampil, mengarah `/dashboard/finance` | Tidak ada | — | component | 2I.1 |
| FIN-01-02 | WS | Finance | Login, role finance | Buka sidebar | Item "Finance Operations" tampil | Tidak ada | — | component | 2I.1 |
| FIN-01-03 | WS | Manager/Admin/Super Admin | Login | Buka sidebar | Item "Finance Operations" tampil (permission `receivable.view`) | Tidak ada | — | component | 2I.1 |
| FIN-01-04 | WS | Sales/Warehouse/Driver | Login | Buka sidebar | Item "Finance Operations" **tidak tampil** | Tidak ada | — | component | 2I.1 |
| FIN-01-05 | WS | Owner | — | Navigasi antar tab (`/invoices`, `/collection`, dst) | Tab aktif ter-highlight, URL berubah sesuai sub-route | Tidak ada | — | browser-UAT | 2I.1 |
| FIN-01-06 | WS | Semua role dengan akses | — | Akses `(dashboard)/finance` | Redirect ke `/dashboard/finance` (shim tidak berubah) | Tidak ada | — | integration | 2I.1 |

## 2. Owner vs Finance vs Unauthorized Access

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-02-01 | WS | Sales | Login role sales | GET `/dashboard/finance` langsung via URL | Redirect ke `/dashboard` | Tidak ada perubahan data | — | integration | 2I.1 |
| FIN-02-02 | WS | Non-auth | Tidak login | GET `/dashboard/finance` | Redirect ke login | Tidak ada | — | integration | 2I.1 |
| FIN-02-03 | PAY | Finance | Login, permission `payment.record` | Buka `/dashboard/finance/payments`, klik "Catat Pembayaran" | Form terbuka, submit berhasil | `record_verified_payment_atomic` sukses | `payment.recorded` | integration | 2I.2 |
| FIN-02-04 | PAY | Manager | Login, tanpa `payment.record` | Buka `/dashboard/finance/payments` | Tombol "Catat Pembayaran" **disabled** dengan alasan "Bukan kewenangan Anda" | RPC tidak dipanggil | — | component | 2I.2 |
| FIN-02-05 | RET | Finance | Login, tanpa `return.verify` | Buka detail return `status=requested` | Tombol "Verifikasi Retur" disabled, alasan "Hanya Owner" | RPC tidak dipanggil | — | component | 2I.3 |
| FIN-02-06 | RET | Owner | Login, `return.verify` | Klik "Verifikasi Retur" → approve | Dialog konfirmasi → sukses, status berubah | `verify_return_atomic` sukses | `return.approved`, `credit_note.issued` | integration | 2I.3 |
| FIN-02-07 | CCR | Finance | Login, tanpa `refund.approve` | Buka detail refund `status=requested` | Tombol approve/reject disabled, alasan "Hanya Owner" | RPC tidak dipanggil | — | component | 2I.3 |
| FIN-02-08 | CXL | Manager | Login, tanpa `order_cancellation.approve` | Buka detail cancellation `status=requested` | Tombol approve/reject disabled | RPC tidak dipanggil | — | component | 2I.4 |
| FIN-02-09 | WS | Finance yang memaksa klik tombol disabled via DOM manipulation | Tombol dipaksa enabled | Submit form aksi owner-only | Server action menolak sebelum RPC dipanggil | Tidak ada perubahan data | — | integration | 2I.1–2I.4 |

## 3. Cross-Tenant Isolation

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-03-01 | INV | Owner Company A | Invoice milik Company B ada di DB | Akses `/dashboard/finance/invoices/[id-company-B]` langsung | 404/empty state, bukan data Company B | RLS `company_id` blokir SELECT | — | integration | 2I.1 |
| FIN-03-02 | PAY | Finance Company A | payment_receipts milik Company B | Coba `reconcile_verified_payment` dengan `p_payment_receipt_id` Company B | Error, tidak ada perubahan | `PAYMENT_RECEIPT_NOT_FOUND`/`TENANT_CONTEXT_MISMATCH` | — | integration | 2I.2 |
| FIN-03-03 | CCR | Owner Company A | refund_requests milik Company B | Coba `approve_refund_atomic` id Company B | Error, tidak ada perubahan | RPC menolak (tenant mismatch/actor validation) | — | integration | 2I.3 |
| FIN-03-04 | WS | Owner Company A | Action queue query | Load `/dashboard/finance` | Hanya item Company A yang tampil | Query di-scope `company_id` | — | integration | 2I.1 |

## 4. List/Detail Data Correctness

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-04-01 | INV | Owner | 3 invoice dengan status berbeda | Buka list invoice | Kolom sesuai §6 kontrak, urut sesuai filter default | Query `invoice_receivable_balances` | — | component | 2I.2 |
| FIN-04-02 | INV | Owner | Invoice dengan payment + credit note | Buka detail invoice | Total terbayar, credit note reduction, outstanding sesuai data | Query gabungan tabel §6 | — | integration | 2I.2 |
| FIN-04-03 | COL | Owner | Promise dengan status `open` | Buka list collection | Label "Aktif" tampil | — | — | component | 2I.2 |
| FIN-04-04 | REC | Owner | Reconciliation dengan 2 baris riwayat (`previous_reconciliation_id`) | Buka detail | Kedua baris riwayat tampil urut waktu, bukan hanya baris terakhir | Query semua baris per `payment_receipt_id` | — | integration | 2I.2 |
| FIN-04-05 | RET | Owner | Return dengan `applied_amount=0`, `customer_credit_amount>0` | Buka detail | UI menampilkan credit note tanpa entri "applied ke invoice" | — | — | component | 2I.3 |
| FIN-04-06 | CCR | Owner | Credit note dengan 2 refund (1 approved, 1 rejected) | Buka detail credit note | `available_balance` mencerminkan hanya refund approved yang mengurangi | Query view `customer_credit_balances` | — | integration | 2I.3 |

## 5. Outstanding dari Nilai Canonical

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-05-01 | INV | Owner | Invoice total 1.000.000, payment_allocation 400.000 | Buka detail invoice | Outstanding tampil 600.000, identik `invoice_receivable_balances.outstanding_balance` | Tidak ada perhitungan ulang di client | — | unit | 2I.2 |
| FIN-05-02 | INV | QA | `sales_orders.status='paid'` tapi tidak ada payment_allocation nyata | Buka detail invoice | Outstanding **tidak** mengikuti `sales_orders.status`, tetap dari ledger | Query tidak menyentuh `sales_orders.status` sama sekali | — | integration | 2I.2 |
| FIN-05-03 | CCR | Owner | Credit note dengan pending refund request | Buka saldo | `available_balance` dikurangi pending, `ledger_balance` tidak | Query view yang sama | — | unit | 2I.3 |

## 6. Action Queue Inclusion & Exclusion

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-06-01 | WS | Owner | Invoice `due_date` hari ini, `outstanding>0` | Buka Ringkasan | Muncul di antrean "Invoice jatuh tempo" | — | — | integration | 2I.1 |
| FIN-06-02 | WS | Owner | Invoice sudah `paid` penuh | Buka Ringkasan | **Tidak** muncul di antrean | — | — | integration | 2I.1 |
| FIN-06-03 | WS | Owner | Payment reconciliation `classification='matched'` | Buka Ringkasan | **Tidak** muncul di "Exception Rekonsiliasi" | — | — | integration | 2I.1 |
| FIN-06-04 | WS | Owner | Reconciliation `classification='overpaid'` belum dikoreksi | Buka Ringkasan | Muncul di antrean exception | — | — | integration | 2I.1 |
| FIN-06-05 | WS | Owner | Return `status='approved'` (sudah diputuskan) | Buka Ringkasan | **Tidak** muncul di "Return menunggu keputusan" | — | — | integration | 2I.1 |
| FIN-06-06 | WS | Owner | Setelah approve refund dari antrean | Refresh Ringkasan | Item refund hilang dari antrean | `revalidatePath` dipanggil | `customer_credit.refund_approved` | browser-UAT | 2I.3 |

## 7. Setiap Permitted Action Sukses

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-07-01 | COL | Finance | Invoice outstanding>0, tanpa promise open | Buat janji bayar valid | Sukses, promise baru tampil "Aktif" | `create_promise_to_pay` | `collection.promise_created` | integration | 2I.2 |
| FIN-07-02 | PAY | Owner | Invoice outstanding>0 | Catat pembayaran valid (1 proof, alokasi = amount) | Sukses, allocation tampil | `record_verified_payment_atomic` | `payment.recorded` | integration | 2I.2 |
| FIN-07-03 | REC | Finance | Payment receipt belum direkonsiliasi | Klik "Rekonsiliasi" | Sukses, klasifikasi tampil | `reconcile_verified_payment` | `reconciliation.matched`/dst | integration | 2I.2 |
| FIN-07-04 | RET | Finance | — | Ajukan retur valid (proof + items) | Sukses, status "Menunggu Verifikasi" | `request_return_atomic` | `return.requested` | integration | 2I.3 |
| FIN-07-05 | RET | Owner | Return `requested` | Approve retur | Sukses, credit note terbentuk | `verify_return_atomic` | `return.approved`, `credit_note.issued` | integration | 2I.3 |
| FIN-07-06 | CCR | Finance | Credit note `available_balance>0` | Ajukan refund valid | Sukses, status "Menunggu Persetujuan" | `request_refund_atomic` | `customer_credit.refund_requested` | integration | 2I.3 |
| FIN-07-07 | CCR | Owner | Refund `requested` | Approve refund | Sukses, saldo berkurang | `approve_refund_atomic` | `customer_credit.refund_approved` | integration | 2I.3 |
| FIN-07-08 | CXL | Finance | Order belum invoiced | Ajukan cancellation | Sukses, status "Menunggu Persetujuan" | `request_order_cancellation_atomic` | `order_cancellation.requested` | integration | 2I.4 |
| FIN-07-09 | CXL | Owner | Cancellation `requested`, invoice polos | Approve cancellation | Sukses, invoice void terbentuk | `approve_order_cancellation_atomic` | `order_cancellation.approved`, `invoice.voided` | integration | 2I.4 |

## 8. Setiap Forbidden Action Ditolak dan Tidak Aktif

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-08-01 | PAY | Manager | — | Coba akses form "Catat Pembayaran" via URL langsung ke server action | Server action menolak (`FORBIDDEN`) | Tidak ada perubahan | — | integration | 2I.2 |
| FIN-08-02 | RET | Manager | Return `requested` | Coba panggil `verify_return_atomic` langsung (bypass UI) | RPC menolak | RPC `RAISE EXCEPTION FORBIDDEN` | — | integration | 2I.3 |
| FIN-08-03 | CCR | Finance | Refund `requested` | Coba panggil `approve_refund_atomic` | RPC menolak | `FORBIDDEN` | — | integration | 2I.3 |
| FIN-08-04 | CXL | Finance | Cancellation `requested` | Coba panggil `approve_order_cancellation_atomic` | RPC menolak | `FORBIDDEN` | — | integration | 2I.4 |
| FIN-08-05 | WS | Sales | — | Coba akses semua server action finance langsung | Semua menolak sebelum RPC (permission check server action) | Tidak ada perubahan | — | integration | 2I.1–2I.4 |

## 9. Approve/Reject Lifecycle Final

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-09-01 | RET | Owner | Return sudah `approved` | Coba approve/reject lagi | Tombol sudah hilang di UI; bila dipaksa, RPC menolak `RETURN_ALREADY_RESOLVED` | Tidak ada perubahan kedua | — | integration | 2I.3 |
| FIN-09-02 | CCR | Owner | Refund sudah `rejected` | Coba approve setelahnya | Tombol hilang; RPC menolak `REFUND_ALREADY_RESOLVED` | Tidak ada perubahan | — | integration | 2I.3 |
| FIN-09-03 | CXL | Owner | Cancellation sudah `approved` | Coba reject setelahnya | Tombol hilang; RPC menolak transisi | Tidak ada perubahan | — | integration | 2I.4 |
| FIN-09-04 | COL | Owner | Promise sudah `broken` | Coba `mark_promise_broken` lagi | Idempotent — hasil sama, tidak ada baris baru | Tidak ada perubahan ganda | — | integration | 2I.2 |

## 10. Retry / Idempotency

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-10-01 | PAY | Owner | Submit "Catat Pembayaran", network timeout setelah request terkirim tapi sebelum response | Klik retry dengan dialog masih terbuka (idempotency key sama) | Sukses tanpa duplikasi allocation | `UNIQUE(company_id, idempotency_key)` mencegah baris kedua | `payment.recorded` (hanya sekali) | integration | 2I.2 |
| FIN-10-02 | CCR | Owner | Approve refund, retry setelah timeout | Retry dengan payload identik | RPC mengembalikan `out_already_exists=TRUE`, tidak menulis ulang | Tidak ada baris ledger kedua | `customer_credit.refund_approved` (hanya sekali, dedup partial unique index) | integration | 2I.3 |
| FIN-10-03 | REC | Finance | Reconcile, retry dengan idempotency key sama tapi payload berbeda | Retry | Ditolak `IDEMPOTENCY_KEY_PAYMENT_MISMATCH` | Tidak ada perubahan | — | integration | 2I.2 |
| FIN-10-04 | COL | Finance | Cancel promise yang sudah `cancelled` | Cancel lagi | Idempotent, tidak error, tidak ada perubahan state | Tidak ada baris baru | — | integration | 2I.2 |

## 11. Stale / Concurrent Decision Handling

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-11-01 | PAY | 2 user Finance bersamaan | Invoice outstanding 500.000, dua form alokasi 400.000 masing-masing dibuka bersamaan | User A submit dulu, lalu User B submit | User A sukses; User B ditolak `ALLOCATION_EXCEEDS_OUTSTANDING`, UI tampilkan "Data telah berubah, muat ulang" | Row lock FOR UPDATE mencegah race | `payment.recorded` (hanya User A) | integration | 2I.2 |
| FIN-11-02 | CCR | 2 user bersamaan | Credit note available_balance 300.000, dua refund request 250.000 masing-masing | Kedua submit hampir bersamaan | Salah satu sukses, satunya ditolak `REFUND_EXCEEDS_AVAILABLE_BALANCE` | Row lock pada `credit_notes` | `customer_credit.refund_requested` (hanya satu) | integration | 2I.3 |
| FIN-11-03 | CXL | Owner + sistem lain | Cancellation `requested`, invoice tiba-tiba dapat payment allocation baru sebelum Owner klik approve | Owner klik approve dengan halaman lama (belum refresh) | RPC menolak `INVOICE_SETTLEMENT_EXISTS` di dalam lock, bukan preview lama | UI tampilkan pesan settlement berubah, minta refresh | — | integration | 2I.4 |

## 12. Loading, Empty, Error, Permission-Denied States

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-12-01 | WS | Owner | Data sedang fetch | Buka `/dashboard/finance` | Skeleton loading tampil, bukan blank/flicker | — | — | component | 2I.1 |
| FIN-12-02 | INV | Owner | Tidak ada invoice sama sekali | Buka list invoice | `EmptyState` dengan pesan sesuai, bukan tabel kosong tanpa konteks | — | — | component | 2I.2 |
| FIN-12-03 | PAY | Owner | RPC gagal (`ALLOCATION_TOTAL_MISMATCH`) | Submit form salah | Error inline manusiawi, bukan kode error mentah | Tidak ada perubahan | — | integration | 2I.2 |
| FIN-12-04 | WS | Sales | Akses langsung | Buka route manapun | Redirect, bukan halaman error mentah | — | — | integration | 2I.1 |

## 13. Mobile / Desktop Rendering

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-13-01 | WS | Owner | Viewport desktop (≥1024px) | Buka semua tab | `DataTable` tampil penuh | — | — | browser-UAT | 2I.4 |
| FIN-13-02 | WS | Owner | Viewport mobile (375px) | Buka semua tab | Card-list tampil, tidak ada horizontal scroll tabel | — | — | browser-UAT | 2I.4 |
| FIN-13-03 | RET | Owner | Viewport mobile | Buka detail return, klik approve | Dialog konfirmasi full-width, tombol dapat diklik tanpa mis-tap | — | — | browser-UAT | 2I.4 |

## 14. Audit Evidence Setelah Mutation

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-14-01 | AUD | Owner | Setelah `payment.recorded` terjadi | Buka Riwayat Audit, filter module=finance | Entri `payment.recorded` tampil dengan actor, waktu (WIB), payload summary | — | Baca dari `audit_logs` | integration | 2I.4 |
| FIN-14-02 | AUD | Owner | Setelah refund approved | Buka detail credit note | Riwayat audit terkait credit note tsb tampil (deep link dari detail) | — | `customer_credit.refund_approved` | integration | 2I.3/2I.4 |
| FIN-14-03 | AUD | Finance | Data sensitif di payload (jika ada) | Buka detail audit entry | Field sensitif ter-redact (`redactSensitive`) | — | — | unit | 2I.4 |

## 15. Tidak Ada Side Effect Lintas Domain

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-15-01 | RET | Owner | Approve retur dengan `customer_credit_amount>0` | Setelah approve | `receivable_ledger` invoice berkurang sesuai `applied_amount` SAJA; `customer_credit_ledger` **tidak tersentuh** sampai ada refund request terpisah | Dua ledger tetap independen | `credit_note.issued` (bukan `customer_credit.*`) | integration | 2I.3 |
| FIN-15-02 | CXL | Owner | Approve cancellation invoice polos | Setelah approve | Hanya `invoice_voids` + `receivable_ledger` entry_type `invoice_void` yang bertambah; `payment_receipts`/`credit_notes` lain tidak berubah | — | `invoice.voided` saja | integration | 2I.4 |
| FIN-15-03 | CCR | Owner | Approve refund | Setelah approve | `customer_credit_ledger` bertambah debit; `receivable_ledger` invoice asal **tidak tersentuh sama sekali** (kontrak Gate 2H §5) | — | `customer_credit.refund_approved` saja | integration | 2I.3 |

## 16. Deep Link & Refresh/Invalidation

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-16-01 | WS | Owner | Item action queue #5 (return) | Klik "Lihat Bukti Retur" | Navigasi langsung ke `/dashboard/finance/returns/[id]`, bukan reload workspace dari awal | — | — | browser-UAT | 2I.1 |
| FIN-16-02 | RET | Owner | Approve retur sukses | Setelah dialog tertutup | List return ter-refresh otomatis (`revalidatePath`), item pindah dari "requested" ke "approved" tanpa manual reload | `revalidatePath("/dashboard/finance/returns")` | — | integration | 2I.3 |
| FIN-16-03 | WS | Owner | Bookmark URL `/dashboard/finance/invoices/[id]` | Buka langsung dari bookmark (belum lewat action queue) | Halaman detail invoice tampil identik dengan navigasi via klik | — | — | browser-UAT | 2I.2 |

## 17. Accessibility Dasar

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-17-01 | WS | Owner (keyboard only) | — | Tab melalui sidebar → tab nav → tabel → tombol aksi | Fokus terlihat jelas, urutan logis | — | — | browser-UAT | 2I.1 |
| FIN-17-02 | WS | Owner (keyboard only) | `ConfirmDialog` terbuka | Tekan Esc / Tab ke tombol batal | Dialog tertutup dengan Esc, fokus kembali ke tombol pemicu | — | — | component | 2I.1 |
| FIN-17-03 | WS | Screen reader | Tombol disabled (owner-only) | Fokus ke tombol | Label alasan disabled terbaca (aria-describedby atau setara) | — | — | component | 2I.1 |
| FIN-17-04 | WS | Owner (keyboard only) | Tabel `DataTable` | Navigasi baris | Setiap baris/kolom header memiliki label yang benar untuk assistive tech | — | — | component | 2I.2 |

## 18. Browser E2E — Happy Path & Adversarial Path

| ID | Domain | Actor | Preconditions | Action | Expected UI | Expected Backend Effect | Expected Audit | Level | Gate |
|---|---|---|---|---|---|---|---|---|---|
| FIN-18-01 | WS→PAY | Finance | Invoice outstanding ada | Login → buka Finance Operations → dari action queue klik invoice → catat pembayaran lengkap → sukses | Alur penuh tanpa error, item hilang dari antrean | `record_verified_payment_atomic` | `payment.recorded` | browser-UAT | 2I.5 |
| FIN-18-02 | WS→RET→CCR | Owner | Return diajukan Finance sebelumnya | Login owner → approve return → credit note terbentuk → buka tab Customer Credit → lihat available_balance baru | Alur lintas tab konsisten | `verify_return_atomic` | `return.approved`, `credit_note.issued` | browser-UAT | 2I.5 |
| FIN-18-03 | WS→CXL | Owner | Cancellation invoice bermasalah (ada payment) | Login owner → buka cancellation → approve | RPC menolak `INVOICE_SETTLEMENT_EXISTS`, UI tampilkan alasan dari preview §9, tidak ada crash | Tidak ada perubahan data | — | browser-UAT | 2I.5 |
| FIN-18-04 | WS | Finance (adversarial) | — | Buka devtools, coba force-enable tombol owner-only, submit | Server action menolak, UI menampilkan error permission, tidak ada perubahan data | `FORBIDDEN` di server action/RPC | — | browser-UAT | 2I.5 |
| FIN-18-05 | WS | Owner (adversarial) | Refund sudah `approved` | Buka kembali URL lama (cached), coba approve lagi lewat browser back+resubmit | Ditolak idempoten, tidak ada baris ledger kedua, UI tampilkan status final | Tidak ada perubahan | — | browser-UAT | 2I.5 |
| FIN-18-06 | WS | Sales (adversarial) | — | Coba akses seluruh 8 sub-route finance langsung via URL | Semua redirect ke `/dashboard`, tidak ada satupun yang bocor data | — | — | browser-UAT | 2I.5 |
