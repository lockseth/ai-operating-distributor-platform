# AODP — Workflow Order-to-Cash & Status Tracking

Peta lengkap alur bisnis inti AODP: **dari sales membuat order sampai
tagihan lunas**. Beda dari `TRACKER.md` (kronologis per commit/gate), dokumen
ini disusun **per tahap siklus produk** — supaya sekali lihat langsung
kelihatan tahap mana yang sudah PASS dan mana yang belum, tanpa harus
menyisir histori.

Urutan di bawah ini mengikuti *vertical slice* yang dikunci Founder di
`docs/product/AODP_PRODUCT_CONSTITUTION.md` (L16, v1.2): **Sales Order →
Delivery Verification → Invoice → Collection → Owner Alert** — tidak boleh
dipecah urutannya.

Dibuat 2026-08-16 lewat audit langsung ke kode (bukan asumsi dari dokumen
lama) — beberapa gap di bawah baru ketahuan lewat pengecekan ini.

---

## Belum PASS — baca ini dulu

| # | Gap | Tahap | Sejak | Perlu apa |
|---|---|---|---|---|
| 1 | **Owner Approval Inbox UI** belum ada — Owner harus putuskan harga khusus lewat RPC langsung, bukan UI | 2b. Owner putuskan harga khusus | 2026-08-14 | Build UI (next workstream, RPC sudah teruji) |
| 2 | **Dispatch Planner tidak punya dokumen gate readiness** — sudah diimplementasikan, tapi belum ada bukti PASS formal (test/verifikasi terdokumentasi) | 4. Dispatch/perencanaan kirim | ditemukan 2026-08-16 | Audit + tulis gate readiness-nya |
| 3 | **Business Guard "Collection Risk" belum diimplementasi** — spec ada, kode baru discount anomaly. Ini bagian "Owner Alert" dari vertical slice untuk sisi Collection | 7. Pembayaran/collection | ditemukan 2026-08-16 | Build slice #2 Business Guard (pola sama slice #1 discount anomaly) |
| 4 | **REVENUE governed belum reconcile credit note/return** | 9. Retur/credit note/pembatalan | accepted limitation, TRACKER Backlog #11 | Keputusan Founder — ubah definisi atau terima risikonya |
| 5 | **NOO tidak reversal saat order pembuka toko dibatalkan** — beda perlakuan dari ORDER_COUNT/REVENUE yang sudah punya reversal | 9. Retur/credit note/pembatalan | 2026-08-14, TRACKER Backlog #6b | Keputusan Founder — menyentuh gate LOCKED 3E-D5-A |

Detail tiap item ada di sub-section masing-masing di bawah.

---

## Alur end-to-end

```
1. Order dibuat (draft)
     ↓
2a. Sales ajukan harga khusus (opsional)          ✅ PASS
     ↓
2b. Owner putuskan harga khusus                    🟡 PASS RPC, UI belum ada
     ↓
3. Order dikonfirmasi (confirmed)                   ✅ PASS LOCKED
     ↓
4. Dispatch / perencanaan kirim                     🟡 jalan, belum ada gate readiness
     ↓
5. Delivery verification (evidence + status)         ✅ PASS
     ↓
6. Invoice diterbitkan                               ✅ PASS
     ↓
7. Pembayaran / Collection                           🟡 PASS mekanisme, Collection Risk belum ada
     ↓
8. Invoice lunas (paid)                              ✅ PASS

   ⟲ paralel di titik manapun sebelum lunas:
   9. Retur / Credit Note / Pembatalan                🟡 PASS mekanisme, 2 gap definisi KPI
```

---

## 1. Order dibuat (`draft`)

- **Mekanisme**: `create_sales_order_atomic` / `update_sales_order_atomic`.
  Status awal `sales_orders.status = 'draft'`
  (`supabase/migrations/20260626000003_create_business_tables.sql`).
- **Status**: ✅ **PASS** — Gate 3B (role permission matrix, diskon
  owner-only), Gate 3E-D4-B1/B2 (boundary mutation guard RLS+RPC).
- Catatan histori: RPC ini dulu jadi akar P0 (tidak validasi `unit_price`
  vs kebijakan diskon) — sudah ditutup di tahap 3 (Gate 3E-D6-A), bukan di
  sini. Order tetap bisa dibuat dengan harga apa pun di `draft`; validasi
  terjadi saat konfirmasi.

## 2a. Sales ajukan harga khusus (opsional)

- **Mekanisme**: `submit_special_price_proposal_atomic`
  (`supabase/migrations/20260924000001`, versi final `20260925000001`).
  Order pindah ke `status = 'pending_owner_approval'`. Tabel
  `special_price_approval_requests` (status `PENDING/APPROVED/REJECTED`).
  UI Sales: "Ajukan Harga Khusus" di `/dashboard/orders/[id]`.
- **Status**: ✅ **PASS — OFFICIALLY LOCKED** — Gate 3E-D4-C1 (schema),
  3E-D4-C2 (RPC), 3E-D6-B (UI, commit `60e2d9e`), hosted-verified.

