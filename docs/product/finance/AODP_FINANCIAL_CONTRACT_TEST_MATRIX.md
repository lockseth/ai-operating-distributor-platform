# AODP Financial Contract — Test Matrix (Gate 2A.0 Freeze)

## 0. Status

Dokumen ini adalah matrix skenario yang **wajib lulus** terhadap
`docs/product/finance/AODP_FINANCIAL_CONTRACT.md` sebelum implementasi
Gate 2A (receivable ledger, invoice issuance production path) dan Gate 2B
(payment receipt/proof/allocation/reconciliation) dianggap selesai. Belum
ada implementasi pada gate ini — matrix ini adalah **spesifikasi test**,
bukan hasil test run.

Notasi saldo: `saldo = SUM(debit ledger) − SUM(kredit ledger)`. Status
finansial derived: `outstanding` (saldo = total), `partially_paid`
(0 < saldo < total), `paid` (saldo = 0). Lihat kontrak §2, §4.

---

## 1. Skenario Wajib (dari instruksi gate)

### A. Tunai lunas

| Langkah | Kondisi | Expected canonical result |
|---|---|---|
| 1 | Invoice diterbitkan (`issued_documents` active, total = Rp1.000.000) | Ledger: 1 baris debit Rp1.000.000. Saldo = Rp1.000.000. Status derived = `outstanding` |
| 2 | Payment receipt dicatat, nominal Rp1.000.000 | Ledger belum berubah — payment receipt BUKAN entry ledger sampai teralokasi (kontrak §1 pemisahan receipt vs allocation) |
| 3 | Allocation penuh: Rp1.000.000 dari payment receipt → invoice ini | Ledger: + 1 baris kredit Rp1.000.000. Saldo = Rp0 |
| 4 | Baca status | Status derived = `paid`. Tidak ada kolom status yang di-`UPDATE` manual — murni hasil hitung ulang saldo |

### B. Tunai cicilan

| Langkah | Kondisi | Expected canonical result |
|---|---|---|
| 1 | Invoice diterbitkan, total = Rp1.000.000 | Saldo = Rp1.000.000, status `outstanding` |
| 2 | Payment receipt #1 Rp400.000 → allocation penuh ke invoice ini | Ledger: kredit Rp400.000. Saldo = Rp600.000. Status `partially_paid` |
| 3 | Payment receipt #2 Rp350.000 → allocation penuh ke invoice ini | Ledger: kredit Rp350.000 (kumulatif Rp750.000). Saldo = Rp250.000. Status tetap `partially_paid` |
| 4 | Payment receipt #3 Rp250.000 → allocation penuh ke invoice ini | Ledger: kredit Rp250.000 (kumulatif Rp1.000.000). Saldo = Rp0. Status `paid` |
| 5 | Query histori | Tiga payment receipt dan tiga allocation entry tetap tersimpan terpisah (bukan digabung jadi satu angka) — audit trail lengkap per cicilan |

### C. Transfer

| Langkah | Kondisi | Expected canonical result |
|---|---|---|
| 1 | Invoice diterbitkan, total = Rp1.000.000 | Saldo = Rp1.000.000, status `outstanding` |
| 2 | Payment receipt dicatat (klaim transfer, nominal Rp1.000.000) + payment proof (foto bukti transfer) diupload | Payment receipt berstatus belum-terverifikasi. Ledger TIDAK berubah — proof saja bukan dasar allocation (kontrak §1: proof ≠ verified) |
| 3 | Reconciliation: staff finance mencocokkan dengan mutasi rekening, menandai payment receipt terverifikasi | Status reconciliation berubah pada payment receipt. Ledger masih belum berubah — reconciliation ≠ allocation (dua peran terpisah, kontrak §1 invariant 8) |
| 4 | Allocation: payment receipt terverifikasi → invoice ini, penuh Rp1.000.000 | Ledger: kredit Rp1.000.000. Saldo = Rp0 |
| 5 | Baca status | Status derived = `paid`. Saldo dihitung ulang dari ledger, tidak bergantung pada `orders.status` maupun kolom status manual apa pun |

---

## 2. Happy Path

| Skenario | Kondisi | Expected result |
|---|---|---|
| Invoice dari delivery terverifikasi penuh | `delivery_items.received_quantity` = `sales_order_items.quantity` untuk seluruh item order | Invoice boleh diterbitkan untuk seluruh quantity order |
| Allocation exact match | Payment receipt nominal = saldo outstanding invoice | Saldo tepat Rp0 setelah allocation, status `paid`, tidak ada sisa unallocated |

