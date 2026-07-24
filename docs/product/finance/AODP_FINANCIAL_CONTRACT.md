# AODP Financial Contract — v1.0 (Gate 2A.0 Freeze)

## 0. Status

**FREEZE, bukan implementasi.** Dokumen ini mengunci kontrak finansial
(entitas, source of truth, invariant, boundary) sebelum schema
invoice/piutang dibuat. Tidak ada migration, RPC, UI, atau perubahan
production behavior pada gate ini — lihat §4 "Audit Kompatibilitas" untuk
kondisi implementasi aktual per 2026-07-24.

Urutan vertical slice AODP (dikunci sejak `AODP_PRODUCT_CONSTITUTION.md` v1.2):

`Sales Order → Delivery Verification → Invoice → Collection → Owner Alert`

Gate ini mengunci kontrak untuk segmen **Invoice → Collection**. Segmen
**Sales Order → Delivery Verification** sudah live (lihat
`docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`)
dan menjadi salah satu source of truth kontrak ini (§1, entitas
`delivery_items`).

Referensi commit yang mendahului gate ini (Payment/Invoiced Status
Integrity Containment):

- `20260824000001_lock_paid_status_generic_mutation.sql` — commit `8d22a42`
- `20260825000001_lock_invoiced_status_generic_mutation.sql` — commit `10fc0d7`

---

## 1. Glossary Entitas

| Entitas | Definisi | Status implementasi |
|---|---|---|
| **Sales Order (SO)** | Kesepakatan komersial (PO customer) — janji jual-beli, bukan piutang. | Live (`sales_orders`) |
| **Delivery / Delivery Item** | Fakta barang keluar gudang & diverifikasi diterima customer, per item, per attempt. `received_quantity` adalah kuantitas yang **secara faktual diterima dan diverifikasi** (bukan `ordered_quantity`). | Live (`deliveries`, `delivery_items`, migration `20260716000001` + invariant `20260718000001`) |
| **Issued Document (Invoice snapshot)** | Snapshot dokumen resmi immutable per versi (`document_type = 'INVOICE'`), diterbitkan lewat `record_issued_document()`. Revisi = row baru (`version + 1`, `supersedes_document_id`), snapshot lama tidak pernah ditulis ulang. | Skema live (`issued_documents`, migration `20260812000002`), **jalur invoice belum pernah dipanggil dari kode produksi** — lihat §4 |
| **Invoice (financial entity)** | Kejadian yang **melahirkan piutang**. Lahir HANYA saat issued document `document_type = 'INVOICE'` berstatus `active` diterbitkan. Nominal, line, harga, diskon, pajak immutable setelah issued. | Belum ada jalur produksi — Gate 2A |
| **Receivable Ledger** | Buku besar piutang append-only per invoice: baris debit (invoice issued) dan kredit (allocation, credit note). Saldo = SUM(debit) − SUM(kredit). Satu-satunya source of truth saldo piutang. | Belum ada — Gate 2A |
| **Payment Receipt** | Fakta bahwa distributor **menerima klaim pembayaran** dari customer (nominal, metode, tanggal, referensi). Belum tentu terverifikasi/teralokasi. | Belum ada — Gate 2B |
| **Payment Proof** | Bukti pendukung payment receipt (foto/scan bukti transfer, dsb). Satu payment receipt bisa punya nol/banyak proof. Duplicate proof (hash/referensi sama) harus terdeteksi, bukan otomatis dianggap payment baru. | Belum ada — Gate 2B |
| **Payment Allocation** | Fakta bahwa sejumlah nilai dari payment receipt tertentu dialokasikan ke invoice tertentu. Satu payment receipt bisa dialokasikan ke banyak invoice; satu invoice bisa menerima banyak allocation. Ini adalah baris kredit di receivable ledger. | Belum ada — Gate 2B |
| **Reconciliation** | Proses verifikasi payment receipt (mis. cocok dengan mutasi rekening/transfer) sebelum dianggap sah untuk dialokasikan. Berbeda dari payment receipt itu sendiri. | Belum ada — Gate 2B |
| **Collection Activity / Promise to Pay** | Aktivitas penagihan (kunjungan, follow-up, janji bayar) terhadap saldo outstanding. Tidak mengubah saldo — murni aktivitas operasional yang direferensikan ke invoice/customer. | Belum ada — modul `COLLECTION_INTELLIGENCE.md` (roadmap) |
| **Credit Note** | Dokumen koreksi yang terhubung ke invoice asal (retur, koreksi harga pasca-issued). Tidak pernah mengedit invoice issued — selalu row/dokumen baru yang mengurangi saldo piutang via receivable ledger. | Belum ada — Gate 2A |
| **Operational Invoice Status** | Status siklus kerja dokumen (mis. `draft`, `issued`, `void-requested`, `superseded`) — TIDAK merepresentasikan saldo piutang. | Belum ada (saat ini `issued_documents.status` hanya `active`/`superseded`, itu status dokumen bukan status finansial) |
| **Derived Financial Status** | `outstanding` / `partially_paid` / `paid` — **hasil hitungan** dari receivable ledger + allocation, dihitung on-read atau via materialized view, bukan kolom yang di-`UPDATE` manual. | Belum ada — Gate 2A/2B |