## 2b. Owner putuskan harga khusus

- **Mekanisme**: `decide_special_price_proposal_atomic`. `APPROVE` →
  request `APPROVED`; `REJECT` → order kembali ke `draft`.
- **Status**: 🟡 **PASS di level RPC** — Gate 3E-D4-C3, hosted-verified lewat
  sesi Owner nyata. **Tapi tidak ada UI** — Owner memutuskan lewat pemanggilan
  RPC langsung (mis. lewat Studio/skrip), bukan lewat dashboard.
- **Gap #1** (lihat rollup di atas): Owner Approval Inbox UI belum dibangun.
  Bukan blocker Phase 3 (gate terpisah), tapi berarti alur harian Owner
  untuk keputusan ini belum senyaman tahap lain.

## 3. Order dikonfirmasi (`confirmed`)

- **Mekanisme**: `confirm_sales_order_atomic`
  (`supabase/migrations/20261003000001`). Re-validasi harga tiap item vs
  master price/kebijakan diskon saat ini sebelum izinkan `confirmed`; kalau
  ada line special-price, wajib match `special_price_approval_requests`
  yang `APPROVED` persis. RLS `sales_orders` menutup direct-write ke
  `confirmed`.
- **Status**: ✅ **PASS — OFFICIALLY LOCKED** — Gate 3E-D6-A (commit
  `ff74a2e`), menutup P0 lama (order dengan diskon tidak wajar bisa
  `confirmed` tanpa approval), diverifikasi 5 skenario UAT hosted
  (2026-08-13/14).

## 4. Dispatch / perencanaan kirim

- **Mekanisme**: `dispatch_plans` (`supabase/migrations/20260721000001`),
  kolom `planning_status`: `document_ready → waiting_planning → planned →
  scheduled → ready_for_delivery` (atau nyangkut di `waiting_stock` /
  `customer_requested_delay` / `manual_hold` / `route_conflict` /
  `cancelled`). Rule engine deterministik (bukan LLM). UI: AI Dispatch
  Planner (`/dashboard/dispatch`).
- **Status**: 🟡 **Diimplementasikan, belum ada gate readiness resmi.**
- **Gap #2**: tidak ditemukan dokumen di `docs/product/readiness/` yang
  secara spesifik menguji/mengunci modul ini (beda dari Delivery
  Verification di bawah yang punya gate dokumen lengkap). Tidak berarti ada
  bug — hanya belum ada bukti PASS terdokumentasi setara tahap lain.

## 5. Delivery verification

- **Mekanisme**: `deliveries.status`
  (`supabase/migrations/20260716000001`): `planned → dispatched → arrived →
  (fully_received | partially_received | rejected | store_closed | failed) →
  verified`. Bukti (`delivery_evidence`): photo/signature/voice_note/
  location + GPS lat/long, immutable. `sales_orders.status` disinkron
  otomatis dari agregat delivery (`sync_sales_order_delivery_status`,
  `20260717000001`). Invariant kuantitas dikunci atomic
  (`finalize_delivery_item_quantities`, `20260718000001`). RPC mutasi
  dikunci `service_role`-only (`20260719000001`).
- **Status**: ✅ **PASS — MVP diimplementasikan**. Definition-of-Done
  lengkap di `docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`
  — nyaris seluruh baris ✅ (migration+RLS, service logic terpisah dari
  Telegram, 32 skenario test, idempotency, cross-tenant isolation, evidence
  authorization, owner alert berbasis dampak bisnis, aggregate lifecycle
  atomic, live smoke test).
- Sisa 🟡: demo script (`docs/sales-kit/demo-movie/`) tidak diupdate saat
  gate ini ditutup — dilaporkan sebagai conflict instruksi lain, bukan
  blocking.
- **Sengaja dikecualikan dari scope MVP** (bukan gap): GPS provider
  integration nyata (kolom lat/long ada di schema, tapi belum tersambung ke
  provider GPS device sungguhan), ML fraud verdict, route deviation engine,
  provider WhatsApp aktif.

## 6. Invoice diterbitkan

- **Mekanisme**: `issue_invoice_atomic`
  (`supabase/migrations/20260827000001`). Syarat: order `status =
  'delivered'`, satu delivery match, cakupan kuantitas penuh. Menulis
  `invoices` + `invoice_lines` + entri debit pembuka di `receivable_ledger`.
  `invoices` **tidak punya kolom status** — immutable
  (`trg_invoices_immutable`); status turunan dihitung dari view
  `invoice_receivable_balances` (`outstanding` / `partially_paid` /
  `paid`).
- **Status**: ✅ **PASS** — Gate 3A Test Matrix baris 9.3, test
  `finance/atomic-invoice-issuance.integration.test.ts`.
- Invoice void (batal setelah terbit): tabel `invoice_voids`, dipicu
  `approve_order_cancellation_atomic` — lihat tahap 9.

## 7. Pembayaran / Collection

