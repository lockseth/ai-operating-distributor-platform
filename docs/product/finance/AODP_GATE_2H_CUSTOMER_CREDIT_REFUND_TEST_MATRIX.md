# AODP Gate 2H — Customer Credit Ledger & Refund Test Matrix (Freeze)

## 0. Status

Dokumen ini adalah matrix skenario yang **wajib lulus** terhadap
`docs/product/finance/AODP_GATE_2H_CUSTOMER_CREDIT_REFUND_CONTRACT.md`
sebelum implementasi Gate 2H (migration, RPC, trigger, policy, integration
test) dianggap selesai. Belum ada implementasi pada gate ini — matrix ini
adalah **spesifikasi test**, bukan hasil test run.

Notasi:

- `CCL` = Customer Credit Ledger (buku besar baru Gate 2H).
- `RL` = `receivable_ledger` (Gate 2A, TIDAK PERNAH disentuh Gate 2H —
  lihat kontrak §5).
- `saldo_tersedia(cn)` = `credit_notes.customer_credit_amount −
  SUM(refund approved) − SUM(refund requested/pending)` untuk
  `credit_note_id = cn` (kontrak §4.4).
- `saldo_ledger(cn)` = `SUM(kredit CCL) − SUM(debit CCL)` untuk
  `credit_note_id = cn` — nilai historis/audit, berbeda dari
  `saldo_tersedia` yang memperhitungkan reservation pending.
- Setiap skenario mencantumkan: **Precondition**, **Action**, **Expected
  Result**, **Ledger Delta** (CCL dan RL), **Audit Delta**, **Invariant
  yang Dibuktikan**.

---

## 1. Credit Note vs Outstanding (formula applied/customer_credit)

### 1.1 Credit note lebih kecil dari outstanding

- **Precondition**: Invoice total Rp1.000.000, outstanding Rp1.000.000.
  Retur diajukan dan disetujui menghasilkan credit note total Rp400.000.
- **Action**: `verify_return_atomic` approve (Gate 2F, di luar Gate 2H,
  disebut sebagai precondition data) → credit note lahir dengan
  `applied_amount = 400.000`, `customer_credit_amount = 0`.
- **Expected Result**: Tidak ada saldo customer credit untuk credit note
  ini — `saldo_tersedia = Rp0`. Refund request pada credit note ini WAJIB
  ditolak (`REFUND_EXCEEDS_AVAILABLE_BALANCE`) berapa pun nominalnya.
- **Ledger Delta**: RL kredit Rp400.000 (Gate 2F, sudah terjadi sebelum
  Gate 2H). CCL: **tidak ada baris** (customer_credit_amount = 0, analog
  pola Gate 2F "tidak ada ledger nol/palsu").
- **Audit Delta**: Tidak ada audit Gate 2H (tidak ada aksi Gate 2H yang
  terjadi).
- **Invariant Dibuktikan**: Kontrak §2 — customer credit HANYA dari
  `customer_credit_amount`, bukan dari `total_amount` credit note.

### 1.2 Credit note sama dengan outstanding

- **Precondition**: Invoice total Rp1.000.000, outstanding Rp1.000.000.
  Credit note total Rp1.000.000.
- **Action**: Credit note lahir dengan `applied_amount = 1.000.000`,
  `customer_credit_amount = 0`.
- **Expected Result**: Sama seperti 1.1 — `saldo_tersedia = Rp0`, refund
  apa pun ditolak.
- **Ledger Delta**: RL kredit Rp1.000.000, outstanding → Rp0. CCL: tidak
  ada baris.
- **Audit Delta**: Tidak ada.
- **Invariant Dibuktikan**: Kontrak §2 — batas persis `applied_amount ==
  outstanding` tidak menghasilkan residual customer credit palsu.

### 1.3 Credit note lebih besar dari outstanding

- **Precondition**: Invoice total Rp1.000.000, outstanding Rp1.000.000.
  Credit note total Rp1.500.000.
- **Action**: Credit note lahir dengan `applied_amount = LEAST(1.500.000,
  1.000.000) = 1.000.000`, `customer_credit_amount = 500.000`.
- **Expected Result**: `saldo_tersedia = Rp500.000` untuk credit note ini.
  Refund hingga Rp500.000 dapat diajukan dan disetujui.