---

## 3. Partial Payment

| Skenario | Kondisi | Expected result |
|---|---|---|
| Partial payment tunggal | Allocation < total invoice | Status `partially_paid`; saldo = total − allocation; ledger menyimpan entry debit awal + entry kredit partial secara terpisah (bukan menimpa nominal invoice) |
| Partial delivery → partial invoice | `received_quantity` < `ordered_quantity` untuk sebagian item | Invoice hanya boleh diterbitkan untuk kuantitas yang sudah `received_quantity` terverifikasi; sisa outstanding quantity tetap billable pada invoice/attempt berikutnya (referensi: `get_outstanding_quantity()`) — TIDAK boleh invoice untuk kuantitas order penuh |

---

## 4. Overpayment / Unallocated Amount

| Skenario | Kondisi | Expected result |
|---|---|---|
| Payment receipt > saldo outstanding satu invoice | Nominal payment receipt Rp1.200.000, saldo invoice Rp1.000.000 | Allocation ke invoice ini dibatasi maksimum saldo outstanding (Rp1.000.000). Sisa Rp200.000 tetap sebagai **unallocated balance** pada payment receipt — TIDAK otomatis mengurangi invoice lain tanpa allocation eksplisit, dan TIDAK hilang/dibuang |
| Unallocated amount didiamkan | Sisa unallocated tidak dialokasikan ke invoice mana pun | Muncul sebagai saldo kredit customer yang harus terlihat (mis. di collection/finance report) — bukan silent loss, bukan auto-refund tanpa keputusan eksplisit |
| Allocation melebihi saldo invoice (upaya) | Sistem mencoba alokasi Rp1.200.000 ke invoice bersaldo Rp1.000.000 | Ditolak (analog pola `QUANTITY_EXCEEDS_OUTSTANDING` pada delivery invariant) — bukan silent clamp tanpa pemberitahuan, dan bukan saldo invoice jadi negatif |

---

## 5. Duplicate Payment Proof

| Skenario | Kondisi | Expected result |
|---|---|---|
| Proof identik diupload dua kali (hash/referensi sama) untuk payment receipt yang sama | Upload #2 dengan konten/referensi identik ke upload #1 | Terdeteksi sebagai duplicate — TIDAK membuat payment receipt baru, TIDAK menggandakan allocation/ledger entry |
| Proof identik direferensikan untuk klaim payment receipt terpisah | Referensi transfer yang sama diklaim dua kali sebagai payment berbeda | Sistem menandai untuk review (potensi duplicate/fraud) — tidak boleh otomatis lolos ke allocation tanpa resolusi eksplisit |
| Retry upload karena network error (idempotency, bukan duplicate asli) | Client retry upload proof yang sama dengan idempotency key sama | Hasil idempoten — satu payment proof record, bukan dua |

---

## 6. Invoice Issued Mutation Attempt

| Skenario | Kondisi | Expected result |
|---|---|---|
| UPDATE langsung ke `issued_documents` row `status='active'` | Percobaan mengubah nominal/line/harga/diskon/pajak pada snapshot aktif | Ditolak oleh `trg_issued_documents_immutable` di level database (sudah live, migration `20260812000002`) |
| Percobaan "koreksi cepat" lewat RPC status generik | Analog pola yang sudah ditutup untuk `sales_orders.status` — percobaan menjadikan invoice `void`/`corrected` lewat mutation generik tanpa jalur resmi | Harus ditolak eksplisit di database (pola sama dengan `invoiced_locked`/`payment_workflow_required`) — bukan hanya dicegah di UI |
| Owner mencoba override manual | Owner/role apa pun mencoba mengubah nominal invoice issued tanpa credit note/revisi resmi | Ditolak untuk SEMUA role, termasuk owner — tidak ada role yang exempt dari immutability (kontrak §5, §7) |

---

## 7. Return / Credit Note

