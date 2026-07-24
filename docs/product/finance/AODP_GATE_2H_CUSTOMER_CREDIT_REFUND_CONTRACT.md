# AODP Gate 2H — Customer Credit Ledger & Refund Contract (Freeze)

## 0. Status

**FREEZE, bukan implementasi.** Dokumen ini mengunci kontrak bisnis
Customer Credit Ledger & Refund sebelum migration/RPC/trigger/policy/UI Gate
2H dibuat. Tidak ada perubahan production behavior pada gate ini —
implementasi dilakukan lewat prompt terpisah setelah kontrak ini disetujui.

Urutan vertical slice AODP (`AODP_PRODUCT_CONSTITUTION.md`):

`Sales Order → Delivery Verification → Invoice → Collection → Owner Alert`

Gate ini menutup **residual customer credit** yang lahir dari Gate 2F
(Retur & Credit Note) — nilai `credit_notes.customer_credit_amount` yang
TIDAK PERNAH terpakai/terlihat setelah Gate 2F selesai (lihat catatan
LIMITATION pada migration `20260831000001_return_credit_note_receivable_reduction.sql`,
§ komentar desain: "tidak ada mekanisme konsumsi yang perlu dibatalkan
secara aktif karena tidak pernah dibuat di tempat lain"). Gate 2H membuat
mekanisme itu: ledger customer credit + refund lifecycle yang mencatat dan
memverifikasi pengembalian nilai tersebut ke customer — TANPA mengeksekusi
transfer bank/cash.

Gate acuan yang menjadi source of truth kontrak ini:

- Gate 2A — `AODP_FINANCIAL_CONTRACT.md` (receivable ledger, invariant dasar
  append-only, immutability, tenant isolation).
- Gate 2D — `record_verified_payment_atomic` (migration `20260829000001`,
  lihat `apps/web/src/lib/finance/verified-payment-allocation.integration.test.ts`)
  — pola locking invoice + ledger pairing constraint trigger DEFERRED.
- Gate 2F — `request_return_atomic` / `verify_return_atomic` /
  `reverse_credit_note_atomic` (migration
  `20260831000001_return_credit_note_receivable_reduction.sql`) — pola
  request→approve|reject, `credit_notes.customer_credit_amount` sebagai
  **satu-satunya sumber** customer credit Gate 2H, dan
  `credit_note_reversals` sebagai titik yang harus diperluas kontraknya
  (lihat §6 dan § "Catatan Kompatibilitas dengan Gate 2F" di bawah).
- Gate 2G — `request_order_cancellation_atomic` /
  `approve_order_cancellation_atomic` (migration
  `20260901000001_order_cancellation_invoice_void.sql`) — pola locking
  order + eligibility check tiga-lapis di dalam lock, dan bukti bahwa
  `credit_notes` (reversed atau belum) sudah dipakai sebagai sinyal
  "invoice tidak lagi polos" oleh gate lain (lihat §6).

---

## 1. Glossary Entitas Baru

| Entitas | Definisi | Hubungan dengan Gate 2F/2G |
|---|---|---|
| **Customer Credit Bucket** | Saldo customer credit yang berasal dari **tepat satu** `credit_note_id`. Bukan tabel baru berisi angka bebas edit — melainkan konsep turunan: `credit_notes.customer_credit_amount` (kredit awal) dikurangi debit-debit pada Customer Credit Ledger yang menunjuk `credit_note_id` yang sama. | Sumbernya HANYA `credit_notes.customer_credit_amount` (Gate 2F). Tidak ada bucket tanpa credit note. |
| **Customer Credit Ledger** | Buku besar append-only, terpisah dari `receivable_ledger`, mencatat kredit (dari credit note) dan debit (dari refund approved / reversal compensating) per `credit_note_id`. Saldo = SUM(kredit) − SUM(debit). | Entitas BARU Gate 2H. Tidak menyentuh `receivable_ledger` sama sekali (lihat §5). |
| **Refund Request** | Pengajuan pengembalian nilai customer credit — nominal, metode, tanggal transaksi, referensi bukti pembayaran keluar. Status `requested` belum mengubah ledger mana pun. | Entitas BARU Gate 2H. Mengambil saldo dari TEPAT SATU `credit_note_id` (lihat §2). |
| **Refund Approval Decision** | Keputusan Owner: `approved` (uang benar-benar sudah dikembalikan, verified) atau `rejected`. Final, tidak dapat dibuka ulang. | Pola identik `returns.status`/`order_cancellations.status` (Gate 2F/2G) — request→approve|reject TERBATAS. |
| **Reservation (pending refund)** | Nominal refund `requested` yang belum diputuskan, mengurangi **saldo tersedia** (bukan saldo ledger) source credit note secara logis, agar dua request paralel tidak bisa over-refund. | Konsep BARU — analog dengan bagaimana `verify_return_atomic` menghitung ulang outstanding DI DALAM lock invoice (Gate 2F), diterapkan di sini pada level credit note. |

**Bukan bagian Gate 2H** (istilah yang sengaja TIDAK didefinisikan di sini):
refund lintas customer, pemindahan kredit antarcustomer, penggunaan
customer credit untuk membayar invoice lain, payment receipt/allocation,
bank reconciliation — lihat §8.

---

## 2. Customer Credit — Source, Formula, dan Batas

1. Customer credit adalah **kewajiban perusahaan kepada customer**
   (liability), bukan piutang negatif — tidak pernah direpresentasikan
   sebagai baris di `receivable_ledger` atau sebagai saldo invoice minus.
2. **Satu-satunya sumber** customer credit Gate 2H adalah
   `credit_notes.customer_credit_amount` (Gate 2F), yang sudah dihitung:
   - `applied_amount = LEAST(credit_note_total, outstanding_balance_saat_approval)`
   - `customer_credit_amount = credit_note_total - applied_amount`

   Kedua rumus ini **tidak diubah** oleh Gate 2H — Gate 2H murni
   mengonsumsi kolom `credit_notes.customer_credit_amount` yang immutable,
   sudah dihitung `verify_return_atomic` (Gate 2F) pada saat approval retur.
3. Outstanding invoice **tidak boleh negatif** — invariant ini sudah
   ditegakkan `validate_receivable_ledger_entry()` (Gate 2A/2D/2F/2G,
   `ALLOCATION_EXCEEDS_OUTSTANDING`). Gate 2H tidak menambah jalur baru yang
   bisa melanggarnya karena tidak pernah menyentuh `receivable_ledger`.
4. Customer credit dicatat di **Customer Credit Ledger** append-only.
   **Tidak ada kolom saldo bebas edit** (tidak ada `UPDATE
   customer_credit_balance SET ...`). Saldo per `credit_note_id` SELALU
   dihitung: `SUM(kredit) − SUM(debit)` dari Customer Credit Ledger, pola
   identik `receivable_ledger` (Gate 2A invariant #5/#7).
5. Baris Customer Credit Ledger:
   - **Kredit**: satu baris per credit note resmi Gate 2F, nominal =
     `credit_notes.customer_credit_amount`, dibuat pada saat pertama kali
     credit note tersebut "disentuh" Gate 2H (lihat §9 — insert lazy vs
     insert saat `verify_return_atomic`, keputusan implementasi, TIDAK
     mengubah RPC Gate 2F yang sudah immutable-frozen sejak commit
     `5c919d2`. Kontrak ini HANYA mensyaratkan nominal kredit == kolom
     `credit_notes.customer_credit_amount`, bukan mekanisme insert-nya).
   - **Debit — refund**: satu baris per refund `approved`, nominal =
     `refund_requests.amount` pada baris yang disetujui itu.
   - **Debit — reversal compensating**: satu baris saat credit note
     direverse (§6), nominal = customer_credit residual yang MASIH tersedia
     pada saat reversal (bukan selalu `customer_credit_amount` penuh, lihat
     §6 poin 3 — refund yang sudah approved tetap harus dikurangkan lebih
     dulu, TAPI §6 poin 4 justru MELARANG reversal jika sudah ada refund
     approved sama sekali; sehingga secara praktis baris ini SELALU sama
     dengan `customer_credit_amount` penuh karena reversal hanya boleh
     terjadi saat belum ada refund approved — lihat §6 untuk detail).
6. **Tidak boleh `UPDATE`/`DELETE`** baris manapun di Customer Credit Ledger
   untuk "memperbaiki" saldo. Koreksi SELALU entry baru (pola identik
   `receivable_ledger`, Gate 2A invariant #4/#6, ditegakkan trigger
   immutability `BEFORE UPDATE OR DELETE` seperti `prevent_credit_note_mutation`
   Gate 2F).

---

## 3. Single-Source dan Single-Invoice (WAJIB)

1. Satu Customer Credit Bucket berasal dari **tepat satu** `credit_note_id`
   — ditegakkan struktural: setiap baris Customer Credit Ledger WAJIB
   memiliki `credit_note_id` NOT NULL, dan baris kredit awal per
   `credit_note_id` UNIQUE (pola identik `credit_notes.return_id UNIQUE`
   Gate 2F — "satu retur terverifikasi hanya satu credit note", diperluas
   di sini menjadi "satu credit note hanya satu bucket credit ledger").
2. Credit note tetap terkait **tepat satu invoice asli** — properti ini
   sudah dijamin struktural oleh `credit_notes.invoice_id` (Gate 2F, NOT
   NULL FK tunggal). Gate 2H tidak menambah invoice kedua ke bucket mana
   pun.
3. Satu refund hanya boleh mengambil saldo dari **tepat satu**
   `credit_note_id`/source bucket — `refund_requests.credit_note_id` WAJIB
   NOT NULL, tidak ada kolom/mekanisme yang mengizinkan satu refund
   menunjuk lebih dari satu credit note.
4. Partial refund diperbolehkan, termasuk beberapa refund berurutan dari
   source yang sama, **selama total kumulatif (approved + pending
   reserved) tidak melebihi saldo source** (lihat §4).
5. **Dilarang keras** (pelanggaran kontrak, bukan sekadar tidak
   didukung):
   - satu return/credit note mencakup beberapa invoice (sudah dilarang
     struktural sejak Gate 2F, `credit_notes.invoice_id` tunggal);
   - satu refund menggabungkan beberapa credit note atau invoice;
   - alokasi customer credit ke invoice lain (customer credit TIDAK
     PERNAH mengurangi `receivable_ledger` invoice mana pun, lihat §5);
   - FIFO lintas invoice (tidak ada logika "pakai bucket tertua dulu" di
     Gate 2H — client/actor WAJIB menunjuk `credit_note_id` eksplisit per
     refund request);
   - generalized multi-invoice allocation.
6. Multi-invoice tetap **OUT OF SCOPE** sampai keputusan bisnisnya dikunci
   terpisah (lihat §8).

---

## 4. Refund Lifecycle

### 4.1 State machine

```
requested → approved
          → rejected
```

Status final (`approved`/`rejected`) **tidak dapat dibuka atau diputuskan
ulang** — pola identik `returns.status`/`order_cancellations.status`
(trigger immutability `BEFORE UPDATE` yang menolak transisi dari status
bukan `requested`, analog `RETURN_ALREADY_RESOLVED`/
`ORDER_CANCELLATION_ALREADY_RESOLVED`).

### 4.2 Makna bisnis per status

| Status | Makna | Efek ledger |
|---|---|---|
| `requested` | Refund diajukan: nominal, metode, tanggal transaksi, referensi bukti pembayaran keluar (mis. bukti transfer keluar/kas keluar) dicatat. | **Tidak ada** — tidak mengubah Customer Credit Ledger maupun `receivable_ledger`. Hanya membuat **reservation** logis (§4.4) yang mengurangi saldo tersedia untuk request LAIN pada source yang sama. |
| `approved` | Owner memverifikasi bahwa uang **benar-benar telah dikembalikan** ke customer (di luar sistem — AODP tidak mengeksekusi transfer). | Debit Customer Credit Ledger dibuat **atomik tepat sekali**, dalam transaksi yang sama dengan transisi status. |
| `rejected` | Permintaan ditolak (mis. bukti tidak valid, keputusan bisnis lain). | **Tidak ada** debit ledger. Reservation dilepas (saldo tersedia kembali seperti sebelum request). |

AODP **hanya mencatat dan memverifikasi** refund — Gate 2H tidak
mengeksekusi transfer bank/cash secara otomatis dalam bentuk apa pun
(tidak ada integrasi payment gateway/bank API).

### 4.3 Permission minimum

| Aksi | Role diizinkan | Pola pembanding |
|---|---|---|
| `refund.request` (ajukan) | **Owner atau Finance** tenant yang sama | LEBIH SEMPIT dari `return.request`/`order_cancellation.request` (owner/manager/admin/super_admin/finance, Gate 2F/2G) — keputusan bisnis eksplisit gate ini, dampak finansial langsung ke kas keluar sehingga tidak dibuka ke manager/admin/super_admin generik. |
| `refund.approve` (approve/reject) | **Hanya Owner** tenant yang sama | Identik `return.verify`/`credit_note.reverse`/`order_cancellation.approve` (Owner-only, Gate 2F/2G). |

- Actor nonaktif (`users.is_active = FALSE`), cross-tenant, anon, dan
  direct client mutation (bypass RPC) **harus ditolak** — pola identik
  `FORBIDDEN`/`TENANT_CONTEXT_MISMATCH` (Gate 2A–2G) dan RLS SELECT-only +
  `REVOKE INSERT/UPDATE/DELETE/TRUNCATE FROM PUBLIC, anon, authenticated`
  (Gate 2F/2G, §7 di bawah).
- Customer, company, invoice, dan credit note **harus diturunkan/divalidasi
  server-side** dari `credit_note_id` yang dikirim client — `customer_id`/
  `invoice_id`/`company_id` pada refund request WAJIB sama dengan yang
  tersimpan di `credit_notes` bersangkutan (client TIDAK PERNAH mengirim
  `customer_id`/`invoice_id` independen yang dipercaya begitu saja — pola
  identik `validate_return_tenant`/`validate_credit_note_tenant`, Gate 2F).

### 4.4 Availability dan concurrency

1. Refund amount **harus > 0** (analog `CHECK (amount > 0)` pola
   `return_items.requested_quantity`/`credit_notes.total_amount`).
2. Refund **tidak boleh melebihi saldo tersedia** source credit note, di
   mana:

   ```
   saldo_tersedia(credit_note_id) =
       credit_notes.customer_credit_amount
       − SUM(refund_requests.amount WHERE credit_note_id = X AND status = 'approved')
       − SUM(refund_requests.amount WHERE credit_note_id = X AND status = 'requested')
   ```

   (SUM `requested` di sini TERMASUK reservation dari request lain yang
   masih pending, TIDAK termasuk request yang sedang diproses itu sendiri
   saat pertama kali dihitung.)
3. **Pending request mereservasi nominal secara logis** — dihitung ulang
   DI DALAM row lock pada `credit_notes` (`FOR UPDATE`, pola identik
   `verify_return_atomic` mengunci invoice, `approve_order_cancellation_atomic`
   mengunci order) pada saat INSERT refund request baru, sehingga **dua
   request paralel tidak dapat sama-sama lolos melebihi saldo tersedia**
   (percobaan kedua yang dievaluasi setelah lock pertama dilepas akan
   melihat reservation dari request pertama).
4. **Rejection melepas reservasi** tanpa membuat entry ledger apa pun —
   begitu status berpindah ke `rejected`, nominalnya tidak lagi dihitung
   dalam SUM `requested` pada rumus di atas.
5. **Approval append debit tepat sekali** — pola idempotency identik
   `reverse_credit_note_atomic` (Gate 2F): percobaan approve kedua pada
   `refund_id` yang sama (retry) HARUS mengembalikan hasil approval
   PERTAMA tanpa menulis ledger lagi, ditegakkan struktural (mis.
   `refund_requests.status` sudah bukan `requested` sehingga trigger
   immutability menolak transisi kedua — bukan hanya dicegah di level RPC).
6. Retry dan concurrency **tidak boleh** menghasilkan: duplicate refund,
   duplicate ledger, duplicate audit, atau saldo customer credit negatif.
   Saldo negatif dicegah lapis kedua yang independen dari RPC — analog
   `validate_receivable_ledger_entry` (Gate 2A/2D/2F/2G) yang memvalidasi
   ulang di level trigger BEFORE INSERT pada Customer Credit Ledger, bukan
   hanya dipercaya dari perhitungan RPC.

---

## 5. Hubungan dengan Receivable Ledger

1. **Customer Credit Ledger terpisah total** dari `receivable_ledger` —
   dua buku besar independen, tidak ada baris yang hidup di keduanya.
2. **Refund tidak mengurangi outstanding invoice lagi.** Pengurangan
   outstanding invoice sudah final & selesai pada saat `applied_amount`
   dicatat sebagai kredit di `receivable_ledger` oleh `verify_return_atomic`
   (Gate 2F) — bagian `customer_credit_amount` yang TIDAK diterapkan ke
   invoice itu tetap di luar `receivable_ledger` selamanya. Refund
   menyentuh Customer Credit Ledger SAJA.
3. **Refund tidak membuat payment allocation** dan **tidak mengubah status
   invoice/order** — `invoices`/`sales_orders` tidak pernah menjadi target
   UPDATE dari RPC Gate 2H mana pun.

### Contoh wajib #1 — partial applied, partial refund

| Langkah | Kondisi | Receivable Ledger (invoice) | Customer Credit Ledger (credit_note) |
|---|---|---|---|
| 0 | Invoice diterbitkan, total Rp1.000.000 | Saldo Rp1.000.000 (outstanding) | — |
| 1 | Credit note diterbitkan Rp1.500.000 (retur melebihi outstanding saat itu) | `applied_amount` = LEAST(1.500.000, 1.000.000) = Rp1.000.000 → kredit ledger Rp1.000.000. Saldo = **Rp0** | `customer_credit_amount` = 1.500.000 − 1.000.000 = **Rp500.000**. Kredit ledger + Rp500.000 |
| 2 | Refund `approved` Rp200.000 | **Tidak berubah** — tetap Rp0, outstanding TETAP Rp0 (bukan naik lagi) | Debit Rp200.000. Saldo tersisa = **Rp300.000** |
| 3 | Baca saldo | Outstanding invoice = **Rp0** (tidak pernah berubah sejak langkah 1) | Sisa customer credit = **Rp300.000** |

### Contoh wajib #2 — invoice sudah lunas sebelum retur

| Langkah | Kondisi | Receivable Ledger (invoice) | Customer Credit Ledger (credit_note) |
|---|---|---|---|
| 0 | Invoice diterbitkan Rp800.000, sudah lunas penuh (payment_allocation Rp800.000) | Saldo = **Rp0** | — |
| 1 | Credit note diterbitkan Rp300.000 (retur atas invoice yang sudah lunas) | `applied_amount` = LEAST(300.000, outstanding=0) = **Rp0** — TIDAK ADA baris kredit baru (invariant Gate 2F: `receivable_ledger_id` tetap NULL bila `applied_amount = 0`) | `customer_credit_amount` = 300.000 − 0 = **Rp300.000 penuh** menjadi customer credit, **TANPA refund otomatis** — Owner harus mengajukan refund eksplisit lewat Gate 2H bila ingin dikembalikan |
| 2 | (Belum ada refund) | Saldo tetap Rp0 | Saldo tersedia tetap Rp300.000, menunggu refund request eksplisit |

---

## 6. Credit-Note Reversal — Perluasan Kontrak Gate 2F

1. Credit note yang sudah `reversed` (ada baris di `credit_note_reversals`
   yang menunjuknya) **tidak dapat menjadi sumber refund** — refund request
   baru pada `credit_note_id` tersebut WAJIB ditolak
   (`CREDIT_NOTE_REVERSED`).
2. Credit note **tidak boleh direverse** selama masih memiliki refund
   request **aktif** (`status = 'requested'`, belum diputuskan) —
   `reverse_credit_note_atomic` (atau RPC pengganti/pembungkusnya di Gate
   2H, lihat catatan kompatibilitas di bawah) WAJIB menolak dengan
   `PENDING_REFUND_EXISTS` bila ada baris `refund_requests` berstatus
   `requested` pada `credit_note_id` tersebut.
3. **Jika belum pernah ada refund `approved`** pada credit note tersebut,
   reversal customer credit dilakukan dengan **debit kompensasi
   append-only** di Customer Credit Ledger, nominal = saldo customer
   credit yang masih tersedia pada credit note itu (dalam praktiknya =
   `customer_credit_amount` penuh, karena belum ada debit refund approved
   yang mengurangi).
4. **Jika sudah ada refund `approved`** (satu atau lebih) pada credit note
   tersebut, reversal credit note **harus ditolak**
   (`REFUND_ALREADY_APPROVED_REVERSAL_FORBIDDEN`) — Gate 2H **tidak boleh**:
   - menghapus refund yang sudah approved;
   - membuat saldo customer credit negatif (mis. dengan memaksa reversal
     penuh padahal sebagian sudah "dikembalikan" secara nyata ke
     customer).
5. Reversal **tidak boleh** mengubah atau menghapus financial history
   sebelumnya (`credit_notes`, `receivable_ledger`, Customer Credit Ledger
   baris lama) — pola identik invariant Gate 2F `credit_note_reversals`
   (compensating entry, bukan mutasi).

### Catatan Kompatibilitas dengan `reverse_credit_note_atomic` (Gate 2F)

`reverse_credit_note_atomic` (migration `20260831000001`, commit
`5c919d2`) **saat ini TIDAK memiliki** pemeriksaan poin 1/2/4 di atas
(refund belum ada saat Gate 2F ditulis — dikonfirmasi dari komentar desain
migration tsb: "tidak ada mekanisme konsumsi yang perlu dibatalkan secara
aktif karena tidak pernah dibuat di tempat lain"). Ini **bukan
kontradiksi** dengan kontrak Gate 2H — RPC tersebut memang belum
mengetahui keberadaan refund karena ditulis sebelum Gate 2H. Implementasi
Gate 2H **wajib memperluas** `reverse_credit_note_atomic` (menambah
pemeriksaan, tanpa mengubah perilaku existing untuk credit note yang tidak
pernah disentuh refund) — dicatat di sini sebagai dependency implementasi,
bukan blocker freeze kontrak ini. Detail teknis perluasan (migration baru
`CREATE OR REPLACE FUNCTION`, bukan `ALTER`) adalah keputusan Gate 2H
implementasi, bukan gate ini.

---

## 7. Audit dan Atomicity

### 7.1 Audit canonical minimum (nama event `action` pada `audit_logs`)

| Event | Terjadi pada | entity_type |
|---|---|---|
| `customer_credit.refund_requested` | `refund.request` sukses (status baru = `requested`) | `refund_requests` |
| `customer_credit.refund_approved` | `refund.approve` dengan `p_decision = 'approve'` sukses | `refund_requests` |
| `customer_credit.refund_rejected` | `refund.approve` dengan `p_decision = 'reject'` sukses | `refund_requests` |
| `customer_credit.credit_reversed` | Reversal customer credit (baik lewat perluasan `reverse_credit_note_atomic` maupun RPC baru) sukses | Customer Credit Ledger row (debit kompensasi) |

Pola `audit_logs` mengikuti kolom yang sudah ada (Gate 2A–2G):
`company_id, user_id, action, entity_type, entity_id, old_data, new_data,
actor_type, event_category='audit', module='finance', source='web',
outcome='success'`.

### 7.2 Atomicity

- Audit untuk keputusan finansial **harus atomik** dengan perubahan status
  dan ledger terkait — dalam **SATU transaksi** database yang sama (pola
  identik seluruh RPC canonical Gate 2A–2G: ledger/entity insert + audit
  insert dalam satu `plpgsql` function body, tanpa transaksi terpisah).
- **Kegagalan audit harus me-rollback seluruh transaksi** — tidak ada
  jalur di mana status refund/ledger berubah tetapi audit gagal tercatat
  (konsekuensi alami dari "satu transaksi", bukan mekanisme kompensasi
  terpisah).

---

## 8. Out of Scope (Keras)

Gate 2H **tidak boleh** mengerjakan/menyentuh:

- delivery reversal;
- inventory/restock reversal;
- profit/COGS adjustment;
- perubahan invoice lines;
- perubahan nilai invoice asli;
- payment receipt/allocation;
- bank reconciliation;
- transfer bank otomatis (tidak ada integrasi payment gateway/bank API —
  refund `approved` HANYA mencatat bahwa Owner *memverifikasi secara
  manual* uang sudah dikembalikan di luar sistem);
- refund lintas customer;
- pemindahan kredit antarcustomer;
- penggunaan customer credit untuk membayar invoice lain (tidak ada jalur
  "apply customer credit ke invoice X" di Gate 2H — bertentangan dengan
  §5 poin 2);
- multi-invoice atau multi-credit-note refund (lihat §3 poin 5);
- UI/frontend;
- migration, RPC, trigger, policy, atau integration test implementasi
  (gate ini murni dokumen kontrak + test matrix).

---

## 9. Pertanyaan Implementasi yang Sengaja Dibiarkan Terbuka

Kontrak ini **tidak** mengunci detail teknis berikut — didesain saat
implementasi Gate 2H, selama tidak melanggar invariant §1–§8 di atas:

- Nama tabel persis untuk Customer Credit Ledger dan `refund_requests`
  (kontrak hanya mensyaratkan properti/invariant-nya, bukan nama kolom
  huruf-demi-huruf).
- Mekanisme *kapan* baris kredit awal Customer Credit Ledger dibuat dari
  `credit_notes.customer_credit_amount` — apakah lazy (saat refund
  pertama diajukan/credit note pertama disentuh Gate 2H) atau eager (RPC
  Gate 2H baru yang dipanggil terpisah setelah `verify_return_atomic`).
  Yang WAJIB: nominalnya harus selalu sama persis dengan
  `credit_notes.customer_credit_amount`, dan hanya dibuat untuk credit
  note dengan `customer_credit_amount > 0` (analog pola Gate 2F: tidak ada
  ledger nol/palsu).
- Bentuk teknis perluasan `reverse_credit_note_atomic` (lihat § catatan
  kompatibilitas §6).