- **Ledger Delta**: RL kredit Rp1.000.000, outstanding → Rp0. CCL: kredit
  Rp500.000 (baris awal bucket).
- **Audit Delta**: Tidak ada audit Gate 2H pada langkah ini (baris kredit
  CCL adalah turunan `customer_credit_amount`, lihat kontrak §9 — mekanisme
  insert adalah keputusan implementasi).
- **Invariant Dibuktikan**: Kontrak §2 rumus `customer_credit_amount =
  credit_note_total − applied_amount`, ini satu-satunya jalur nominal
  customer credit lahir > 0.

---

## 2. Invoice Sudah Lunas → Customer Credit Penuh

- **Precondition**: Invoice total Rp800.000, sudah lunas penuh
  (`payment_allocation` Rp800.000, outstanding Rp0).
- **Action**: Retur diajukan & disetujui, credit note total Rp300.000.
- **Expected Result**: `applied_amount = LEAST(300.000, 0) = Rp0`;
  `customer_credit_amount = Rp300.000` (seluruh nilai credit note menjadi
  customer credit). **Tidak ada refund otomatis** — saldo tersedia
  Rp300.000 menunggu refund request eksplisit dari Owner/Finance.
- **Ledger Delta**: RL: **tidak ada baris baru** (`applied_amount = 0` →
  `receivable_ledger_id IS NULL` pada `credit_notes`, invariant Gate 2F).
  Outstanding invoice tetap Rp0 (tidak berubah, bukan turun lagi di bawah
  0). CCL: kredit Rp300.000.
- **Audit Delta**: Tidak ada audit Gate 2H pada langkah ini (belum ada
  refund request).
- **Invariant Dibuktikan**: Kontrak §5 contoh wajib #2 — invoice lunas
  tidak pernah menghasilkan RL baru dari credit note, dan tidak pernah
  memicu refund otomatis.

---

## 3. Request Refund Tidak Mengubah Ledger

- **Precondition**: Credit note dengan `saldo_tersedia = Rp500.000`.
- **Action**: Owner/Finance mengajukan refund `requested` Rp200.000
  (metode, tanggal transaksi, referensi bukti pembayaran keluar diisi).
- **Expected Result**: Request tersimpan status `requested`. Query
  `saldo_ledger(cn)` (SUM kredit − debit CCL) **tidak berubah** — masih
  Rp500.000. `saldo_tersedia(cn)` turun jadi Rp300.000 (reservation, bukan
  ledger).
- **Ledger Delta**: CCL: **tidak ada baris baru**. RL: tidak tersentuh.
- **Audit Delta**: `customer_credit.refund_requested` tercatat,
  `entity_type = refund_requests`.
- **Invariant Dibuktikan**: Kontrak §4.2 — `requested` tidak mengubah CCL
  maupun RL; reservation adalah konsep terpisah dari ledger.

---

## 4. Partial Refund Approved Mengurangi Source Balance Tepat Sekali

- **Precondition**: Credit note `saldo_tersedia = Rp500.000`. Refund
  `requested` Rp200.000 (dari skenario 3).
- **Action**: Owner approve refund tersebut.
- **Expected Result**: Refund status → `approved`. `saldo_ledger(cn)`
  turun jadi Rp300.000. `saldo_tersedia(cn)` tetap Rp300.000 (reservation
  yang sama sekarang sudah "real").
- **Ledger Delta**: CCL: + 1 baris debit Rp200.000, tepat satu kali
  (bukan dua baris untuk satu approval). RL: tidak tersentuh.
- **Audit Delta**: `customer_credit.refund_approved` tercatat (dan HANYA
  ini — bukan gabungan dengan `refund_requested` lagi).
- **Invariant Dibuktikan**: Kontrak §4.2/§4.4 poin 5 — approval append
  debit tepat sekali.

---

## 5. Beberapa Partial Refund dari Source yang Sama

- **Precondition**: Credit note `customer_credit_amount = Rp500.000`,
  belum ada refund.
- **Action**: Refund #1 Rp200.000 requested→approved. Refund #2
  Rp150.000 requested→approved (setelah #1 selesai, bukan paralel — lihat
  skenario 8 untuk kasus paralel).