| Skenario | Kondisi | Expected result |
|---|---|---|
| Retur sebagian barang pasca-invoice | Customer mengembalikan sebagian barang dari invoice yang sudah issued | Credit note baru dibuat, menunjuk invoice asal (`source_document_id`/setara). Invoice asal (`issued_documents` snapshot) TIDAK diubah sama sekali |
| Efek ke saldo | Credit note bernilai Rp150.000 terhadap invoice Rp1.000.000 (saldo sebelumnya Rp1.000.000) | Ledger: entry kredit baru Rp150.000 dari credit note. Saldo baru = Rp850.000. Status derived dihitung ulang dari saldo baru |
| Retur setelah invoice sudah `paid` | Credit note dibuat terhadap invoice bersaldo Rp0 | Saldo menjadi negatif (kredit customer) — harus terlihat sebagai saldo kredit/refund due, BUKAN error silent, bukan invoice status "un-paid" secara retroaktif |
| Retur tanpa invoice (order belum invoiced) | Retur terjadi sebelum invoice diterbitkan | Tidak melibatkan credit note/ledger sama sekali — cukup koreksi pada level delivery/quantity (di luar scope receivable ledger, sesuai invariant #3: piutang belum lahir) |

---

## 8. Cross-Tenant Access

| Skenario | Kondisi | Expected result |
|---|---|---|
| User company A membaca invoice/ledger company B | Query langsung dengan id invoice milik tenant lain | Ditolak — RLS `company_id` boundary (pola konsisten dengan `issued_documents_select` policy yang sudah ada) |
| RPC allocation dipanggil lintas tenant | `p_company_id` tidak cocok dengan tenant invoice/payment receipt target | Ditolak di level RPC (pola `forbidden`/`not_found`, konsisten dengan `update_sales_order_status_atomic`) — tidak ada partial leak data tenant lain |
| Anon/authenticated tanpa permission memanggil RPC finansial langsung | Analog temuan `20260719000001_delivery_rpc_grant_hardening.sql` (RPC SECURITY DEFINER bisa dipanggil `anon` karena grant schema-wide) | RPC finansial baru WAJIB `REVOKE ALL FROM PUBLIC, anon, authenticated` + `GRANT TO service_role` sejak migration pertama — bukan hardening menyusul |

---

## 9. Retry / Idempotency

| Skenario | Kondisi | Expected result |
|---|---|---|
| Invoice issuance di-retry (network timeout, client resend) | Request kedua dengan `source_key` yang sama saat versi aktif sudah ada | Ditolak `DOCUMENT_ALREADY_ACTIVE_FOR_SOURCE` (perilaku `record_issued_document()` yang sudah ada) — bukan invoice kedua |
| Allocation di-retry dengan idempotency key sama | Client resend request allocation yang sudah sukses sebelumnya | Hasil idempoten — ledger tidak bertambah entry kedua kalinya untuk request yang sama |
| Dua allocation konkuren ke invoice yang sama (true concurrency) | Dua RPC allocation ditembak paralel terhadap saldo yang cukup untuk salah satu saja | Row locking (`FOR UPDATE`, urutan id konsisten — pola sudah terbukti di `finalize_delivery_item_quantities`) menjamin tepat satu berhasil sesuai saldo tersedia, tidak ada partial write, tidak deadlock, saldo tidak pernah negatif akibat race |
| Webhook/outbox invoice PDF generation di-retry | Consumer outbox retry generate file setelah gagal kirim | Idempoten — tidak menghasilkan dua file/invoice number berbeda untuk transaksi yang sama (pola `automation_outbox` status `RETRY`) |

---

## 10. Ringkasan Cakupan

| Kategori | Jumlah skenario | Menyentuh kontrak invariant # |
|---|---|---|
| Skenario wajib (A/B/C) | 3 | 1, 2, 3, 5, 7, 8 |
| Happy path | 2 | 2, 3 |
| Partial payment | 2 | 3, 5, 7 |
| Overpayment/unallocated | 3 | 5, 8 |
| Duplicate payment proof | 3 | 8, 10 |
| Invoice issued mutation attempt | 3 | 4, 5, 9 |
| Return/credit note | 4 | 4, 6, 7 |
| Cross-tenant access | 3 | (boundary, di luar invariant 1–10 — tenant isolation baseline) |
| Retry/idempotency | 4 | 9, 10 |

**Total 27 skenario spesifikasi.** Tidak ada skenario yang di-skip atau
dianggap "nice to have" — instruksi gate mewajibkan seluruh kategori di
atas hadir dalam matrix ini.

---

## 11. Referensi

Lihat `docs/product/finance/AODP_FINANCIAL_CONTRACT.md` untuk definisi
entitas, source of truth, dan invariant yang dirujuk nomor invariant-nya
di atas.
