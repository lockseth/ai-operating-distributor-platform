# AODP Gate 2I.4 — Cancellation & Invoice Void Workspace Test Matrix (Freeze)

## 0. Status

Spesifikasi test untuk
`AODP_GATE_2I4_CANCELLATION_VOID_WORKSPACE_CONTRACT.md`. Belum ada
implementasi — bukan hasil test run. Traceability terhadap baris master
matrix (`AODP_GATE_2I_FINANCE_OPERATIONS_WORKSPACE_TEST_MATRIX.md`) wajib
lengkap sebelum implementasi dimulai.

Domain notation tambahan: `CXL` = Cancellation & Invoice Void, `AUD` =
Riwayat Audit Finance (sama seperti master matrix §0).

---

## 1. Traceability — Baris Master Matrix ke Gate 2I.4

| Master ID | Ringkasan | Status planned | Catatan |
|---|---|---|---|
| FIN-02-08 | Manager tanpa `order_cancellation.approve`, tombol decision disabled, RPC tidak dipanggil | **PLANNED** | §D kontrak, `DecideCancellationPanel` non-owner state |
| FIN-02-09 | Force-enable tombol disabled via DOM, server action menolak sebelum RPC (scope 2I.1–2I.4, bagian cancellation) | **PLANNED** | §D kontrak, `requirePermission` di `approveOrderCancellationAction` |
| FIN-07-08 | Finance ajukan cancellation order belum invoiced, sukses | **PLANNED** | §C kontrak |
| FIN-07-09 | Owner approve cancellation invoice polos, invoice void terbentuk | **PLANNED** | §E/§F kontrak |
| FIN-08-04 | Finance coba panggil `approve_order_cancellation_atomic` langsung, RPC menolak `FORBIDDEN` | **PLANNED** | RPC-level, dibuktikan integration test Gate 2G (test #2/#15, tidak diulang — cukup direferensikan); server-action-level test baru membuktikan guard sebelum RPC |
| FIN-09-03 | Cancellation sudah `approved`, coba reject, RPC menolak transisi | **PLANNED** | §D kontrak; RPC-level dibuktikan Gate 2G test #17 (retry setelah rejection) — pola simetris untuk retry setelah approval perlu ditambahkan sebagai skenario baru §3 baris CXL-09 di bawah (Gate 2G test #17 hanya menguji retry setelah REJECT, bukan setelah APPROVE) |
| FIN-11-03 | Owner approve dengan halaman lama (invoice dapat settlement baru), RPC menolak `INVOICE_SETTLEMENT_EXISTS` di lock | **PLANNED** | §E kontrak, UI pesan "Data telah berubah, silakan muat ulang" |
| FIN-13-01 | Desktop ≥1024px, `DataTable` tampil penuh seluruh tab | **PLANNED** | §I kontrak — enumerasi file di §2 di bawah |
| FIN-13-02 | Mobile 375px, card-list tampil, tanpa horizontal scroll tabel | **PLANNED** | §I kontrak — enumerasi file di §2 di bawah |
| FIN-13-03 | Mobile, dialog konfirmasi full-width, tombol aman disentuh | **PLANNED** | §I kontrak, verifikasi visual `ConfirmDialog` existing pada cancellation flow |
| FIN-14-01 | Audit `payment.recorded` tampil di Riwayat Audit dengan actor/waktu WIB/payload summary | **PLANNED** | §B.5 kontrak — audit route Owner-only; test dijalankan sebagai Owner (satu-satunya actor yang bisa mengakses route ini) |
| FIN-14-02 | Deep link dari detail credit note ke riwayat audit terkait (bagian yang belum terbukti 2I.3) | **PLANNED** | Deep link dari `cancellations/[id]` ke `/dashboard/finance/audit?entity=order_cancellations&entity_id=[id]` (query filter, bukan route baru) |
| FIN-14-03 | Finance buka detail audit entry, field sensitif ter-redact | **BLOCKED** | §H kontrak — RLS `audit_logs_select` Owner-only terverifikasi, Finance TIDAK dapat mengakses `/dashboard/finance/audit` sama sekali. Redaction (`redactSensitive`) tetap diuji dengan actor **Owner** sebagai gantinya (lihat CXL-AUD-02 di §3) — TIDAK diklaim memenuhi FIN-14-03 seperti tertulis di master matrix (actor=Finance), status tetap BLOCKED sampai ada gate RLS terpisah (§H poin 4) |
| FIN-15-02 | Approve cancellation invoice polos: hanya `invoice_voids`+`receivable_ledger entry_type=invoice_void` bertambah, `payment_receipts`/`credit_notes` lain tidak berubah | **PLANNED** | §F kontrak — dibuktikan Gate 2G test #3 (RPC-level, tidak diulang); UI-level test memverifikasi tampilan tidak menghitung ulang angka ini di client |

Baris master lain yang menyinggung `CXL`/`AUD` tapi bertarget gate selain
2I.4 (mis. FIN-01-xx WS umum, FIN-03-xx cross-tenant umum) sudah dicakup
level workspace shell di 2I.1 dan tidak diulang di sini kecuali skenario
spesifik cancellation/audit yang belum pernah diuji domain lain — lihat §3.

---

## 2. Enumerasi Route/Component untuk FIN-13-01/02/03

Diambil langsung dari §I kontrak (`AODP_GATE_2I4_..._CONTRACT.md`), bukan
klaim "semua responsive":

**File yang WAJIB diverifikasi (baru dibuat / ditambah card-list gate ini)**:

1. `dashboard/finance/cancellations/page.tsx` (list, baru)
2. `dashboard/finance/cancellations/[id]/page.tsx` (detail, baru)
3. `dashboard/finance/audit/page.tsx` (baru, Owner-only)
4. `dashboard/finance/payments/page.tsx` (retrofit card-list)
5. `components/finance/collection-panel.tsx` (retrofit card-list, dipakai
   `dashboard/finance/collection/page.tsx`)

**File yang sudah punya card-list (regresi check saja, TIDAK expect
perubahan)**: `invoices/page.tsx`, `returns/page.tsx`, `credit/page.tsx`,
`components/finance/action-queue.tsx`.

**Detail pages (verifikasi manual, tidak ada perubahan struktural default)**:
`invoices/[id]`, `payments/[id]`, `returns/[id]`, `credit/[id]`,
`cancellations/[id]` (baru).

---

## 3. Skenario Baru (Tanpa FIN-ID Master, Wajib untuk Rejection/Containment)

| ID | Domain | Actor | Preconditions | Action | Expected | Level | Requirement |
|---|---|---|---|---|---|---|---|
| CXL-01 | CXL | Owner Company A | Cancellation detail milik Company B | Akses `/dashboard/finance/cancellations/[id-company-B]` langsung | `notFound()`, bukan data Company B bocor | integration | Cross-tenant containment, §B.3 kontrak |
| CXL-02 | CXL | Finance (adversarial) | Company/actor dari client dimanipulasi | Submit `requestOrderCancellationAction` dengan payload manipulasi field non-schema | `company_id`/`actor_id` tetap dari `getAuthUser()`, manipulasi client diabaikan | integration | §A kontrak "tidak pernah diterima dari browser" |
| CXL-03 | CXL | — | — | Grep source `cancellation-panels.tsx`/`actions.ts` untuk pemanggilan `.from("order_cancellations").insert/update` langsung | Tidak ditemukan — hanya RPC canonical dipanggil | static/unit | §A kontrak "tidak ada direct table mutation" |
| CXL-04 | CXL | Manager (adversarial) | Tombol approve force-enabled via DOM manipulation | Submit form | Server action `requirePermission` melempar sebelum `admin.rpc(...)` dipanggil (assert RPC mock TIDAK dipanggil) | integration | FIN-02-09 (cancellation-specific) |
| CXL-05 | CXL | Finance | Request cancellation, network timeout, retry dengan idempotency key dialog yang sama | Retry | `out_already_exists=TRUE`, TIDAK ada baris `order_cancellations` kedua | integration | §C kontrak idempotency, pola Gate 2G test #7 (RPC-level sudah PASS; ini menguji lapisan server action meneruskan key yang sama pada retry UI) |
| CXL-06 | CXL | Owner | Cancellation sudah `approved`/`rejected` | Buka kembali halaman detail (bukmark/refresh) | Tombol decision hilang, `StatusBadge` final tampil, tidak ada request RPC baru terkirim otomatis | component | §D kontrak "final tidak dapat dibuka ulang" |
| CXL-07 | CXL | Owner | Order `delivered`, belum invoiced | Buka detail cancellation | Preview blocked "Pembatalan memerlukan reversal delivery" tampil SEBELUM tombol approve diklik (bukan hanya muncul setelah RPC gagal) | component | §E kontrak baris 2 |
| CXL-08 | CXL | Owner | Invoice sudah `paid` dengan payment_allocation | Buka detail cancellation | Preview blocked menampilkan fakta "ada payment allocation" secara eksplisit, bukan pesan generik | component | §E kontrak baris 4 |
| CXL-09 | CXL | Owner | Cancellation sudah `approved` (bukan rejected — melengkapi Gate 2G test #17 yang hanya menguji retry setelah reject) | Coba approve/reject lagi | RPC menolak `ORDER_CANCELLATION_ALREADY_RESOLVED`, TIDAK ada `invoice_voids`/ledger kedua, audit `order_cancellation.approved` tetap tepat satu | integration | FIN-09-03, melengkapi gap Gate 2G test coverage |
| CXL-10 | WS | Owner | Action queue punya item `cancellation_pending` dan `invoice_void_notice` | Klik "Lihat" pada masing-masing | Navigasi ke `/dashboard/finance/cancellations/[id]` (bukan lagi tombol disabled), tidak ada 404 | browser-UAT | §B.4/kontrak "no 404 deep links", melengkapi FIN-16-01 untuk kategori CXL |
| CXL-11 | CXL | Owner | Invoice punya cancellation `requested` terkait | Buka detail invoice | Link ke cancellation terkait tampil (§B.4), status cancellation ter-refleksi | component | §6 master contract "link ke ... terkait", diperluas ke cancellation |
| CXL-12 | INV | Owner | Invoice tanpa cancellation apa pun | Buka detail invoice | Section cancellation menampilkan `RequestCancellationPanel` (bukan link kosong/error) | component | §B.4 kontrak |
| CXL-AUD-01 | AUD | Finance/Manager/Admin/Super Admin | Login, permission `receivable.view` (lolos layout) tapi bukan `owner` | Buka `/dashboard/finance/audit` langsung via URL | `AlertCard` "Hanya Owner yang dapat membuka Riwayat Audit" tampil, TIDAK ada data audit bocor, TIDAK 404/redirect membingungkan | integration | §H/§B.5 kontrak — pengganti FIN-14-03 yang BLOCKED untuk actor Finance |
| CXL-AUD-02 | AUD | Owner | Audit entry finance dengan payload berisi field bernama sensitif (mis. `token`) — data uji, bukan data nyata | Buka `/dashboard/finance/audit`, filter module=finance | Field sensitif ter-redact (`••••••`) via `redactSensitive` existing, bukan raw JSON | unit/integration | FIN-14-03 (redaction), dijalankan sebagai Owner karena itu satu-satunya actor valid (§H) |
| CXL-AUD-03 | AUD | Owner | Sidebar/tab nav | Login sebagai Finance, buka sidebar Finance Operations | Tab "Riwayat Audit" tampil non-aktif dengan `disabledReason="Hanya Owner yang dapat membuka Riwayat Audit"`, bukan disembunyikan total | component | §B.1 kontrak, FIN-17-03 (accessible disabled reason) diperluas ke tab nav |
| CXL-AUD-04 | AUD | — | Query gagal (simulasi DB error) | Buka `/dashboard/finance/audit` sebagai Owner | Pesan error eksplisit tampil, BUKAN `EmptyState`/"belum ada aktivitas" | integration | §H kontrak "error tidak boleh disamarkan sebagai empty" |
| CXL-13 | WS | Owner | — | Akses seluruh 9 sub-route finance (termasuk `/cancellations`, `/audit` baru) | Tidak ada satupun 404; non-owner ke `/audit` mendapat `AlertCard`, bukan crash | browser-UAT | Melengkapi FIN-18-06 (Gate 2I.5) dengan baseline non-adversarial di 2I.4 |
| CXL-14 | WS | — | — | Grep migration directory untuk file baru sejak baseline gate ini | Tidak ada file migration baru | static | Acceptance kontrak "tidak ada migration/RPC/schema change" |

---

## 4. Ringkasan Status

- **PLANNED**: 14 baris master matrix.
- **BLOCKED**: 1 baris (FIN-14-03, actor Finance — RLS conflict §H).
- **Skenario baru tanpa FIN-ID**: 18 baris (§3), seluruhnya PLANNED,
  menutup rejection/containment yang diminta gate instruction (cross-tenant,
  spoofing, direct mutation, force-submit, retry idempotency, final-state
  reopen, delivered/settled blocked, invoice void notice read-only, audit
  error non-empty, redirect legacy, no 404, no migration).
- FIN-18-01 s.d. FIN-18-06 (browser E2E lintas-workspace penuh) TETAP Gate
  2I.5 — CXL-10/CXL-13 di atas hanya baseline non-adversarial yang berjalan
  di 2I.4, bukan pemindahan acceptance criteria.