- **Expected Result**: Setelah #1: `saldo_tersedia = Rp300.000`. Setelah
  #2: `saldo_tersedia = Rp150.000`. Kedua refund tersimpan sebagai baris
  terpisah (bukan digabung jadi satu angka) — audit trail lengkap per
  refund, pola identik "tiga payment receipt tetap tersimpan terpisah"
  (`AODP_FINANCIAL_CONTRACT_TEST_MATRIX.md` §1.B).
- **Ledger Delta**: CCL: 2 baris debit terpisah (Rp200.000, Rp150.000).
- **Audit Delta**: 2× `customer_credit.refund_requested` + 2×
  `customer_credit.refund_approved`, masing-masing `entity_id` berbeda.
- **Invariant Dibuktikan**: Kontrak §3 poin 4 — partial refund berurutan
  dari source yang sama diperbolehkan, totalnya tidak melebihi saldo.

---

## 6. Exact Remaining-Balance Refund

- **Precondition**: Credit note `saldo_tersedia = Rp150.000` (sisa dari
  skenario 5).
- **Action**: Refund `requested` Rp150.000 (persis sisa saldo) →
  `approved`.
- **Expected Result**: Diterima (bukan ditolak karena "pas batas").
  `saldo_tersedia` setelah approve = **Rp0**. `saldo_ledger` juga Rp0.
- **Ledger Delta**: CCL: debit Rp150.000, saldo bucket final Rp0.
- **Audit Delta**: `customer_credit.refund_requested` +
  `customer_credit.refund_approved`.
- **Invariant Dibuktikan**: Kontrak §4.4 poin 2 — batas `<=` (bukan `<`)
  saldo tersedia; saldo Rp0 valid, bukan berarti bucket "hilang" (baris
  ledger historis tetap ada, hanya saldo turunan yang jadi nol).

---

## 7. Zero, Negative, dan Over-Refund Ditolak

- **Precondition**: Credit note `saldo_tersedia = Rp300.000`.
- **Action A**: Refund request `amount = 0`.
- **Expected Result A**: Ditolak (`INVALID_REFUND_AMOUNT` / constraint
  `amount > 0`), tidak ada baris `refund_requests` tersimpan.
- **Action B**: Refund request `amount = -50.000`.
- **Expected Result B**: Ditolak, sama seperti A (constraint level
  database, independen dari validasi RPC).
- **Action C**: Refund request `amount = 500.000` (melebihi saldo tersedia
  Rp300.000).
- **Expected Result C**: Ditolak (`REFUND_EXCEEDS_AVAILABLE_BALANCE`),
  tidak ada baris tersimpan, `saldo_tersedia` tidak berubah.
- **Ledger Delta**: Tidak ada perubahan CCL/RL pada ketiga percobaan.
- **Audit Delta**: Tidak ada audit sukses tercatat untuk ketiga percobaan
  (RPC gagal sebelum commit — atau audit outcome bila pola gate lain
  mencatat percobaan gagal juga, konsisten dengan pola audit Gate 2A–2G
  yang hanya mencatat `outcome='success'` pada jalur happy path RPC
  masing-masing).
- **Invariant Dibuktikan**: Kontrak §4.4 poin 1/2 — batas bawah dan atas
  nominal refund ditegakkan dua lapis (constraint + RPC).

---

## 8. Dua Request Paralel Tidak Dapat Over-Reserve

- **Precondition**: Credit note `saldo_tersedia = Rp300.000`, tidak ada
  refund lain.
- **Action**: Dua refund request diajukan **bersamaan** (concurrent
  transaction): Request A Rp200.000, Request B Rp200.000 (total
  Rp400.000, melebihi Rp300.000).
- **Expected Result**: Row lock pada `credit_notes` (`FOR UPDATE`) di
  dalam RPC request menyerialisasi keduanya. Transaksi yang commit lebih
  dulu (mis. A) berhasil dengan reservation Rp200.000. Transaksi kedua (B)
  yang mengevaluasi `saldo_tersedia` **setelah** lock A dilepas melihat
  sisa Rp100.000 → **ditolak**
  (`REFUND_EXCEEDS_AVAILABLE_BALANCE`). Tidak ada skenario di mana
  KEDUANYA lolos.
- **Ledger Delta**: Hanya 1 baris `refund_requests` (`requested`)
  tersimpan (A). CCL/RL tidak tersentuh (belum ada approval).