---

## 2. Source of Truth per Nilai

| Nilai | Source of truth | Bukan source of truth |
|---|---|---|
| Kuantitas yang boleh ditagih | `SUM(delivery_items.received_quantity)` per `sales_order_item`, dikunci `finalize_delivery_item_quantities()` (atomic, row-locked, menolak jika melebihi `ordered_quantity` — bukan silent clamp) | `sales_order_items.quantity` (ordered, bukan received) |
| Nominal/line/harga/diskon/pajak invoice | `issued_documents.snapshot` pada row `document_type='INVOICE'`, `status='active'`, tepat pada saat `record_issued_document()` dipanggil | `sales_orders` (harga bisa berubah sebelum issuance; setelah issuance, snapshot mengunci) |
| Apakah invoice ini masih berlaku | `issued_documents.status = 'active'` (maksimal satu versi aktif per `source_key` per `document_type`, ditegakkan `uq_issued_documents_active_source`) | Tidak ada kolom lain di `sales_orders` yang boleh merepresentasikan ini |
| Saldo piutang per invoice | Receivable ledger: `SUM(debit dari invoice issued) − SUM(kredit dari allocation + credit note)` | `sales_orders.status`, kolom "amount_paid" mutable apa pun, atau field yang di-`UPDATE` langsung |
| Status finansial (`outstanding`/`partially_paid`/`paid`) | Fungsi murni atas saldo ledger di atas — dihitung, bukan disimpan sebagai keputusan independen | `sales_orders.status = 'paid'/'invoiced'` (sudah dikunci EKSPLISIT sebagai BUKAN source of truth, lihat §4) |
| Apakah suatu payment sah untuk dialokasikan | Status reconciliation payment receipt tersebut | Keberadaan payment proof saja (proof ≠ verified) |

---

## 3. Invariants (WAJIB berlaku di setiap desain Gate 2A/2B berikutnya)

1. **Order/PO bukan piutang.** `sales_orders` tidak pernah menjadi baris di
   receivable ledger. Piutang hanya lahir dari invoice issued.
2. **Piutang lahir hanya dari invoice resmi.** Tidak ada jalur (UI, RPC
   generik, import, koreksi manual) yang boleh membuat baris debit di
   receivable ledger tanpa `issued_documents` row `document_type='INVOICE'`,
   `status='active'` yang bersesuaian.
3. **Kuantitas tertagih = kuantitas diterima & terverifikasi.** Invoice tidak
   boleh dibuat dari kuantitas order; harus dari `delivery_items` yang sudah
   difinalisasi (lihat §2). Invoice untuk kuantitas yang melebihi
   `received_quantity` terverifikasi adalah pelanggaran kontrak.
4. **Invoice issued immutable.** Setelah `status='active'`, nominal, line,
   harga, diskon, pajak pada snapshot tersebut tidak pernah di-`UPDATE`.
   Koreksi = versi baru (`supersedes_document_id`, `version+1`) ATAU credit
   note yang menunjuk ke invoice asal — bukan mutasi in-place. Trigger
   `trg_issued_documents_immutable` (migration `20260812000002`) sudah
   menegakkan ini di level database untuk seluruh `issued_documents`.
5. **Saldo piutang dari ledger, bukan status.** `orders.status` dan status
   invoice manual apa pun DILARANG menjadi basis perhitungan saldo. Saldo
   selalu berasal dari SUM ledger entries (debit invoice − kredit
   allocation/credit note).
6. **Retur tidak mengubah invoice issued.** Retur pasca-invoice
   menghasilkan credit note baru yang menunjuk transaksi asal (invoice id),
   mengurangi saldo lewat entry kredit baru di ledger — tidak pernah
   menyentuh row invoice/`issued_documents` lama.