- **Mekanisme**: `record_verified_payment_atomic`
  (`supabase/migrations/20260829000001`) — payment_receipts + proofs +
  allocations, entri kredit `receivable_ledger`. Rekonsiliasi:
  `reconcile_verified_payment` / `correct_payment_reconciliation`
  (`20260830000001`). Collection Intelligence: `promises_to_pay`
  (`open/corrected/cancelled/broken`) + `collection_activities`
  (`20260828000001`) — aging AR, reminder, promise-to-pay. UI:
  `/dashboard/finance/payments`, `/dashboard/finance/collection`
  (`/dashboard/collection` redirect ke situ).
- **Status**: ✅ **PASS untuk mekanisme inti** — Gate 3A Test Matrix baris
  9.3/9.5 (41 test collection-promise-foundation).
- **Gap #3**: **Business Guard "Collection Risk" belum diimplementasi.**
  Spec di `docs/product/modules/BUSINESS_GUARD_AI.md` menyebut "Collection
  Risk" dan "retur/cancel invoice tidak wajar" sebagai use case, tapi
  `apps/web/src/lib/business-guard/engine.ts` baru punya slice #1 (discount
  anomaly, live sejak 2026-08-14). Artinya bagian "Owner Alert" dari
  vertical slice untuk sisi Collection (piutang macet, pola pembayaran
  buruk) masih kosong — Owner harus pantau manual lewat halaman Collection,
  belum ada alert proaktif.

## 8. Invoice lunas (`paid`)

- **Mekanisme**: tidak ada RPC "mark as paid" eksplisit — status `paid`
  murni turunan: saat total alokasi pembayaran membuat saldo
  `receivable_ledger` = 0, view `invoice_receivable_balances` otomatis
  menunjukkan `'paid'`. Transisi `sales_orders.status` ke/dari `invoiced`
  dan `paid` dikunci dari mutasi generik (`20260824000001`,
  `20260825000001`) — harus lewat RPC atomic di atas.
- **Status**: ✅ **PASS** (by design — ledger immutable, tidak ada state
  tersembunyi yang bisa disunting manual).

## 9. Retur / Credit Note / Pembatalan (paralel, bisa terjadi di titik manapun sebelum lunas)

- **Mekanisme**: `request_return_atomic` / `verify_return_atomic`
  (`supabase/migrations/20260831000001`) — satu-satunya jalur pembuatan
  `credit_notes`, mengurangi saldo lewat entri kredit `receivable_ledger`.
  `reverse_credit_note_atomic` untuk pembatalan credit note.
  Pembatalan order: `order_cancellations`
  (`requested/approved/rejected`) + `invoice_voids`
  (`20260901000001`).
- **Status**: ✅ **PASS untuk mekanisme** — Gate 3A Test Matrix baris
  9.8/9.10 (cancellation & invoice void, cancellation audit workspace).
- **Gap #4**: REVENUE governed (dipakai untuk KPI/Business Health) **belum
  menyesuaikan diri** terhadap credit note/return — didokumentasikan
  eksplisit sebagai accepted risk di migration header (TRACKER Backlog
  #11), bukan oversight, tapi tetap berarti angka REVENUE bisa sedikit
  overstate kalau ada retur.
- **Gap #5**: **NOO (New Outlet Opened) tidak punya mekanisme reversal**
  saat order pembuka toko baru dibatalkan — beda dari ORDER_COUNT/REVENUE
  yang sudah punya reversal otomatis untuk kejadian pemicu identik (trigger
  `credit_noo_for_sales_order` vs mekanisme `REVERSED` di
  `20260917000001`). Risiko: kredit NOO bisa "diakali" (order pertama
  confirm sebentar lalu dibatalkan, kredit tetap nempel) dan memblokir toko
  itu dari kredit NOO sah di masa depan (unique index 1x seumur hidup sudah
  terpakai). Diputuskan 2026-08-14 untuk dicatat dulu — perlu keputusan
  Founder karena menyentuh gate LOCKED 3E-D5-A dan definisi bisnis KPI.
  Detail: TRACKER Backlog #6b.

---

## Cara pakai dokumen ini

- Dokumen hidup — update tabel "Belum PASS" dan status per tahap setiap
  kali sebuah gap di atas ditutup (gate/commit baru).
- Untuk **detail histori per commit** (siapa, kapan, bagaimana diverifikasi),
  rujuk `TRACKER.md` § Log Milestone — jangan salin isinya ke sini, cukup
  tautkan Gate ID/commit-nya (sudah dilakukan di atas).
- Untuk **memulai kerja menutup salah satu gap**, ikuti
  `docs/development/WORKFLOW.md` (intake ke `TRACKER.md` § Sedang
  Dikerjakan/Berikutnya/Ditunda dulu, baru Build).
- Gap baru yang ditemukan di luar 9 tahap ini (mis. modul lain) masuk ke
  `TRACKER.md` § Backlog & Gap Diketahui, bukan ke sini — dokumen ini khusus
  order-to-cash.