- **Audit Delta**: 1× `customer_credit.refund_requested` (A saja).
- **Invariant Dibuktikan**: Kontrak §4.4 poin 3 — reservation dihitung
  ulang di dalam lock, pola identik `verify_return_atomic` mengunci
  invoice (Gate 2F).

---

## 9. Retry Approve Idempotent

- **Precondition**: Refund `requested` Rp200.000, siap di-approve.
- **Action**: Owner approve. Karena network error, client retry approve
  dengan `refund_id` yang sama (mis. request HTTP timeout lalu diulang).
- **Expected Result**: Percobaan kedua **tidak menulis debit CCL lagi** —
  mengembalikan hasil approval PERTAMA (`out_already_exists = TRUE` atau
  setara), status tetap `approved`, `saldo_ledger` tidak berkurang dua
  kali.
- **Ledger Delta**: CCL: **tepat 1 baris** debit Rp200.000 (bukan 2).
- **Audit Delta**: **tepat 1** `customer_credit.refund_approved` (retry
  tidak menulis audit baru), pola identik `reverse_credit_note_atomic`
  (Gate 2F) yang mengembalikan hasil pertama tanpa menulis apa pun lagi.
- **Invariant Dibuktikan**: Kontrak §4.4 poin 5 — approval idempotent
  struktural (bukan hanya dicegah oleh idempotency_key opsional).

---

## 10. Reject Tidak Membuat Ledger Debit

- **Precondition**: Refund `requested` Rp150.000.
- **Action**: Owner reject.
- **Expected Result**: Status → `rejected`. `saldo_tersedia` kembali naik
  Rp150.000 (reservation dilepas). `saldo_ledger` **tidak berubah** (tidak
  pernah ada debit untuk refund yang ditolak).
- **Ledger Delta**: CCL: **tidak ada baris baru**.
- **Audit Delta**: `customer_credit.refund_rejected` tercatat.
- **Invariant Dibuktikan**: Kontrak §4.2 — reject tidak pernah menyentuh
  ledger.

---

## 11. Reject→Reject dan Reject→Approve Ditolak

- **Precondition**: Refund sudah berstatus `rejected` (dari skenario 10).
- **Action A**: Owner mencoba reject lagi pada `refund_id` yang sama.
- **Expected Result A**: Ditolak
  (`REFUND_ALREADY_RESOLVED`/setara), status tetap `rejected`, tidak ada
  perubahan apa pun.
- **Action B**: Owner mencoba approve pada `refund_id` yang sama (yang
  sudah `rejected`).
- **Expected Result B**: Ditolak, sama seperti A — status final tidak
  dapat "dibuka ulang" ke jalur lain.
- **Ledger Delta**: Tidak ada perubahan CCL pada kedua percobaan.
- **Audit Delta**: Tidak ada audit sukses baru untuk kedua percobaan.
- **Invariant Dibuktikan**: Kontrak §4.1 — status final tidak dapat
  dibuka/diputuskan ulang, pola identik `RETURN_ALREADY_RESOLVED`
  (Gate 2F).

---

## 12. Approve→Approve dan Approve→Reject Ditolak

- **Precondition**: Refund sudah berstatus `approved` (dari skenario 4).
- **Action A**: Owner mencoba approve lagi **dengan payload/parameter
  berbeda** (mis. melalui jalur yang bukan idempotent-retry murni — untuk
  membedakan dari skenario 9 yang murni retry request identik).
- **Expected Result A**: Tetap mengembalikan hasil approval pertama
  (idempotent, skenario 9) ATAU ditolak bila didesain non-idempotent untuk
  parameter berbeda — yang WAJIB: **tidak pernah** menulis debit CCL
  kedua.
- **Action B**: Owner mencoba reject pada `refund_id` yang sudah
  `approved`.
- **Expected Result B**: Ditolak (`REFUND_ALREADY_RESOLVED`/setara) —
  tidak boleh "membatalkan" refund yang sudah approved lewat reject.
- **Ledger Delta**: Tidak ada baris CCL tambahan pada kedua percobaan.
- **Audit Delta**: Tidak ada audit sukses baru (selain audit idempotent
  return pada A bila didesain demikian).
- **Invariant Dibuktikan**: Kontrak §4.1 — sekali `approved`, tidak dapat
  berpindah ke `rejected` maupun approve ulang yang menulis ledger baru.