7. **Status finansial adalah derived, bukan disimpan sebagai keputusan
   independen yang bisa berbeda dari hasil hitungan ledger.** Boleh
   dimaterialisasi (mis. materialized view/cache kolom) untuk performa,
   TAPI mekanisme refresh-nya harus dijamin konsisten dengan ledger
   (recompute, bukan `UPDATE` manual yang independen dari ledger).
8. **Lima konsep pembayaran dipisah tegas** (lihat §1 glossary): payment
   receipt, payment proof, payment allocation, reconciliation, collection
   activity/promise to pay. Tidak ada entitas yang boleh menggabungkan lebih
   dari satu peran ini (mis. "payment record" yang sekaligus berperan
   sebagai proof dan allocation).
9. **Operational status ≠ financial status.** Status siklus kerja dokumen
   (draft/issued/superseded/void-requested) hidup terpisah dari status
   finansial derived (outstanding/partially_paid/paid). Tidak ada satu
   kolom status yang merangkap dua peran ini.
10. **File bukan bagian transaksi database.** Pembukaan piutang (insert
    ledger debit) dan finalisasi snapshot invoice harus atomik dalam satu
    transaksi DB. Pembuatan file PDF/dokumen fisik terjadi SETELAH commit,
    idempotent, lewat outbox (pola sudah ada: `automation_outbox`,
    migration `20260807000001` — `status: PENDING → PROCESSING → SENT/
    RETRY/FAILED/DEAD_LETTER`, payload dihitung sebelum insert, consumer
    hanya membaca & mengirim/generate).

---

## 4. Pemisahan Lifecycle Invoice vs Derived Financial Status

```
Lifecycle Invoice (operational, immutable snapshot):
  draft/none → issued (issued_documents.status='active') → [superseded oleh revisi]
                                                           → [void-requested, di luar scope MVP]

Derived Financial Status (dihitung dari ledger, tidak pernah di-set manual):
  (belum ada invoice)           → tidak berlaku
  invoice active, saldo > total → outstanding
  invoice active, 0 < saldo < total (setelah allocation) → partially_paid
  invoice active, saldo = 0     → paid
  invoice superseded/void       → status finansial ikut versi aktif pengganti,
                                   ATAU nol jika tidak ada pengganti (lihat
                                   skenario koreksi di test matrix)
```

Kedua state machine ini **tidak boleh disatukan menjadi satu kolom status**.
Ini adalah pelanggaran yang sudah pernah terjadi di codebase ini sebelum
containment (lihat §5, `sales_orders.status`) dan sudah dikunci secara
eksplisit agar tidak terulang di schema baru.

---

## 5. Aturan Immutable / Correction

- **Invoice issued (`issued_documents`, `document_type='INVOICE'`,
  `status='active'`):** nominal/line/harga/diskon/pajak immutable secara
  database (`trg_issued_documents_immutable`). Satu-satunya jalur perubahan:
  - **Revisi resmi** — `record_issued_document()` dengan
    `p_supersedes_document_id`, menghasilkan row baru `version+1`,
    menandai row lama `status='superseded'` (row lama tetap tersimpan
    untuk audit trail, tidak pernah dihapus).
  - **Credit note** — untuk retur/koreksi pasca-issued yang tidak
    membutuhkan revisi dokumen itu sendiri, dokumen baru terpisah yang
    menunjuk invoice asal dan mengurangi saldo via ledger.
- **Receivable ledger (Gate 2A):** append-only. Tidak ada `UPDATE`/`DELETE`
  pada entry yang sudah ditulis. Koreksi = entry baru yang saling
  meng-offset (kredit), bukan mengedit entry lama.
- **Payment allocation (Gate 2B):** setelah dikonfirmasi/direkonsiliasi,
  tidak di-edit in-place. Pembatalan alokasi = entry pembalik baru
  (reversal), bukan delete.
- **Larangan eksplisit:** tidak ada peran (termasuk owner/admin) yang boleh
  melakukan mutasi status finansial manual di luar hasil hitungan ledger.
  Pola ini sudah pernah dilanggar dan sudah ditutup untuk `sales_orders`
  (lihat §7) — pola yang sama TIDAK boleh dibuka kembali untuk entitas
  finansial baru.

---

## 6. Atomic Boundary & Outbox Boundary