---

## 13. Cross-Tenant Ditolak

- **Precondition**: Company A dan Company B, masing-masing punya
  customer/credit note sendiri. Actor adalah user Company A.
- **Action A**: Actor Company A mengajukan refund dengan `credit_note_id`
  milik Company B.
- **Expected Result A**: Ditolak (`TENANT_CONTEXT_MISMATCH`), tidak ada
  baris tersimpan.
- **Action B**: Actor Company A mencoba approve/reject refund yang
  `company_id`-nya Company B (meski `refund_id` diketahui/ditebak).
- **Expected Result B**: Ditolak, sama seperti A.
- **Action C**: Actor Company A men-`SELECT` refund/CCL milik Company B
  lewat RLS langsung (bukan RPC).
- **Expected Result C**: Baris tidak muncul (RLS `company_id =
  get_user_company_id()`), bukan error — pola identik seluruh tabel Gate
  2A–2G.
- **Ledger Delta**: Tidak ada perubahan CCL pada percobaan A/B.
- **Audit Delta**: Tidak ada audit sukses untuk A/B.
- **Invariant Dibuktikan**: Kontrak §4.3 — tenant validasi server-side,
  pola identik `validate_return_tenant`/`validate_credit_note_tenant`
  (Gate 2F).

---

## 14. Non-Owner Approve/Reject Ditolak

- **Precondition**: User dengan role `finance` (boleh `refund.request`,
  TIDAK punya `refund.approve` — kontrak §4.3) mengajukan refund yang
  sudah `requested`. User dengan role `manager`/`admin`/`super_admin`
  (yang di Gate 2F/2G boleh `return.request`/`order_cancellation.request`
  tapi di Gate 2H TIDAK termasuk `refund.request`) juga diuji.
- **Action A**: User `finance` mencoba approve refund tersebut.
- **Expected Result A**: Ditolak (`FORBIDDEN`, permission `refund.approve`
  hanya `owner`).
- **Action B**: User `manager`/`admin`/`super_admin` mencoba mengajukan
  refund request (bukan approve).
- **Expected Result B**: Ditolak (`FORBIDDEN`, permission `refund.request`
  hanya `owner`/`finance` — LEBIH SEMPIT dari `return.request` Gate 2F).
- **Action C**: User role `sales` mencoba request maupun approve.
- **Expected Result C**: Ditolak pada keduanya.
- **Ledger Delta**: Tidak ada perubahan pada ketiga percobaan.
- **Audit Delta**: Tidak ada audit sukses untuk ketiganya.
- **Invariant Dibuktikan**: Kontrak §4.3 — containment permission
  `refund.request` (owner/finance) berbeda dan lebih sempit dari
  `refund.approve` (owner-only) maupun dari `return.request` Gate 2F.

---

## 15. Direct Mutation Authenticated/Anon Ditolak

- **Precondition**: Tabel Customer Credit Ledger dan `refund_requests`
  sudah dibuat dengan RLS SELECT-only + `REVOKE INSERT/UPDATE/DELETE/
  TRUNCATE FROM PUBLIC, anon, authenticated` (pola Gate 2F/2G §7 kontrak
  Gate 2H).
- **Action A**: User `authenticated` (via Supabase client, bukan
  service_role RPC) mencoba `INSERT` langsung ke `refund_requests`.
- **Expected Result A**: Ditolak oleh Postgres GRANT (permission denied),
  bukan oleh application-level check.
- **Action B**: User `anon` mencoba `SELECT`/`INSERT`/`UPDATE` pada kedua
  tabel.
- **Expected Result B**: `SELECT` mengembalikan 0 baris (tidak ada policy
  untuk anon) atau ditolak RLS; `INSERT`/`UPDATE` ditolak GRANT.
- **Action C**: User `authenticated` mencoba `UPDATE`
  `refund_requests.status` langsung (bypass RPC) pada refund miliknya
  sendiri (tenant benar).
- **Expected Result C**: Ditolak GRANT, terlepas dari tenant benar/salah —
  hanya RPC `service_role` yang boleh menulis.
- **Ledger Delta**: Tidak ada perubahan.
- **Audit Delta**: Tidak ada.
- **Invariant Dibuktikan**: Kontrak §4.3 — "direct client mutation harus
  ditolak", pola identik `REVOKE ALL ... FROM PUBLIC, anon, authenticated`
  + `GRANT EXECUTE ... TO service_role` (seluruh RPC Gate 2A–2G).

---

## 16. Refund Tidak Mengubah Entitas Lain

- **Precondition**: Snapshot state sebelum refund: `receivable_ledger`,
  `invoices.status`/`total_amount`, `sales_orders.status`, `deliveries`,
  inventory/stock level (bila ada modul terkait) untuk order/invoice yang
  terkait credit note sumber refund.
- **Action**: Refund `requested` → `approved` Rp200.000.
- **Expected Result**: Snapshot SETELAH refund identik dengan snapshot
  SEBELUM pada seluruh entitas berikut: `receivable_ledger` (tidak ada
  baris baru), `invoices` (tidak ada kolom berubah), `sales_orders` (tidak
  ada kolom berubah, termasuk `status`), `deliveries`/`delivery_items`
  (tidak tersentuh), inventory/stock (tidak tersentuh).
- **Ledger Delta**: CCL: + 1 baris debit. RL: **nihil** (0 baris baru).
- **Audit Delta**: `customer_credit.refund_requested` +
  `customer_credit.refund_approved` SAJA — tidak ada audit
  `invoice.*`/`order.*`/`delivery.*`/`inventory.*` yang tercatat akibat
  refund ini.
- **Invariant Dibuktikan**: Kontrak §5 poin 2/3 dan §8 (out of scope) —
  isolasi penuh Customer Credit Ledger dari seluruh entitas lain.

---

## 17. Refund dari Reversed Credit Note Ditolak

- **Precondition**: Credit note dengan `customer_credit_amount =
  Rp400.000`, sudah pernah direverse (`credit_note_reversals` ada,
  belum pernah ada refund approved sebelumnya — reversal terjadi sesuai
  kontrak §6 poin 3).
- **Action**: Owner/Finance mengajukan refund request pada credit note
  yang sama (post-reversal).
- **Expected Result**: Ditolak (`CREDIT_NOTE_REVERSED`), tidak ada baris
  `refund_requests` tersimpan, tidak peduli nominal yang diminta.
- **Ledger Delta**: Tidak ada perubahan CCL/RL.
- **Audit Delta**: Tidak ada audit sukses.
- **Invariant Dibuktikan**: Kontrak §6 poin 1.

---

## 18. Credit-Note Reversal dengan Pending Refund Ditolak

- **Precondition**: Credit note `customer_credit_amount = Rp400.000`,
  ada refund `requested` (belum diputuskan) Rp150.000 pada credit note
  tersebut.
- **Action**: Owner mencoba reverse credit note tersebut
  (`credit_note.reverse`).
- **Expected Result**: Ditolak (`PENDING_REFUND_EXISTS`), reversal tidak
  tercatat, credit note tetap berstatus non-reversed, refund `requested`
  tetap `requested` (tidak dipaksa reject otomatis oleh reversal).
- **Ledger Delta**: Tidak ada perubahan CCL/RL/`credit_note_reversals`.
- **Audit Delta**: Tidak ada audit sukses `customer_credit.credit_reversed`.
- **Invariant Dibuktikan**: Kontrak §6 poin 2.

---

## 19. Credit-Note Reversal Setelah Approved Refund Ditolak

- **Precondition**: Credit note `customer_credit_amount = Rp400.000`,
  refund `approved` Rp200.000 sudah tercatat (sisa `saldo_tersedia =
  Rp200.000`).
- **Action**: Owner mencoba reverse credit note tersebut.
- **Expected Result**: Ditolak
  (`REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN`) — reversal TIDAK
  dilakukan sama sekali (bukan reversal parsial Rp200.000 sisa). Refund
  yang sudah approved TIDAK dihapus/diubah. Saldo customer credit TIDAK
  menjadi negatif dalam skenario apa pun turunan aksi ini.
- **Ledger Delta**: Tidak ada perubahan CCL/RL/`credit_note_reversals`.
- **Audit Delta**: Tidak ada audit sukses `customer_credit.credit_reversed`.
- **Invariant Dibuktikan**: Kontrak §6 poin 4.

---

## 20. Audit Failure Membatalkan Seluruh Keputusan Finansial