**Atomic boundary (dalam satu transaksi DB):**
- Finalisasi snapshot invoice (`issued_documents` insert/supersede) +
  pembukaan baris debit di receivable ledger — SATU transaksi, atau
  tidak sama sekali (pola sudah ada di `record_issued_document()`, tinggal
  diperluas untuk menulis ledger entry di transaksi yang sama).
- Payment allocation + pengurangan saldo (entry kredit ledger) — SATU
  transaksi.
- Row locking (`FOR UPDATE`) pada urutan id konsisten untuk mencegah race
  condition saat allocation konkuren ke invoice yang sama (pola sudah
  terbukti di `finalize_delivery_item_quantities`, terbukti lolos true
  concurrency test).

**Outbox boundary (setelah commit, idempotent, async):**
- Generate file PDF invoice.
- Kirim notifikasi (WhatsApp/Telegram/email) terkait invoice/payment.
- Sinkronisasi ke sistem eksternal (jika ada).

Konsumen outbox tidak pernah menjadi source of truth — ia hanya
membaca payload yang sudah final dan mengeksekusi efek samping
(generate/kirim), sesuai pola `automation_outbox` yang sudah berjalan.

---

## 7. Larangan Direct/Manual Status Mutation

Pola yang **sudah terbukti berbahaya dan sudah ditutup** di codebase ini,
dijadikan preseden wajib untuk desain Gate 2A/2B:

- `update_sales_order_status_atomic()` sebelumnya menerima `p_new_status`
  apa pun tanpa validasi state-machine — memungkinkan siapa pun dengan
  permission `orders.update` (termasuk role `sales`) menandai order
  `paid`/`invoiced` lewat satu klik UI tanpa payment fact atau dokumen
  invoice apa pun. Ditutup oleh:
  - `20260824000001_lock_paid_status_generic_mutation.sql` — menolak
    `p_new_status='paid'` (outcome `payment_workflow_required`) dan
    membekukan order yang sudah `paid` dari RPC generik ini sepenuhnya
    (outcome `paid_locked`).
  - `20260825000001_lock_invoiced_status_generic_mutation.sql` — pola
    identik untuk `invoiced` (outcome `invoice_issuance_required` /
    `invoiced_locked`).
- Finance Dashboard (`apps/web/src/app/(dashboard)/dashboard/finance/page.tsx`)
  sudah dikontainmen agar TIDAK menghitung `sales_orders.status`
  (`paid`/`invoiced`) sebagai fakta finansial sama sekali — menampilkan
  "Belum tersedia" sampai ledger canonical ada.

**Aturan untuk Gate 2A/2B:** setiap RPC/route/server action baru yang
menyentuh status finansial WAJIB:
1. Menolak mutasi status finansial generik/manual di level database
   (bukan hanya validasi UI/aplikasi).
2. Membekukan (freeze) entity yang sudah mencapai status finansial final
   dari jalur mutasi generik.
3. Tidak memberi jalur ke role mana pun (termasuk owner) untuk
   "mark as paid/invoiced" tanpa payment fact/invoice issuance yang sah.

---

## 8. Referensi

- `docs/product/AODP_PRODUCT_CONSTITUTION.md` — vertical slice lock (§L15,
  L16, Appendix C), prinsip "mengendalikan piutang".
- `docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`
  — kontrak `received_quantity` sebagai invoice eligibility.
- `docs/document-engine/constitution/AODP_DOCUMENT_CONSTITUTION_v1.0.md` —
  immutable document snapshot principle (dipakai `issued_documents`).
- `docs/product/modules/COLLECTION_INTELLIGENCE.md` — roadmap modul
  collection (di luar scope MVP saat ini).
- `supabase/migrations/20260812000002_document_persistence_versioning.sql`
  — `issued_documents`, `record_issued_document()`.
- `supabase/migrations/20260824000001_lock_paid_status_generic_mutation.sql`,
  `20260825000001_lock_invoiced_status_generic_mutation.sql` — preseden
  containment §7.
- `supabase/migrations/20260718000001_delivery_quantity_invariant.sql` —
  preseden atomic aggregate invariant (§2, §6).
- `supabase/migrations/20260807000001_automation_outbox.sql` — pola outbox
  boundary (§6).

Lihat juga `docs/product/finance/AODP_FINANCIAL_CONTRACT_TEST_MATRIX.md`
untuk skenario yang wajib lulus terhadap kontrak ini sebelum implementasi
Gate 2A dimulai.