- **Precondition**: Refund `requested` siap di-approve. Simulasikan
  kegagalan insert `audit_logs` (mis. constraint violation buatan pada
  kolom wajib, atau trigger yang sengaja gagal di test harness) di tengah
  transaksi approval.
- **Action**: Panggil RPC approve refund pada kondisi simulasi tsb.
- **Expected Result**: **Seluruh transaksi rollback** — status refund
  TETAP `requested` (bukan `approved`), **tidak ada** baris debit CCL yang
  tersisa (meski sempat ter-INSERT sebelum audit gagal, harus ikut
  rollback karena satu transaksi).
- **Ledger Delta**: **Nihil** — state akhir identik state sebelum
  percobaan.
- **Audit Delta**: **Nihil** — tidak ada audit parsial yang tertinggal.
- **Invariant Dibuktikan**: Kontrak §7.2 — atomicity penuh, audit adalah
  bagian tak terpisahkan dari transaksi keputusan finansial.

---

## 21. Multi-Credit-Note dan Multi-Invoice Refund Ditolak

- **Precondition**: Dua credit note berbeda (CN1, CN2) pada invoice yang
  sama atau berbeda, masing-masing punya `saldo_tersedia > 0`.
- **Action A**: Refund request dengan payload yang mencoba menunjuk lebih
  dari satu `credit_note_id` sekaligus (mis. array `[CN1, CN2]` bila API
  secara keliru menerimanya) untuk satu refund.
- **Expected Result A**: Ditolak secara struktural — skema `refund_requests`
  hanya punya SATU kolom `credit_note_id` (bukan array/tabel junction),
  sehingga request semacam ini tidak representable, bukan hanya "divalidasi
  dan ditolak" di level aplikasi.
- **Action B**: Dua refund request TERPISAH, masing-masing menunjuk CN1
  dan CN2 (bukan digabung) — ini SAH, bukan pelanggaran (setiap refund
  tetap single-source).
- **Expected Result B**: Kedua request diproses independen, masing-masing
  mengurangi `saldo_tersedia` source-nya sendiri saja — TIDAK ADA
  interaksi/gabungan saldo antara CN1 dan CN2.
- **Ledger Delta**: A: tidak ada baris (unrepresentable). B: 2 baris
  debit terpisah pada bucket CN1 dan CN2 masing-masing, tidak saling
  memengaruhi.
- **Audit Delta**: A: tidak ada. B: 2 set audit terpisah dengan
  `entity_id` berbeda.
- **Invariant Dibuktikan**: Kontrak §3 poin 3/5 — single-source
  struktural, FIFO/gabungan lintas credit note dilarang.

---

## 22. Referential/Source Totals Selalu Reconcile, Saldo Tidak Pernah Negatif

- **Precondition**: Jalankan kombinasi skenario 1–21 di atas secara
  berurutan pada satu dataset test (beberapa credit note, beberapa refund
  partial/approved/rejected, satu reversal valid).
- **Action**: Pada akhir seluruh urutan, hitung untuk **setiap**
  `credit_note_id` yang tersentuh:
  ```
  saldo_ledger(cn) = SUM(kredit CCL) − SUM(debit CCL)
  ```
  dan bandingkan dengan:
  ```
  credit_notes.customer_credit_amount(cn)
    − SUM(refund_requests.amount WHERE credit_note_id=cn AND status='approved')
    − (customer_credit_voided_amount bila cn direverse, dari kontrak §6 poin 3)
  ```
- **Expected Result**: Kedua nilai **selalu sama persis** (reconcile) di
  SETIAP titik waktu sepanjang urutan test, dan **`saldo_ledger(cn)` tidak
  pernah negatif** pada credit note manapun, di titik waktu manapun
  (termasuk di tengah concurrency test skenario 8).
- **Ledger Delta**: N/A (skenario ini adalah invariant-check lintas
  skenario, bukan aksi tunggal baru).
- **Audit Delta**: N/A.
- **Invariant Dibuktikan**: Kontrak §2 poin 4 (saldo selalu dari SUM
  ledger, tidak pernah kolom bebas edit) dan §4.4 poin 6 (retry/concurrency
  tidak pernah menghasilkan saldo negatif) — invariant payung yang harus
  bertahan di bawah SELURUH skenario 1–21 secara simultan, bukan hanya
  per-skenario terisolasi.
