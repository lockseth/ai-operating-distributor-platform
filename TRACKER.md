# AODP — Project Tracker

Dokumen hidup untuk melacak status keseluruhan project AI Operating Distributor
Platform: apa yang sudah selesai, apa yang masih terbuka, dan apa gap yang
diketahui. Tujuannya supaya Founder dan Claude Code tidak kehilangan jejak
lintas sesi kerja.

**Ini bukan sumber kebenaran spec/arsitektur.** Untuk itu tetap rujuk
`CLAUDE.md` → `docs/product/AODP_PRODUCT_CONSTITUTION.md` →
`docs/product/01_PRD.md` → `docs/architecture/02_TECH_ARCHITECTURE.md`.
Tracker ini hanya mencatat **status**, dan merujuk ke dokumen detail
(readiness report, migration header, commit) alih-alih menyalin isinya.

## Cara update dokumen ini

1. **Sebelum mulai kerja apapun** (request Founder, temuan CTO, bug report),
   tambahkan dulu sebagai item di
   [Sedang Dikerjakan / Berikutnya / Ditunda](#sedang-dikerjakan--berikutnya--ditunda)
   — jangan mulai kerja tanpa jejak di situ dulu.
2. **Setiap menyelesaikan sebuah gate/milestone** (PASS, PARTIAL, maupun
   BLOCKED), pindahkan item itu dari section di atas, lalu tambahkan satu
   baris baru di paling atas tabel [Log Milestone](#log-milestone-terbaru-di-atas)
   — jangan menimpa baris lama. **Beri tag asal**: `[TERENCANA]` (memang
   sudah direncanakan) · `[TEMUAN]` (ditemukan CTO saat audit/kerja lain,
   tidak direncanakan) · `[REQUEST FOUNDER]` (diminta langsung Founder,
   di luar rencana berjalan).
3. Perbarui [Status Ringkas](#status-ringkas) (tanggal, HEAD, gate terakhir).
4. Jika milestone tsb menutup atau membuka gap baru, perbarui
   [Backlog & Gap Diketahui](#backlog--gap-diketahui). Kalau membuka gap yang
   butuh keputusan Founder, tambahkan juga ke section **Ditunda** — jangan
   biarkan cuma tertulis di tengah paragraf backlog tanpa penanda.
5. Jika progres modul MVP berubah level (mis. placeholder → aktif dibangun),
   perbarui [Progres Modul MVP](#progres-modul-mvp-prd-5).
6. Jangan menyalin isi migration/RPC/test ke sini — cukup nama file/gate id
   dan satu kalimat ringkasan. Detail penuh selalu di `docs/product/readiness/`
   atau commit message aslinya.
7. **Dokumen gate (`docs/product/readiness/*.md`) wajib di-commit di commit
   yang sama dengan kode/migration terkait** — jangan dibiarkan untracked.
   Kalau tereksekusi tapi tidak ke-commit, itu gap yang harus masuk Backlog,
   bukan dianggap selesai.
8. **Gate ID baru pakai skema datar `P<fase>.<urutan>`** (mis. `P4.01`,
   `P4.02`) — jangan menambah sub-suffix baru ke skema lama (`3E-D6-B-H-R1`
   dst.), itu sudah terlalu dalam untuk dilacak. Skema lama dibiarkan apa
   adanya di histori, tidak direname retroaktif.
9. **Sebelum push yang berdampak ke deployment**, cek dulu baris "Deploy
   pipeline" di [Status Ringkas](#status-ringkas) — jangan asumsi branch mana
   yang production.

---

## Status Ringkas

| | |
|---|---|
| Tanggal update terakhir | 2026-08-16 |
| Branch | `main` |
| HEAD | `0152422` — **4 commit ahead dari `origin/main`** (docs-only x3 + Gate P4.04). `origin/main` = `f006868`, **sudah live di hosted** (dikonfirmasi 2026-08-17 lewat `vercel inspect` — deployment production 12h lalu persis match commit ini, alias `aodp-waluyo-demo.vercel.app`, health-check login page bersih tanpa console error) |
| Deploy pipeline | **Production Vercel (`aodp-waluyo-demo.vercel.app`) auto-deploy dari branch `main`.** Branch lain (`aodp-architecture-demo-v0.1`, dst.) hanya menghasilkan **Preview deployment** terpisah, TIDAK mengupdate domain demo — dikonfirmasi ulang 2026-08-15 lewat GitHub Deployments API. `aodp-architecture-demo-v0.1` tetap dipakai sebagai target branch untuk PR (CLAUDE.md), bukan branch deploy. **Vercel CLI sudah terinstall & project sudah linked** (`.vercel/project.json`) — `vercel ls`/`vercel inspect` bisa dipakai langsung utk cek status deploy real, jangan asumsi dari tanggal terakhir di tracker ini (rawan basi). |
| Status Phase 3 | **100% — OFFICIALLY LOCKED (PASS WITH ACCEPTED LIMITATIONS)** — lihat `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`. Blocker P0 (enforcement harga khusus) tertutup penuh & diverifikasi hidup di hosted lewat 5 skenario UAT (2026-08-13/14). |
| Deployment | Vercel `aodp-waluyo-demo` menjalankan commit `f006868` (production, dikonfirmasi via `vercel inspect` 2026-08-17) — **sudah termasuk Gate P4.01/P4.02/P4.03 Fase A + seluruh document engine print/batch work**, catatan lama "belum di-deploy ke hosted" di entri Sedang Dikerjakan/Log Milestone di bawah sudah basi, jangan dipercaya tanpa re-cek. Migration `20261003000001` (D6-A) sudah diterapkan ke Supabase hosted `AODP-Waluyo-Demo`. `.env.local` → Supabase lokal (`127.0.0.1`) untuk dev; `.env.demo.local` → hosted demo (kredensial demo di file itu **basi**, lihat Backlog) |
| Full LOCK Phase 3 | **Sudah** — lihat closeout final. Owner Approval Inbox UI TETAP belum ada (bukan blocker Phase 3, gate baru terpisah untuk next workstream) |
| Governance | Sejak 2026-08-14: **Claude Code = CTO + Senior Programmer AODP** (menggantikan ChatGPT sebagai CTO+PM). Keputusan teknis/arsitektur diputuskan langsung oleh Claude Code (didokumentasikan di sini/commit message); keputusan arah produk/bisnis tetap diajukan ke Founder dulu. Detail: `CLAUDE.md` §Role Split. |
| Data Operasional (tenant Waluyo, hosted) | KPI Setup lengkap — 5/5 KPI governed punya target aktif periode Agustus 2026 (Call 15, Effective Call 15, Order Count 15, Revenue Rp100jt, NOO 3 toko). Dashboard Owner sekarang menampilkan progres real untuk semuanya, bukan lagi "Data belum cukup". |

---

## Handoff sesi (2026-08-16, rate limit mingguan Founder >90%)

Sesi ini dilanjutkan di akun/sesi lain Founder. Ringkasan supaya sesi
berikutnya tidak perlu re-derive dari nol:

**Yang sudah PASS terverifikasi lokal, menunggu SATU keputusan Founder:**
push `git push origin main` (12 commit, sudah PASS lokal semua — build,
lint, test suite 2563/2564 dengan 1 kegagalan pra-existing tidak terkait
di `telegram-enrollment-control.security.test.ts`) ke hosted
(`aodp-waluyo-demo.vercel.app`, deploy otomatis dari `main` — lihat baris
"Deploy pipeline" di atas). Isi 12 commit itu (`fd5f410`..`30fa6ad`):
Gate P4.01 (`requested_delivery_date` untuk AI Dispatch Planner) +
konsolidasi field tanggal, fix role-aware "Sales yang Menangani" +
perbaikan query roles yang lama rusak, fix bug listbox pencarian
pelanggan, halaman baru Lihat/Cetak Invoice (Document Engine), hapus menu
sidebar "Collection", **dan yang paling penting: fix bug 500 yang
memblokir pembuatan order sejak awal role-play** (root cause:
`generateOrderNumber()` kena RLS-blind, lihat Log Milestone
tersegera/Sedang Dikerjakan #1 di bawah untuk detail lengkap).

**Konteks lingkungan kerja (supaya sesi baru tidak perlu re-discover)**:
- Docker Desktop harus jalan dulu sebelum `supabase start`/`db reset` bisa
  connect (sempat gagal "Docker Desktop is unable to start" sebelum
  dinyalakan manual oleh Founder).
- Port 3000 bisa bentrok dengan sesi chat lain — `.claude/launch.json`
  sudah diset `"autoPort": true` untuk `aodp-web`, otomatis pindah port
  kalau bentrok (lihat hasil `preview_start` untuk port aktual).
- Seed lokal: `pnpm seed:dev` → `owner@aodp.test` / `sales@aodp.test`,
  password `Aodp2026!` (login manual, tombol "🧪 Masuk Demo" beda akun).
- **Vercel CLI sudah terpasang & terautentikasi** di sesi ini (`.vercel/`
  sudah linked ke project `aodp-waluyo-demo`) — `vercel logs
  <deployment-url>` berguna untuk debug tapi cuma live-snapshot (reproduksi
  dulu errornya, baru langsung panggil `vercel logs`, bukan riwayat lama).
- Login ke hosted demo (`aodp-waluyo-demo.vercel.app`) sebagai
  `slamatwaluyo@gmail.com` (akun sales asli Pak Waluyo) **wajib dilakukan
  Founder sendiri** — Claude Code tidak pernah pegang passwordnya.
- Role-play UAT masih di **Tahap 1 selesai** (order dibuat+dikonfirmasi
  terbukti jalan) — Tahap 3-6 (dispatch→delivery→invoice) sudah dibuktikan
  jalan **lewat RPC langsung**, belum lewat klik UI penuh karena Delivery
  Verification cuma ada jalur Telegram (lihat gap di bawah). Peta lengkap:
  `docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md`.

---

## Sedang Dikerjakan / Berikutnya / Ditunda

Ini **bagian prospektif** (apa yang sedang/akan dikerjakan) — beda dari
[Log Milestone](#log-milestone-terbaru-di-atas) yang **retrospektif** (apa
yang sudah selesai). Sebelumnya tracker ini tidak punya bagian ini sama
sekali, sehingga kerja terasa "lompat-lompat" — mulai dari sini semua item
baru wajib singgah di sini dulu sebelum dikerjakan. Lihat juga
`docs/development/WORKFLOW.md` untuk alur lengkapnya.

Tag asal: `[REQUEST FOUNDER]` diminta langsung Founder · `[TEMUAN]`
ditemukan CTO saat audit/kerja lain · `[TERENCANA]` bagian roadmap yang
memang sudah direncanakan.

### Sedang Dikerjakan

1. `[REQUEST FOUNDER]` **Role-play UAT order-to-cash end-to-end** — Claude
   Code jalankan siklus penuh sebagai role `sales` (`slamatwaluyo@gmail.com`,
   tenant PT Sumber Warna Alam Sudiada) sesuai
   `docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md`, Founder mengamati lewat
   Browser pane, login dilakukan Founder sendiri. Environment: **hosted
   demo** `aodp-waluyo-demo.vercel.app` — order/invoice yang dibuat nambah
   data sungguhan di situ. Aturan interupsi berlaku: stop, jawab, catat,
   tidak lanjut tanpa perintah eksplisit.
   - **STATUS: RESOLVED — root cause ditemukan & DITUTUP (2026-08-16)**.
     Sempat BLOCKED lama di Tahap 1 (order dibuat) — percobaan pertama
     (Pelanggan "Tk Agung abadi", 1x DEMO-Cat Kayu Besi 1kg, harga normal
     tanpa diskon, qty 1) gagal `POST /dashboard/orders/new → HTTP 500`,
     pesan error diredaksi total oleh Next.js production (Backlog #4),
     RPC `create_sales_order_atomic` sudah dibaca lengkap dan semua jalur
     errornya bersih — jadi sempat disimpulkan penyebabnya di luar RPC,
     butuh akses log yang saat itu belum ada.
     **Cara ketemu**: `vercel logs` CLI ternyata sudah ter-install &amp;
     terautentikasi di sesi ini (project sudah linked via `.vercel/`,
     tidak perlu login ulang) — tapi cuma live-snapshot, bukan riwayat
     lama. Direproduksi ulang persis (customer/produk sama, sesi Waluyo
     yang masih aktif di hosted) lalu `vercel logs` langsung dipanggil
     sesudahnya — dapat digest error `790590101`:
     ```
     Error: duplicate key value violates unique constraint
     "sales_orders_company_id_order_number_key"
     ```
     **Root cause**: `generateOrderNumber()` (`lib/orders/actions.ts`)
     pakai `createClient()` (kena RLS) untuk cari nomor urut order
     terakhir bulan ini, padahal RLS `sales_orders_select` cuma izinkan
     role `sales` lihat order **miliknya sendiri** (`sales_id =
     auth.uid()`) — constraint unique `order_number`-nya company-wide.
     Kalau ada order bulan ini dari sales lain/owner yang tidak terlihat
     sales ini, nomor yang dihasilkan undercount dan tabrakan dengan yang
     sudah ada. **Fix**: `generateOrderNumber()` diganti pakai
     `getAdminClient()` (bypass RLS, sama seperti RPC call
     `create_sales_order_atomic` yang sudah pakai admin client di fungsi
     yang sama) — konsisten, sekarang selalu lihat nomor tertinggi
     company-wide. Diverifikasi lokal: reproduksi kondisi sama (order
     `SO-2608-0002` milik role lain yang RLS-blind untuk `sales@aodp.test`)
     → order baru `SO-2608-0003` berhasil dibuat tanpa duplicate key.
     Build PASS, test order PASS. **Belum di-deploy ke hosted.**
   - **Temuan #1 (dikonfirmasi benar)**: auto-attribution `sales_id` ke
     actor sales sendiri + guard "toko tidak bisa pindah sales sembarangan"
     sudah terimplementasi persis sesuai insight Pak Waluyo — Gate
     3E-D3-A (`20260919000001_gate_3e_d3_a_sales_auto_attribution.sql`).
     Dropdown "Sales yang Menangani" di form tetap tampil tapi tidak
     berpengaruh untuk role sales (server override) — bukan bug, tapi
     berpotensi membingungkan karena tampak seperti pilihan yang nyata.
   - **Temuan #2 (gap baru) — DITUTUP Fase A, Gate P4.01, checkpoint lokal
     PASS**: field "Tanggal Pengiriman" di form create order mengisi
     `sales_orders.delivery_date` — murni catatan/tampilan (muncul di list
     & detail order), **bukan** sinyal yang dipakai AI Dispatch Planner.
     Planner sebenarnya baca kolom terpisah `sales_orders.
     requested_delivery_date` ("preferensi tanggal kirim customer",
     `20260721000001_dispatch_planning.sql`) — tapi kolom itu tidak punya UI
     sama sekali. Ditutup lewat migration `20261005000001` (param baru
     `p_requested_delivery_date DATE DEFAULT NULL` di
     `create/update_sales_order_atomic`, pola additive identik gate foto/GPS
     toko) + field baru "Tanggal Diminta Customer" di `order-form.tsx`.
     Diverifikasi lokal: build+lint PASS, `supabase db reset` PASS tanpa
     error, 2563/2564 test suite PASS (1 gagal pra-existing tidak terkait,
     soal tombol Telegram enrollment), RPC create & update dites langsung
     lewat psql — kolom `requested_delivery_date` tersimpan &amp; ter-update
     terpisah dari `delivery_date`, terbukti benar. **Belum di-deploy ke
     hosted** — menunggu keputusan Founder (lihat Berikutnya).
     Field "Sales yang Menangani" (Temuan #1) sengaja BELUM dikerjakan —
     Fase B, sesi terpisah, atas permintaan Founder (rate limit).
   - **Susulan (koreksi UX, masih Fase A)**: Founder tes lokal, sadar 2
     field tanggal terpisah ("Tanggal Pengiriman" vs "Tanggal Diminta
     Customer") berisiko membingungkan sales — kemungkinan besar sales cuma
     isi salah satu, field yang benar-benar dipakai AI Dispatch Planner
     tetap tidak kepakai (gap cuma pindah tempat, bukan tertutup). Digabung
     jadi **1 field** ("Tanggal Kirim Diminta Customer (opsional)") yang
     mengisi KEDUA kolom sekaligus (`delivery_date` &amp; `requested_delivery_date`
     dapat nilai sama dari 1 input) — sales tidak perlu tahu ada 2 konsep di
     baliknya. `order-form.tsx`/`actions.ts` disederhanakan (tidak ubah
     migration `20261005000001`, kolomnya tetap 2, cuma sumber datanya
     disatukan di form). Diverifikasi ulang end-to-end lewat browser lokal
     (login sales, buat order `SO-2608-0001`, tanggal "30 Agustus 2026") +
     query DB langsung: `delivery_date` &amp; `requested_delivery_date`
     sama-sama terisi benar. Observasi tambahan: order berhasil dibuat
     tanpa error di local — kontras dengan bug 500 di hosted (blocker Tahap
     1), memperkuat dugaan akar masalah 500 spesifik ke environment hosted
     (data/RLS/state), bukan bug di kode order-creation itu sendiri.
   - **Temuan #1 — DITUTUP Fase B, checkpoint lokal PASS**: field "Sales
     yang Menangani" sekarang role-aware di `order-form.tsx`. Role sales →
     teks read-only (nama sales sendiri, tanpa dropdown palsu). Role
     owner/manager/admin/super_admin → dropdown tetap seperti semula.
     **Bonus temuan sambil mengerjakan**: query `salesUsers` di
     `orders/new/page.tsx` &amp; `orders/[id]/edit/page.tsx` pakai
     `.contains("roles", ["sales"])` — kolom `roles` **tidak ada** di tabel
     `users` (dicek langsung ke schema), jadi query ini gagal senyap dan
     dropdown itu **selalu kosong** untuk owner/admin selama ini, bug lama
     tidak terkait role-split. Diganti pakai pola join yang sudah terbukti
     benar di `users/page.tsx` (`user_roles!user_id(role:roles(name))` +
     filter di JS). Diverifikasi browser lokal 2 role: sales lihat "Sales
     Pertama" (read-only, tanpa prefix "Ditangani oleh:" atas permintaan
     Founder), owner lihat dropdown terisi benar ("Belum ditugaskan" +
     "Sales Pertama"). Build+typecheck PASS.
   - **Bug ditemukan Founder saat tes lokal — DITUTUP**: field "Pelanggan"
     pakai search box + `<select size>` listbox terpisah (bukan native
     autocomplete). Klik opsi di listbox **secara fungsional benar**
     (`customerId` ter-set — dikonfirmasi visual: baris jadi biru terpilih),
     tapi search box tidak ikut ter-update/dikosongkan dan listbox tidak
     collapse — jadi terlihat seperti tidak terjadi apa-apa, padahal
     datanya benar. Root cause: bug feedback visual, bukan data binding.
     Fix: `setCustomerSearch("")` dipanggil bareng `setCustomerId()` saat
     memilih — pola identik yang sudah benar di search produk
     (`selectProduct` mengosongkan `productSearch` setelah pilih).
     Diverifikasi browser: search "tok" → klik opsi → search box kosong,
     dropdown collapse menampilkan "Toko Sumber Rejeki..." terpilih jelas.
     Build PASS.
   - **Temuan besar — lanjutan role-play ke Tahap 3-6 (lokal, order
     `SO-2608-0002`)**: setelah order dikonfirmasi, ditemukan 2 gap terkait
     Delivery Verification & Invoice yang belum tercatat di
     `AODP_ORDER_TO_CASH_WORKFLOW.md`:
     1. **Tombol status generik ("Proses"/"Kirim"/"Tandai Terkirim") di
        `orders/[id]/page.tsx` sama sekali tidak terhubung ke tabel
        `deliveries`** — `update_sales_order_status_atomic` tidak punya
        pengecekan apa pun ke bukti pengiriman sebelum mengizinkan status
        `delivering`/`delivered`. Artinya siapa pun dengan akses
        `orders.update` bisa menandai order "Terkirim" tanpa foto/GPS/driver
        sama sekali — jalur ini **disengaja ada** sebagai "override manusia
        yang valid" (komentar migration `20260717000001`), tapi tidak
        ada guardrail/role-restriction/log tambahan yang membedakannya dari
        jalur Delivery Verification asli yang sudah PASS/LOCKED.
     2. **Tidak ada jalur web UI sama sekali untuk menerbitkan invoice** —
        dikonfirmasi lewat komentar eksplisit di `finance/invoices/page.tsx`:
        `issue_invoice_atomic` "dipicu alur Delivery Verification, bukan
        workspace ini". Tidak ada tombol "Buat Invoice" di halaman detail
        order maupun di workspace Finance. Satu-satunya jalur adalah bot
        Telegram (driver terdaftar) — yang tidak tersedia di environment
        manapun yang sedang diuji (lokal maupun hosted demo).
     Kedua gap ini **membuat Tahap 5-6 pada `AODP_ORDER_TO_CASH_WORKFLOW.md`
     perlu direvisi statusnya** — PASS hanya benar untuk jalur Telegram,
     belum ada jalur web/manual yang setara amannya. Perlu update dokumen
     workflow itu terpisah (belum dikerjakan sesi ini).
   - **Pembuktian mekanisme asli (RPC langsung, bukan bypass tombol
     generik)** — atas persetujuan Founder, dibuktikan Tahap 3→6 order
     `SO-2608-0002` bisa selesai lewat RPC yang sama persis dipakai jalur
     Telegram, tanpa perlu setup bot: `create_delivery_atomic` →
     `dispatch_delivery_atomic` → `finalize_delivery_item_quantities`
     (full coverage, qty 15+18) → `sync_sales_order_delivery_status`
     (order → `delivered`) → `issue_invoice_atomic` (invoice
     `AODPDEV-INV-20260816-000001` terbit, Rp833.990, order → `invoiced`,
     dikonfirmasi `outstanding` di `invoice_receivable_balances`). Satu
     syarat tambahan ditemukan: `issue_invoice_atomic` menolak
     (`COMPANY_PROFILE_INCOMPLETE`) sampai profil company (legal_address,
     contact_email, contact_phone, document_number_prefix) lengkap — data
     seed lokal awalnya tidak mengisi ini, dilengkapi manual via SQL untuk
     testing (data lokal, bukan tenant nyata). **Kesimpulan: mekanisme
     backend Tahap 5-6 terbukti benar dan solid — gap-nya murni di lapisan
     UI/aksesibilitas jalur non-Telegram, bukan di RPC/data integrity.**
   - **Halaman baru — Lihat/Cetak Invoice, DITUTUP, checkpoint lokal PASS**:
     Founder minta bisa benar-benar melihat dokumen nota/invoice (bukti
     database saja tidak cukup), sejalan arahan channel baru: Web dipakai
     Sales (Telegram disisihkan dulu) + Owner/Admin (WA menyusul). Route
     baru `finance/invoices/[id]/print` menyambungkan komponen Document
     Engine yang sudah lengkap & teruji (`PrintDocumentPanel`,
     `buildPrintViewModel`, `paginatePrintDocument`) — sebelumnya cuma
     dipakai di test integration (render ke HTML statis di scratchpad),
     tidak pernah ada di satu pun route aplikasi. Tombol "Lihat/Cetak
     Invoice" ditambahkan di halaman detail invoice existing.
     **Temuan arsitektur sambil mengerjakan**: ternyata ada 2 jalur
     pembuatan snapshot invoice yang independen dan sudah divergen — RPC
     SQL `issue_invoice_atomic` (jalur transaksional locked, dipakai role-
     play ini) menulis snapshot "tipis" (lines/totals/nomor dokumen saja),
     sedangkan builder TypeScript `issueInvoiceDocument()`
     (`document-engine/issuance.ts`, HANYA dipakai di
     `full-path-demo.integration.test.ts`, tidak pernah dipanggil jalur
     produksi manapun) menghasilkan snapshot lengkap (+ tenant/store/
     salesman/signatures). Ditutup TANPA menyentuh RPC yang locked: halaman
     print melengkapi 4 bagian yang hilang (`tenant`, `store`, `salesman`,
     `signatures`) dari tabel `companies`/`sales_orders`/`deliveries` saat
     baca, snapshot tersimpan di DB tidak diubah. **Follow-up yang belum
     dikerjakan**: apakah dua jalur snapshot ini sengaja dibiarkan berbeda,
     atau `issue_invoice_atomic` seharusnya ikut menulis snapshot lengkap
     dari awal — perlu keputusan terpisah, bukan diputuskan sepihak di sini.
     Diverifikasi browser lokal: invoice `AODPDEV-INV-20260816-000001`
     tampil lengkap (kop perusahaan, data toko, item, subtotal/diskon/
     grand total/terbilang, kolom tanda tangan). Build+typecheck PASS.
   - **Audit template vs `AODP_DOCUMENT_LAYOUT_GUIDE.md` (LOCKED, sesi
     23 Juli 2026)** — diminta Founder. 5 dari 7 elemen sesuai (header,
     9 kolom item, panel Data Toko/Customer 2-kolom, Totals Subtotal/
     Potongan/Grand Total/Terbilang, tanda tangan Salesman/Pengirim/
     Penerima). **2 gap ditemukan, disepakati dikerjakan nanti (bukan
     sekarang)**:
     1. Baris **"Tempo"/termin pembayaran hilang** — LOCKED spec bilang
        wajib (`PAYMENT_TERMS_INCOMPLETE` saat issuance). Form order Web
        **tidak punya field termin sama sekali**, `orders/actions.ts:240`
        hardcode `p_payment_terms_days: null` saat konfirmasi. RPC
        produksi `issue_invoice_atomic` juga **tidak menegakkan**
        validasi wajib ini — hanya jalur TS yang tidak terpakai
        (`assertPaymentTermsComplete`, `document-engine/repository-adapter.ts`)
        yang punya pengecekan itu. Ini gap bisnis nyata, bukan cuma
        tampilan: invoice bisa terbit tanpa termin.
     2. **Belum pakai `PhysicalPrintSheet.tsx`** (2 panel 9.5x5.5in per
        lembar fisik 9.5x11in, untuk cetak continuous form 3 ply) —
        halaman yang dibuat cuma render `PrintDocumentPanel` satuan
        berurutan, cukup untuk "Lihat" di layar tapi belum sesuai kalau
        untuk cetak fisik ke printer dot-matrix.
   - **Klarifikasi tambahan (2026-08-16)**: Founder tunjukkan gambar
     referensi template "Continuous Form 4 Ply, 1 dokumen = 1 halaman
     penuh, tanda tangan 'DITERIMA OLEH'" — sekilas bertentangan dengan
     spec LOCKED di atas (3 Ply, 2 panel/lembar, "Penerima"). Dicek ke
     revision history `AODP_DOCUMENT_LAYOUT_GUIDE.md`: format di gambar
     itu persis versi PAGI 23 Juli 2026 yang **sudah dibatalkan sendiri**
     malam harinya di hari yang sama (dikoreksi ke 3 Ply/2 panel/
     "Penerima" — LOCK final). **Dikonfirmasi Founder: gambar itu
     referensi lama yang sudah dibatalkan, bukan keputusan baru** — kode
     Document Engine saat ini (`PrintDocumentPanel`, `print-pagination`,
     `print.css`) sudah benar mengikuti versi LOCKED final, tidak perlu
     direvisi. Dicatat di sini supaya kalau gambar yang sama muncul lagi
     di sesi lain, tidak perlu diinvestigasi ulang dari nol.
   - **Sidebar: item "Collection" dihapus — DITUTUP, checkpoint lokal
     PASS**: Founder laporkan klik "Collection" di sidebar mengarah ke
     Finance Operations (membingungkan) — memang benar redirect disengaja
     (Gate 2I.4-G11, `/dashboard/collection` → `/dashboard/finance/collection`,
     workspace Finance Operations sudah punya tab "Collection & Janji
     Bayar" sendiri, jadi menu sidebar terpisah jadi redundan). Item +
     `IconCollection` dihapus dari `sidebar.tsx`; route redirect-nya TETAP
     ada (untuk bookmark/link lama). Test regresi lama yang justru
     mengunci KEBERADAAN item ini (`sidebar.test.ts`) diperbarui jadi
     mengunci KETIADAANNYA. Diverifikasi: build PASS, test PASS
     (2563/2564, 1 gagal pra-existing tidak terkait), browser lokal
     dicek sidebar owner — "Collection" hilang, langsung KPI Salesman →
     Finance Operations.

2. `[REQUEST FOUNDER]` **Rencana checkpoint 4-poin (disetujui 2026-08-17)**
   — Founder minta progres AODP diaudit, CTO ajukan urutan prioritas,
   disetujui, dieksekusi bertahap dengan checkpoint + update tracker tiap
   poin selesai:
   1. ~~Commit 4 dokumen readiness Gate 3D-B3-F5/3E-D0~~ — **DITUTUP**, lihat
      Log Milestone (`8ec2eb0`).
   2. ~~Push Gate P4.01 (`requested_delivery_date`) + P4.02
      (`payment_terms_days`) ke hosted~~ — **TERNYATA SUDAH LIVE**, dicek
      2026-08-17 lewat `vercel inspect` (lihat Log Milestone koreksi). Tidak
      ada push baru diperlukan untuk gate-gate ini — hanya 2 commit
      docs-only (checkpoint #1 + tracker) yang masih menunggu push, itu
      pun bukan bagian rencana asli poin ini.
   3. Fix gap validasi status pengiriman: tombol status generik
      ("Proses"/"Kirim"/"Tandai Terkirim") di `orders/[id]/page.tsx` tidak
      terhubung ke tabel `deliveries` — **DITUTUP sebagian, Gate P4.04**
      (`0152422`), lihat Log Milestone. Audit visibility ditambahkan
      (`delivery_verified`/`manual_override` di `audit_logs.new_data`),
      jalur override TIDAK diblokir (sengaja, sudah didesain sejak
      `20260717000001`). Keputusan apakah perlu restriksi role/blocking
      penuh tetap dibundel ke poin #4 di bawah (bisnis, bukan teknis).
   4. Kumpulkan & ajukan sekaligus 5 keputusan bisnis yang menggantung (NOO
      reversal, konsolidasi password recovery, role `driver` utk sales
      all-in, akses `payment.record`, **+baru dari poin #3**: apakah tombol
      status generik "Kirim"/"Tandai Terkirim" perlu dibatasi role
      tertentu — owner/manager/admin saja, atau tetap terbuka utk
      sales/driver seperti sekarang, mengingat sekarang sudah ada audit
      trail utk override tanpa bukti) ke Founder dalam 1 pertanyaan —
      **belum dieksekusi**.
   Item lebih besar (P4.03 Fase B voice note, Business Guard Collection
   Risk) sengaja ditaruh setelah 4 poin ini selesai.

### Berikutnya (urutan prioritas, atas = duluan)

1. `[REQUEST FOUNDER]` **Redesain Laporan Sales — Fase A SELESAI (2026-08-16,
   lihat Log Milestone Gate P4.03), Fase B (voice note) masih menunggu.**
   Fase A yang sudah dikerjakan: form `dashboard/reports/new` TIDAK LAGI
   minta sales ketik ulang `target_oa`/`achieved_oa`/`target_revenue`/
   `achieved_revenue`/`items[]` — semua otomatis dari governed KPI ledger +
   `sales_order_items`, server tidak pernah percaya angka dari client.
   Sales cuma isi `area`/`remaining_working_days`/`notes` (bagian kualitatif
   yang memang tidak bisa diotomatisasi). Ranking "Performa Sales" juga
   sudah ditarik dari target KPI governed asli (Target/Gap/Pencapaian per
   sales), bukan dihilangkan — lihat Log Milestone.

   **Sisa scope (Fase B, dari voice note Pak Waluyo ke Mas Hendro,
   2026-08-16) — BELUM dikerjakan, masih menunggu keputusan Founder**:
   kalimat kunci beliau *"saya sudah menerima rekapan dari SISTEM"* (bukan
   "laporan dari sales") memvalidasi arah Fase A, tapi voice note ini
   menambah 3 kebutuhan baru yang BELUM tercakup:
   1. **Jadwal kirim otomatis ~16.00-17.00** setiap hari kerja sales,
      supaya begitu sales pulang kantor, Owner sudah bisa langsung
      briefing/evaluasi. Kemungkinan ini pas dengan fitur "Executive
      WhatsApp Report" yang sudah disebut di
      `docs/product/AODP_PRODUCT_CONSTITUTION.md` §13 (laporan harian ke
      WhatsApp owner) — **belum pernah dibangun**, jadi bagian ini
      kemungkinan besar bukan cuma redesain form, tapi juga scheduled
      job/notification baru (scope lebih besar dari sekadar ubah
      `reports/new/page.tsx`, perlu di-assess ulang saat mulai
      dieksekusi).
   2. **Konten spesifik yang diminta** (urutan sesuai voice note): EC
      (Effective Call)/kunjungan toko → dari situ berapa yang **berhasil
      transaksi** (EC-to-transaksi, bukan cuma kunjungan) → Tagihan
      (status collection/penagihan) → Omzet (nominal + % dari target).
      Opsional: breakdown per periode (pagi/siang/sore, "udah dapat
      berapa"). Ini detail lebih spesifik dari sekadar "5 KPI governed" —
      perlu dipetakan field-per-field ke KPI code yang sudah ada
      (CALL/EFFECTIVE_CALL/REVENUE) + cek apakah "Tagihan" (piutang/
      collection) sudah masuk governed KPI atau perlu sumber terpisah
      (Collection Intelligence/Finance Operations).
   3. **Varian laporan PAGI terpisah, isinya beda dari sore** — bukan
      hasil kerja, tapi RENCANA hari itu: toko mana yang mau ditagih
      ("tagihan toko yang mau dibawa"). Ini konsep baru (laporan
      forward-looking), belum ada padanannya di rencana redesain awal
      yang cuma bahas 1 laporan (sore/hasil).
   Catatan: satu bagian transkrip tidak jelas ("LFD bekolnya") — tidak
   ditebak maknanya, perlu klarifikasi ulang ke rekaman/Pak Waluyo
   langsung sebelum dieksekusi, bukan diasumsikan.
2. `[REQUEST FOUNDER]` **Fondasi data untuk chatbot bisnis Owner — DISETUJUI
   arahnya (2026-08-16), EKSEKUSI SENGAJA DITUNDA** ("simpan dulu di
   tracker, kerjakan kalau waktunya tiba"). Konteks: Founder tanya sebagai
   SPV, data/laporan apa yang dibutuhkan supaya nanti Owner bisa tanya
   chatbot soal bisnisnya (misal "produk apa paling laku", "toko mana
   paling banyak order bulan ini", "tagihan mana yang bakal macet").
   Audit kesiapan per kategori:
   - **SIAP, tinggal digeneralisir** — "Produk paling laku" & "Toko
     paling banyak order": data mentahnya sudah lengkap (`sales_order_items`
     + `sales_orders` confirmed+, sama pola dengan `getDailySoldItems`
     Gate P4.03) — tinggal buat agregat per rentang tanggal bebas
     (bukan cuma "hari ini"), di-groupkan per produk atau per customer.
   - **SUDAH ADA, tinggal disurfacing ke chatbot** — governed KPI
     (Call/EC/Order/Revenue/NOO per sales, sekarang termasuk Target/Gap/
     Pencapaian per Log Milestone di bawah), Business Guard discount
     anomaly (`lib/business-guard/`), sinyal pelanggan tidak aktif >45
     hari (sudah muncul di widget "Perlu Follow Up" Dashboard Owner).
   - **BELUM ADA SAMA SEKALI, butuh logic baru** — "Tagihan mana yang
     bakal macet": data mentah (invoice, saldo piutang, riwayat bayar)
     sudah ada di Finance Operations, tapi skor risiko "macet"-nya
     sendiri belum ada. Ini persis modul **Business Guard Collection
     Risk** yang sudah tercatat sebagai gap di Backlog (baru ada slice
     Sales Risk/discount anomaly, Collection Risk belum dikerjakan) —
     kalau chatbot mau menjawab pertanyaan ini, Collection Risk harus
     dibangun dulu (bukan cuma query, perlu definisi "macet" -- umur
     piutang + pola bayar historis -- yang belum ada presedennya).
   Rekomendasi CTO (belum dieksekusi): bangun **satu lapisan agregat
   terstruktur** dulu sebelum chatbot-nya sendiri (bukan query ad-hoc
   per pertanyaan), dan prioritaskan Collection Risk lebih dulu karena
   itu satu-satunya kategori yang benar-benar kosong, bukan cuma perlu
   disambungkan. Sesuai AI provider layer rule (`CLAUDE.md` #3), chatbot
   nanti wajib lewat `packages/ai`, bukan panggil vendor AI langsung.

### Ditunda — menunggu keputusan Founder

| Item | Tag | Sejak | Konteks |
|---|---|---|---|
| NOO tidak punya mekanisme reversal saat order pembuka toko dibatalkan | `[TEMUAN]` | 2026-08-14 | Menyentuh gate LOCKED 3E-D5-A + definisi bisnis KPI. Detail: Backlog #6b |
| 3 mekanisme password recovery aktif bersamaan (email legacy, super-admin DB-only, Telegram self-service) — email legacy disengaja atau harus dimatikan? | `[TEMUAN]` | 2026-08-14 | Detail: Backlog #13 |
| WIP `forgot-password-form.tsx` memanggil RPC yang migration-nya cuma ada di `migrations_archive/` — akan gagal runtime bila dideploy apa adanya | `[TEMUAN]` | 2026-08-14 | Protected WIP milik Founder, belum diperbaiki karena statusnya. Detail: Backlog #14 |
| Owner Approval Inbox UI (proposal harga khusus) | `[TERENCANA]` | 2026-08-14 | RPC sudah ada & teruji (`decide_special_price_proposal_atomic`), tinggal UI. Detail: Backlog #3 |
| Halaman drill-down Call/Effective Call lintas-salesman untuk Owner/Manager | `[TEMUAN]` | 2026-08-15 | Detail: Backlog #7 |
| Sales "all-in" (order+kirim sendiri) tidak muncul di dropdown "Assign driver" — solusi kemungkinan operasional (tambah role `driver` ke akun sales, AODP sudah dukung multi-role per user), bukan kode. Perlu konfirmasi ini memang cara yang diinginkan sebelum dieksekusi ke akun nyata | `[TEMUAN]` | 2026-08-16 | Ditemukan saat role-play lokal Tahap 5. Detail: Log Milestone hari ini |
| Permission `payment.record` cuma owner/finance — sales "all-in" yang nagih & terima cash sendiri (kasus Pak Waluyo) tidak punya jalur mencatat pembayaran yang diterimanya. Apakah sales/driver perlu diberi akses ini (dengan guardrail apa), atau tetap harus lapor ke Finance/Owner untuk dicatatkan? | `[TEMUAN]` | 2026-08-16 | Kontrol internal (siapa boleh catat uang masuk) — keputusan bisnis, bukan teknis. Detail: Log Milestone hari ini |

---

## Progres Modul MVP (PRD §5)

Rujukan: `docs/product/01_PRD.md` §5, `docs/product/modules/*.md`.

| Modul | Status | Catatan |
|---|---|---|
| **Core Platform** (auth, RBAC multi-tenant, sales order, customers, products, delivery, finance/invoicing) | Matang, gate terbanyak (3A–3D, 3E-D3–D5) | Enforcement harga khusus LOCKED & hosted-verified (Gate 3E-D6-A/B); Owner Approval Inbox UI masih next workstream (lihat Backlog) |
| **FlowSales AI** (laporan sales, KPI, AI Dispatch Planner, Telegram Sales Order Entry, AI Insights) | Matang, aktif dikembangkan | Gate 3E-D4/D5, Owner BI A–E |
| **Collection Intelligence** | Diimplementasikan sebagai bagian Finance Operations Workspace | `/dashboard/collection` redirect ke `/dashboard/finance/collection` (Gate 2I.x) |
| **Business Guard AI** (Risk Alert) | **Dimulai 2026-08-14** — slice #1 (Sales Risk / Discount Anomaly Indicator) hidup, rule-based, verified lokal. Sisanya (Behavior Change, Risk Alert List umum, Transaction Risk Score) masih "Segera Hadir" | `apps/web/src/lib/business-guard/`, `apps/web/src/app/(dashboard)/dashboard/risk/page.tsx` |
| **WhatsApp AI** | **Belum diimplementasi** — UI "Segera Hadir" | `apps/web/src/app/(dashboard)/dashboard/whatsapp/page.tsx` |
| **Warehouse Intelligence** | **Placeholder resmi MVP** (bukan gap — keputusan produk terkunci, CLAUDE.md aturan #6) | Dashboard dasar delivery stats saja |

---

## Backlog & Gap Diketahui

Sumber: `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md` §15–16
(audit 2026-08-12) + `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`
(closeout final 2026-08-14). **Phase 3 sudah LOCKED** — daftar di bawah ini
sekarang murni next-workstream/accepted-limitation, bukan lagi P0 blocking.

### Next workstream (di luar Phase 3, tidak blocking)

1. ~~Web order create/update RPC tidak validasi `unit_price`...~~ —
   **DITUTUP** Gate 3E-D6-A (`ff74a2e`), diverifikasi hidup di hosted.
2. ~~Special-price approval workflow sisi Sales tidak punya UI~~ —
   **DITUTUP** Gate 3E-D6-B (`60e2d9e`), diverifikasi hidup di hosted.
3. **Owner Approval Inbox UI belum ada** — Owner tetap bisa memutuskan
   proposal lewat RPC existing `decide_special_price_proposal_atomic`
   (locked, teruji, dibuktikan bekerja di hosted lewat sesi Owner nyata),
   hanya belum ada UI untuk itu. Bukan blocker Phase 3 (bukan gate yang
   pernah dicharter terpisah) — gate baru terpisah untuk next workstream.
4. Pesan error Server Action di-redaksi generik oleh Next.js production
   (app-wide, bukan spesifik D6-A/D6-B) — accepted limitation, follow-up UX
   kecil terpisah.
5. Kredensial demo `.env.demo.local` basi (3 akun demo tidak eksis di
   hosted) — accepted limitation, perlu regenerasi + investigasi kaitan ke
   #7 di bawah.
6b. **[USULAN CTO, BELUM DIKERJAKAN]** NOO tidak punya mekanisme reversal
   saat order pembuka toko dibatalkan — beda perlakuan dari ORDER_COUNT/
   REVENUE yang SUDAH punya reversal otomatis untuk kejadian pemicu yang
   identik (order → cancelled, lihat trigger `credit_noo_for_sales_order`
   vs mekanisme REVERSED di `20260917000001`). Risiko: kredit NOO bisa
   "diakali" (order pertama confirm sebentar lalu dibatalkan, kredit tetap
   nempel selamanya) DAN memblokir toko itu dapat kredit NOO yang sah di
   masa depan (unique index 1x seumur hidup per customer sudah terpakai).
   Sekarang jadi lebih material karena NOO sudah dipakai untuk target
   nyata (Agustus 2026: 3 toko). Diputuskan 2026-08-14 untuk dicatat dulu,
   belum dieksekusi — perlu keputusan Founder karena menyentuh gate yang
   sudah LOCKED (3E-D5-A) dan definisi bisnis KPI.
6. React error #418 (hydration) intermiten saat automated testing hosted —
   root cause tidak 100% dipastikan (kemungkinan artefak tooling), accepted
   limitation, perlu spot-check manual non-automated.
7. **[USULAN, BELUM DIKERJAKAN]** Halaman laporan kunjungan sales untuk
   Owner/Manager (drill-down Call/Effective Call lintas-salesman). Saat ini
   kartu Call & Effective Call di `/dashboard/kpi` HANYA bisa diklik saat
   sales melihat achievement dirinya sendiri (link ke `/dashboard/sales-visits`,
   yang role-gated khusus sales, self-only) -- saat Owner/Manager melihat
   achievement salesman lain, dua kartu itu sengaja dibiarkan TIDAK
   clickable (daripada link ke halaman yang bakal redirect membingungkan).
   Perlu halaman baru (bukan reuse `/dashboard/sales-visits`) kalau Owner
   mau bisa drill-down riwayat kunjungan siapapun.

### Accepted limitations (dari audit 2026-08-12, tidak berubah, tidak blocking)

7. ~~Dokumen Gate 3D-B3-F5 dan seluruh Gate 3E-D0 (hosted clean-slate) tidak
   pernah di-commit ke git~~ — **DITUTUP 2026-08-17** (`8ec2eb0`), 4 dokumen
   (runbook cleanup, execution SQL, hosted inventory, pre-cleanup snapshot)
   di-commit. Status eksekusi destruktif hosted sekarang bisa diverifikasi
   dari repo. Bukti tambahan 2026-08-14: state hosted saat ini koheren, tenant
   isolation utuh (tidak menjamin runbook dieksekusi, tapi tidak ada bukti
   dampak runtime/security).
8. `docs/product/discovery/AODP_WALUYO_SALESMAN_KPI_FINAL.md` (LOCKED) belum
   diperbarui untuk mencerminkan keputusan Gate 3E-D5-B (EFFECTIVE_CALL tidak
   lagi wajib punya order).
9. Tidak ada `error.tsx` di route Dashboard Owner; beberapa fetcher Owner BI
   tidak fault-isolated (beda dengan kontributor Executive Intelligence).
10. Dead code `getMonthlySalesPerformance` (0 caller, sejenis `pctOa` yang
    sudah dibersihkan Gate Owner BI-E).
11. REVENUE governed belum menyesuaikan credit note/return; NOO belum
    reversal saat order pembuka toko baru dibatalkan — sudah terdokumentasi
    eksplisit sebagai accepted risk di migration header, bukan oversight.
12. Gate 3B/3C/3C-A/3E-D2 (seluruh family) tidak punya dokumen kontrak
    `docs/` sendiri — hanya commit message + komentar migration.
13. **3 mekanisme password recovery aktif bersamaan**: email magic-link
    legacy (`forgot-password-form.tsx`, protected WIP user, live), super-admin
    DB-only reset, dan Telegram self-service. Perlu klarifikasi Founder apakah
    email legacy disengaja tetap hidup atau seharusnya dimatikan.
14. WIP `forgot-password-form.tsx` (protected, belum di-commit) memanggil RPC
    `begin_self_recovery_password_change` yang migration-nya **hanya ada di
    `supabase/migrations_archive/`**, bukan `supabase/migrations/` aktif —
    akan gagal runtime bila di-deploy apa adanya. Belum diperbaiki karena
    berstatus protected WIP milik user.

---

## Log Milestone (terbaru di atas)

Tag `[TERENCANA]`/`[TEMUAN]`/`[REQUEST FOUNDER]` (lihat legenda di
[Sedang Dikerjakan / Berikutnya / Ditunda](#sedang-dikerjakan--berikutnya--ditunda))
berlaku untuk entri **sejak 2026-08-15**. Entri sebelumnya tidak ditandai
retroaktif — bukan oversight, sengaja tidak ditulis ulang massal untuk
menghindari risiko salah kategori pada histori yang sudah locked.

| Tanggal | Gate / Commit | Ringkasan | Status |
|---|---|---|---|
| 2026-08-17 | `[TEMUAN]` **Gate P4.04 — audit visibility untuk override status pengiriman via tombol generik** (`0152422`, migration `20261007000001`) | Checkpoint #3 dari rencana 4-poin. `update_sales_order_status_atomic` (dipanggil tombol "Proses"/"Kirim"/"Tandai Terkirim") tidak pernah cek tabel `deliveries` sebelum izinkan status `delivering`/`delivered` — siapa pun ber-permission `orders.update` bisa "menandai terkirim" tanpa bukti apa pun, tanpa jejak yang membedakannya dari jalur Delivery Verification asli (temuan role-play UAT 2026-08-16). Diinvestigasi lebih dalam: jalur ini TERNYATA sengaja ada sebagai "override manusia yang valid" (komentar eksplisit migration `20260717000001`, `sync_sales_order_delivery_status`) — bukan bug, keputusan desain lama. Karena itu fix TIDAK memblokir jalur override (mengubah itu = keputusan bisnis, bukan teknis) — murni menambah observability: `audit_logs.new_data` sekarang merekam `delivery_verified`/`manual_override` untuk transisi delivering/delivered, logic dihitung identik `sync_sales_order_delivery_status` (dispatched/arrived/fully_received/partially_received/verified utk delivering; SUM `received_quantity` menutup penuh `sales_order_items.quantity` utk delivered) supaya konsisten dengan definisi "delivered" yang sudah locked. Diverifikasi: `supabase db reset` PASS (sempat gagal sekali karena `supabase_kong_AODP` unresponsive — masalah sama yang tercatat kemarin, fix `docker restart supabase_kong_AODP`), RPC dites langsung psql 3 skenario (tanpa evidence → override=true; item belum tertutup penuh → override=true; order tanpa item sama sekali → vacuously verified=true, sama seperti perilaku existing `sync_sales_order_delivery_status`, bukan bug baru). Full test suite: 2564/2565 PASS (1 gagal pra-existing tidak terkait, `telegram-enrollment-control.security.test.ts`, dikonfirmasi ulang lewat isolasi file). **Bonus temuan & fix sambil verifikasi**: `gate-2i2-workspace-containment.test.ts` ternyata GAGAL di `origin/main` (regresi sudah live di hosted) — refactor cetak-batch invoice (commit sebelumnya, `f006868`) memindahkan rendering tabel dari `finance/invoices/page.tsx` ke komponen baru `InvoiceSelectionTable`, assertion lama cuma baca `page.tsx` jadi salah gagal padahal semantiknya (DataTable, bukan `<table>` mentah) tetap benar. Diperbaiki dengan mengecek kedua file, bukan melonggarkan assertion. Sempat ada 1 test lain timeout (`gate-3e-d4-c3...concurrent APPROVE vs REJECT`) saat suite penuh dijalankan bersamaan — dikonfirmasi flaky (resource contention DB lokal saat banyak test paralel), PASS bersih 742ms saat dijalankan sendirian, tidak terkait perubahan ini. | **PASS — LOKAL, terverifikasi psql + full test suite, belum di-push** |
| 2026-08-17 | `[TEMUAN]` **Koreksi: Gate P4.01/P4.02/P4.03 Fase A + document engine print/batch TERNYATA sudah live hosted, bukan "belum di-deploy"** | Checkpoint #2 dari rencana 4-poin (harusnya "push P4.01+P4.02 ke hosted") ternyata sudah tidak perlu — `git log origin/main` menunjukkan commit gate-gate itu (`fd5f410`, `a991806`, `acab3ac`, dst.) sudah ada di `origin/main` (tip `f006868`), dan `vercel inspect` mengonfirmasi deployment production 12 jam lalu persis match commit tsb, alias `aodp-waluyo-demo.vercel.app` aktif, health-check halaman login bersih. Root cause ketidaksesuaian: entri "Sedang Dikerjakan"/Log Milestone sebelumnya ditulis SEBELUM push terjadi dan tidak diupdate retroaktif setelah push (sesuai aturan #545 dokumen ini) — bukan bug produk, murni dokumentasi tracker yang basi. **Pelajaran**: `vercel ls`/`vercel inspect` (CLI sudah terinstall & project linked) harus jadi sumber kebenaran status deploy, bukan asumsi dari catatan tracker lama. | **DIKONFIRMASI LIVE — tidak ada push baru diperlukan untuk P4.01/P4.02** |
| 2026-08-17 | `[TEMUAN]` **Commit 4 dokumen readiness Gate 3D-B3-F5 & 3E-D0 (hosted cleanup)** (`8ec2eb0`) | Founder minta diprioritaskan poin #1 dari rencana checkpoint (docs(readiness) commit). Menutup Backlog #7 (dokumen tereksekusi tapi tidak pernah di-commit) — runbook cleanup, execution SQL, hosted inventory, pre-cleanup snapshot sekarang tercatat di repo, isinya sudah dicek tidak mengandung secret/kredensial. | **DITUTUP — commit lokal, belum di-push** |
| 2026-08-17 | `[TEMUAN]` **Fix bug: ikon amplop/telepon di header cetak pecah ke baris terpisah dari teksnya** (`components/document-engine/print.css`) | Founder laporkan teks email "harusnya disebelah logo amplop" -- ditelusuri dengan scale transform 3x via javascript inspection (bukan asumsi visual), terbukti ikon amplop rendering di baris sendiri, teks email di baris bawahnya (ikon telepon kebetulan tidak kelihatan pecah karena teks nomornya pendek, jadi kelihatan normal walau root cause sama). Root cause: Tailwind preflight men-set `svg { display: block }` secara global di seluruh app -- SVG ikon (`MailIcon`/`PhoneIcon` di `PrintDocumentPanel.tsx`) jadi block-level, memaksa line-break sebelum+sesudahnya, bukan render inline di sebelah teks. Percobaan pertama (`white-space: nowrap` di span) TIDAK memperbaiki -- dibuktikan salah lewat pengukuran `getBoundingClientRect()` sebelum menyimpulkan berhasil (root cause bukan soal wrapping teks). Fix final: `.doc-engine-contact-icon` diberi `display: inline-block` eksplisit, override preflight. Diverifikasi ulang dengan teknik scale-transform+screenshot yang sama -- ikon+teks sekarang sebaris persis seperti referensi Founder. Type-check bersih, tidak ada console error. | **PASS — LOKAL, terverifikasi browser (root cause diverifikasi via DOM measurement, bukan tebakan)** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Identitas company lokal diganti ke data tenant asli PT Sumber Warna Alam Sudiada + logo asli terpasang** (data-only + `apps/web/public/logos/pt-sumber-warna-alam-sudiada.jpeg` baru) | Founder kirim contoh header cetak asli (nama, alamat, email, telepon, logo bulat) dan minta header template dibuat seperti itu -- dikonfirmasi logo filenya memang sudah ada di repo (`docs/document-engine/assets/samples/waluyo/logo-pt-sumber-warna-alam-sudiada.jpeg`, dipakai sebagai fixture test `PhysicalPrintSheet.test.ts` sebelumnya, sekarang datanya sama persis dipakai ke company sungguhan). Header `PrintDocumentPanel.tsx` sendiri TIDAK diubah -- strukturnya sudah persis cocok dengan referensi (logo + nama hijau bold + alamat + email/telepon berikon), yang kurang cuma data company lokal masih placeholder seed ("AODP Dev Distributor") dan `logo_url` NULL. Fix: logo dicopy ke `apps/web/public/logos/` (dari `docs/` yang tidak public-servable) supaya bisa diakses `/logos/...`, lalu `companies` row lokal (`b253dc2a-...`) diupdate `name`/`legal_address`/`contact_email`/`contact_phone`/`logo_url` ke data asli PT Sumber Warna Alam Sudiada (script sekali-pakai, sudah dihapus). Ini konsisten dengan data SWAS (produk+pelanggan) yang sudah diimport sebelumnya ke company yang sama -- sekarang identitas company-nya sendiri juga otentik, bukan cuma isi datanya. Diverifikasi browser lokal: halaman print invoice (`AODPDEV-INV-20260816-000005`) menampilkan logo asli, nama, alamat, email, telepon persis sesuai referensi, tidak ada console error (gambar termuat). **Koreksi (masih sesi sama)**: Founder tunjukkan hasil belum sama persis -- root cause nama company salah ditulis Title Case ("PT Sumber Warna Alam Sudiada") padahal referensi ALL CAPS ("PT SUMBER WARNA ALAM SUDIADA", sama seperti fixture test `PhysicalPrintSheet.test.ts`); email/telepon yang tadinya terlihat bertumpuk 2 baris ternyata cuma artefak viewport screenshot sempit (700px), bukan bug CSS -- di viewport lebar (`display:flex` di `.doc-engine-company-contact`) keduanya sebaris seperti seharusnya. Nama diperbaiki ke ALL CAPS via script sekali-pakai (sudah dihapus), diverifikasi ulang di viewport lebar (1300px) -- sekarang identik dengan referensi. **Belum ada UI upload logo di Settings** (gap pra-existing, sudah tercatat sebelumnya) -- perubahan ini isi langsung ke DB, bukan lewat form. | **PASS — LOKAL, terverifikasi browser (setelah 1 koreksi casing)** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Tombol "Cetak Sekarang" di halaman print invoice (single & batch)** (`components/document-engine/print-now-button.tsx` baru, `finance/invoices/[id]/print/page.tsx`, `finance/invoices/print-batch/page.tsx`) | Founder tanya (murni tanya dulu) kenapa tidak ada tombol print/pengaturan printer dot-matrix di halaman cetak. Dijelaskan: pengaturan printer (driver, continuous-form feed, alignment, port) memang di luar jangkauan web app mana pun -- itu level OS/driver, browser cuma bisa panggil dialog print sistem. Yang realistis ditambahkan cuma shortcut tombol supaya tidak perlu tahu Ctrl+P -- Founder minta ditambahkan. Komponen client kecil `PrintNowButton` (`window.print()`, fixed bottom-right, `print:hidden` supaya tombolnya sendiri tidak ikut tercetak) dipasang di kedua halaman print (single & batch). Diverifikasi browser lokal: tombol muncul di kedua halaman, diklik tidak error di console (dialog print native OS tidak bisa di-screenshot lewat automation, tapi tidak ada exception JS). Type-check bersih. | **PASS — LOKAL, terverifikasi browser** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Cetak Invoice Batch — pilih banyak invoice, cetak sekaligus 1 lembar fisik continuous form** (`lib/finance/print-snapshot.ts` baru, `components/finance/invoice-selection-table.tsx` baru, `finance/invoices/print-batch/page.tsx` baru, `finance/invoices/page.tsx`, `finance/invoices/[id]/print/page.tsx`) | Lanjutan langsung dari penyambungan `PhysicalPrintSheet.tsx` (baris di bawah) -- Founder konfirmasi pola cetak nyata di lapangan adalah **sekaligus/batch**, bukan satu-satu real-time, jadi 2 invoice pendek yang sebelumnya masing-masing membuang panel bawah kosong sekarang bisa berbagi 1 lembar fisik (hemat kertas karbon 3 rangkap). Diaudit dulu: sebelum ini TIDAK ADA UI multi-pilih sama sekali di manapun (daftar invoice cuma tautan "Lihat/Cetak Invoice" satu-satu), jadi ini fitur baru genuinely, bukan sekadar nyambungin gate lama. `buildPrintSheets()` sendiri sudah didesain sejak awal untuk multi-dokumen (sudah punya test "dua transaksi berbeda menempati panel atas dan bawah" + guard `CrossTenantBatchError`), jadi Document Engine TIDAK disentuh sama sekali. Yang dibangun murni lapisan aplikasi baru: (1) `lib/finance/print-snapshot.ts` -- extract `fillMissingIdentities`+`getInvoicePrintViewModel` dari `[id]/print/page.tsx` (sebelumnya private ke file itu) jadi helper dipakai bersama oleh print single & batch, DRY, tidak ada logic baru; (2) `InvoiceSelectionTable` (client component) -- checkbox per baris (desktop table via kolom baru di `DataTable`, mobile via card), "Pilih semua di halaman ini", sticky action bar "N invoice dipilih" + tombol "Cetak Terpilih" (buka tab baru ke `print-batch?ids=...`) -- selection murni state lokal per page-load, sengaja tidak dipersist (scope-nya "pilih-cetak-selesai", bukan draft); (3) `print-batch/page.tsx` -- baca `?ids=`, urutkan invoice berdasar nomor invoice (bukan urutan klik user, supaya batch yang sama selalu hasilkan susunan lembar fisik yang sama persis), invoice yang belum punya `issued_documents` aktif di-skip dengan banner peringatan (bukan menggagalkan seluruh batch). Halaman `[id]/print/page.tsx` (single) direfactor pakai helper yang sama, tidak ada perubahan perilaku. Sempat ketemu 1 masalah infrastruktur SAAT verifikasi (bukan bug kode): Kong gateway lokal (`supabase_kong_AODP`) sempat unresponsive (connection accepted lalu "empty reply", root cause tidak dikonfirmasi -- kemungkinan terkait `supabase_vector_AODP` yang crash-loop bersebelahan) sehingga login browser sempat gagal "Email atau password tidak valid" walau password benar -- diperbaiki dengan `docker restart supabase_kong_AODP` (infra lokal saja, tidak ada data tersentuh), lalu reset password `owner@aodp.test` lewat script sekali-pakai (sudah dihapus) karena tidak yakin password lama sebelum insiden. Diverifikasi end-to-end browser lokal: pilih 2 invoice (`AODPDEV-INV-20260816-000001` & `000002`) di daftar, klik "Cetak Terpilih", 1 lembar fisik tampil dengan invoice 000001 di panel atas + 000002 di panel bawah, urutan & angka benar, server log 200 bersih tanpa error setelah reload. Type-check bersih di seluruh file yang disentuh. | **PASS — LOKAL, terverifikasi browser end-to-end** |
| 2026-08-16 | `[TEMUAN]` **Sambungkan halaman print invoice ke `PhysicalPrintSheet.tsx` (2 panel/lembar, continuous form 3 ply)** (`app/(dashboard)/dashboard/finance/invoices/[id]/print/page.tsx`) | Founder minta ditunjukkan dulu hasil cetak invoice yang sekarang sebelum bahas gap dot-matrix — dikonfirmasi visual browser lokal (1 panel penuh A4-style), lalu ditunjukkan juga bentuk `PhysicalPrintSheet.tsx` (2 panel 5.5in/lembar, sudah lengkap+lulus test sejak sebelumnya tapi TIDAK PERNAH dipanggil dari route app manapun) via render sekali-pakai (script sementara, sudah dihapus) dari 2 invoice asli lokal. Founder konfirmasi eksplisit: printer Pak Waluyo memang **continuous form 3 ply**, jadi gap ini nyata (layout A4 penuh salah kalau dicetak ke kertas roll 5.5in/panel) — bukan cuma gap kalau-kalau. Diminta kerjakan sekarang. Fix: halaman print diganti dari render `PrintDocumentPanel` satuan berurutan (loop `paginatePrintDocument`) jadi `buildPrintSheets([viewModel])` + `<PhysicalPrintSheet sheet={...}>` per lembar fisik — murni penyambungan, TIDAK ada perubahan pada komponen/CSS Document Engine itu sendiri (sudah LOCKED sejak 23 Juli 2026). Untuk 1 invoice yang dicetak sendirian, panel bawah otomatis kosong (`EmptyPrintPanel`, bukan dummy document) sesuai desain yang sudah ada. Field `documentVersion` yang sebelumnya dithread manual dari `docRow.version` dihapus dari pemanggilan (dicek dulu: field itu tidak pernah dirender di `PrintDocumentPanel.tsx` sama sekali, jadi tidak ada regresi tampilan). Diverifikasi browser lokal: invoice `AODPDEV-INV-20260816-000005` (TK YATI) tampil di panel atas, panel bawah kosong bersih, server log bersih setelah HMR recompile (3 request terakhir 200 tanpa error). Batch-print (banyak invoice berbeda mengisi 1 lembar bersama) BUKAN scope perubahan ini — route yang ada memang cetak 1 invoice per panggilan. | **PASS — LOKAL, terverifikasi browser** |
| 2026-08-16 | `[TEMUAN]` **Audit (role-play lokal Tahap 3-6): 3 gap "all-in sales" (order+kirim+tagih) + laporan status Proof Payment & Collection Intelligence** (investigasi, 1 fix kecil dilakukan) | Founder jelaskan konteks bisnis: sebagian distributor punya sales "all-in" (terima order + antar barang + nagih sendiri, kasus Pak Waluyo) berbeda dari yang cuma terima order. Diaudit ke kode, 3 temuan: **(1) FIXED** -- `TELEGRAM_PAIRING_ELIGIBLE_ROLES` (`lib/telegram-enrollment/capability.ts`) tidak menyertakan role `driver`, padahal `docs/architecture/TELEGRAM_SALES_ORDER_ENTRY.md` sudah lama menyatakan driver "memakai mekanisme yang sama persis" dengan sales untuk pairing Telegram -- akibatnya halaman Pengguna tidak pernah menampilkan tombol "Buat tautan Telegram" untuk role driver sama sekali, dan "Assign & Kirim Tugas" di order detail SELALU gagal "Driver ini belum terdaftar di Telegram" tanpa ada jalur perbaikan. Ditambahkan `driver` ke array (TIDAK ditambahkan ke `CAPABILITY_ROLES` manapun -- pairing beda dari capability password-reset/order-intake). Diverifikasi: tombol muncul di halaman Pengguna, test `capability.test.ts` (termasuk test baru: driver eligible pairing TAPI tidak dapat capability apa pun) + `page.security.test.ts` PASS. **(2) DICATAT, belum diputuskan** -- dropdown "Assign driver" (`orders/[id]/page.tsx`) `.filter(role === "driver")` ketat -- sales yang antar order sendiri TIDAK otomatis muncul di situ. AODP sudah mendukung 1 user multi-role (`user_roles` many-to-many), jadi solusi teknisnya kemungkinan besar operasional (tambahkan role `driver` ke akun sales "all-in", bukan bikin akun kedua) -- bukan perubahan kode, tapi belum dieksekusi/diputuskan. **(3) DICATAT, keputusan produk** -- permission `payment.record` (migration `20260829000001`, RPC `record_verified_payment_atomic`) HANYA `owner`/`finance`, eksplisit TIDAK termasuk `sales`/`driver`/`manager`/`admin` (lebih sempit dari pola izin finance lain, sesuai instruksi gate aslinya). Sales "all-in" yang terima cash langsung dari toko TIDAK PUNYA jalur mencatatnya sendiri di sistem manapun (Web maupun Telegram) -- ini genuinely kosong, bukan bug, tapi kontrol internal (siapa boleh catat uang masuk) yang butuh keputusan Founder, bukan diputuskan sepihak. Sambil audit, dilaporkan juga status 2 hal yang ditanya Founder (murni laporan, TIDAK diimplementasikan apa pun): **Proof Pembayaran** (Gate 2D, migration `20260829000001`) -- RPC + UI (`RecordPaymentPanel`) sudah ada, tapi bukti pembayaran cuma 2 text field (jenis bukti + referensi/tautan), **BUKAN widget upload foto/file** (komentar migration eksplisit: "belum ada storage-upload primitive di design system, di luar scope"). **Collection Intelligence** (Gate 2I.2, `/dashboard/finance/collection`) -- promise-to-pay + riwayat aktivitas collection sudah jalan (41 test collection-promise-foundation PASS per audit workflow doc sebelumnya), tapi Business Guard "Collection Risk" (skor risiko piutang macet proaktif) masih kosong sama sekali (baru ada slice #1 discount anomaly) -- Owner masih harus pantau manual, belum ada alert otomatis. | **PASS (fix #1) + 2 TEMUAN dicatat untuk keputusan Founder** |
| 2026-08-16 | `[TEMUAN]` **Fix bug: mengunci periode KPI mematikan seluruh Dashboard Owner + rewire ranking Laporan Sales ke target governed asli** (`lib/dashboard/owner-sales-kpi-performance.ts`, `lib/executive/contributors/flowsales.ts`, `reports/page.tsx`, `reports/[id]/page.tsx`) | Founder benar menegur: sesi sebelumnya sempat menghapus kolom Target/Gap/Pencapaian dari tabel ranking "Performa Sales" karena isinya "—" semua, alih-alih memperbaiki sumbernya. Root cause ganda ditemukan: (1) kolom itu kosong karena dijumlahkan dari `sales_reports.target_revenue` yang MEMANG sengaja 0 sejak Gate P4.03 (tidak ada "target harian") -- padahal target ASLI per-periode sudah ada di `sales_kpi_targets` (diisi via KPI Setup), cuma tidak pernah disambungkan ke halaman ini. (2) Sambil investigasi, ditemukan bug jauh lebih besar: begitu Founder klik "Kunci Periode" (LOCKED) di KPI Setup, `getOwnerSalesKpiPerformance()` (dipakai Dashboard Owner) dan `flowsalesContributor` (Executive Intelligence) query periodenya `.eq("status", "ACTIVE")` -- LOCKED dianggap "tidak ada periode", SELURUH tile governed (Call/EC/Order/Omzet/NOO/Gap) di Dashboard Owner jatuh ke "Data belum cukup", dan **Business Health Score salah tampil 87/100 "Bisnis Sehat"** padahal angka asli 45/100 "Perlu Tindakan Segera" (pencapaian omzet cuma 4%) -- locked SEHARUSNYA cuma berarti "target tidak bisa diedit lagi", BUKAN "sembunyikan datanya dari laporan". Fix: kedua query diganti `.in("status", ["ACTIVE","LOCKED"])` + `.order("end_date", {ascending:false}).limit(1)` supaya tetap ambil periode paling relevan kalau ada lebih dari satu baris non-DRAFT. `findActivePeriod()` (dipakai jalur TULIS -- rekam Call, set target baru) SENGAJA TIDAK ikut diubah, tetap ACTIVE-only -- itu benar, periode terkunci memang seharusnya menolak input baru. Ranking "Performa Sales" di `reports/page.tsx` dirombak: tidak lagi menjumlah dari snapshot `sales_reports` (cuma selengkap laporan yang sempat difile hari itu, bisa understate kalau ada hari bolong), sekarang ditarik langsung dari `getOwnerSalesKpiPerformance()` -- SAMA PERSIS sumbernya dengan Dashboard Owner/KPI Setup, jadi Target/Gap/Pencapaian selalu ada dan tidak pernah beda dari yang Owner lihat di tempat lain. Kolom "OA" di-rename jadi "Order" (lebih jujur, sejak Gate P4.03 memang berisi Order Count bukan Outlet Aktif). Tabel "Laporan Terbaru" (daftar per-hari, terpisah dari ranking) disederhanakan: kolom Gap & Grand Total dihapus -- sebelumnya menampilkan 2 angka Rupiah berbeda (Omzet governed vs Grand Total item-only) tanpa penjelasan, membingungkan. Semua header tabel di 3 halaman Laporan Sales diberi warna (bg-blue-50/text-blue-700) atas permintaan Founder. Diverifikasi browser lokal: Dashboard Owner Business Health kembali benar (45/100), ranking Laporan Sales tampil Target Rp100jt/Gap/Pencapaian per sales sesuai KPI Setup. Test regresi: 14/14 PASS (gate-owner-bi-a/b/c, file yang paling relevan dengan perubahan), full suite diulang sebelum push. | **PASS — LOKAL, bug signifikan tertutup** |
| 2026-08-16 | `[REQUEST FOUNDER]` **KPI Setup: "Hari Kerja" otomatis + fix layout alasan target yang nyasar** (`components/sales-kpi/kpi-setup-view.tsx`) | (1) Field "Hari kerja" di form buat periode KPI dicek dulu ke kode -- ternyata TIDAK dipakai di perhitungan pacing/achievement manapun (`computeAchievementLine` murni pakai `daysBetween` kalender, bukan working_days), cuma disimpan+divalidasi saat periode dibuat. Sesuai arahan Founder ("kalau tidak berdampak, hilangkan saja"): field dihapus dari tampilan, dihitung otomatis di background (hari kalender dikurangi Minggu) sebelum dikirim ke RPC -- tidak ada perubahan DB/RPC. (2) Founder screenshot laporkan kartu tiap Salesman di KPI Setup menampilkan 2 kotak "Alasan perubahan" berturutan di bagian NOO, tanya apakah ada alasan kuat. Ditelusuri ke kode: BUKAN by design -- blok alasan+tombol "Simpan Target" untuk Call/EC (seharusnya menempel di bawah input Call/EC paling atas) salah taruh di paling bawah JSX komponen, setelah blok Order Count/Revenue DAN blok NOO, tanpa label pembeda sehingga terlihat seperti milik NOO. Fix: blok dipindah ke lokasi yang benar (langsung di bawah input Call/EC), pola 3 section (Call+EC / Order Count+Revenue / NOO) sekarang masing-masing konsisten punya 1 alasan+1 tombol miliknya sendiri, tidak ada lagi yang nyasar. Diverifikasi visual browser lokal (Sales Pertama, Salma) -- struktur benar, type-check bersih. | **PASS — LOKAL, terverifikasi visual** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Data operasional lokal: import 142 produk + 291 pelanggan SWAS, 3 Wilayah Penjualan, KPI Setup 3 sales** (data-only, tanpa perubahan kode/migration) | Founder minta data lokal (`AODP Dev Distributor`) diisi lebih realistis pakai data asli tenant Waluyo untuk keperluan demo, sebelum lanjut setting Laporan Sales/KPI. (1) Import via jalur resmi Universal Data Onboarding (`stageUploadedFile`/`validateStagedBatch`/`commitBatch`, sama persis dipanggil `uploadImportFileAction`/`commitImportBatchAction` -- browser tidak bisa drive file upload native jadi dipanggil langsung lewat script service-role, bukan bypass validasi): `DAFTAR ALL ITEM SWAS.xls` (dikonversi ke `.xlsx` dulu, `.xls` lama ditolak sistem) -> 142 produk (`PRODUCT_PRICE`, semua nonaktif karena file sumber tidak punya kolom harga -- perilaku by-design, bukan gagal), `NAMA PELANGGAN SWAS.xlsx` -> 291 pelanggan (`CUSTOMER_PIC`, 0 error/warning, PIC memang opsional penuh untuk import ERP massal). (2) 3 Wilayah Penjualan dibuat + di-assign 1:1 ke Waluyo/Salma/Sales Pertama via RPC resmi (`create_coverage_area`, `assign_salesman_coverage_areas`, actor=Owner asli) -- 292 pelanggan dibagi RANDOM rata (98/97/97) ke ketiga sales (`assigned_sales_id`+`coverage_area_id` diset konsisten), sesuai permintaan eksplisit Founder (bukan dicocokkan ke kota asli toko). (3) Periode KPI "Agustus 2026" dibuat+diaktifkan, 5 target (Call 15/EC 15/Order Count 15/Revenue Rp100jt/NOO 3) diisi utk ketiga sales via RPC resmi `set_sales_kpi_target` (sama dipakai tombol UI) -- angka dipilih CTO untuk konsistensi demo (sama pola dgn target hosted Waluyo sebelumnya), bukan keputusan bisnis final. Semua RPC dipanggil dgn service-role tapi actor_id = user asli (Owner/Admin), bukan bypass permission check di level RPC. Diverifikasi browser (Import Data batch detail, halaman Produk/Pelanggan, Wilayah Penjualan, KPI Setup) -- semua angka cocok. | **PASS — LOKAL SAJA, data-only** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Gate P4.03 — Redesain Laporan Sales Fase A: ringkasan KPI harian otomatis, hapus double-entry** (`lib/sales-reports/{queries,actions,summary}.ts`, `components/sales-reports/sales-report-form.tsx`, `reports/{new,[id],}/page.tsx`, `lib/executive/contributors/flowsales.ts`) | Founder minta gap "Laporan Sales" (sudah diidentifikasi & rencananya diterima sebelumnya, lihat § Ditunda/Berikutnya lama) langsung dikerjakan. Scope Fase A saja (paling kecil & aman): form `reports/new` TIDAK LAGI minta sales ketik ulang `target_oa`/`achieved_oa`/`target_revenue`/`achieved_revenue`/item produk -- SENGAJA TIDAK termasuk 3 kebutuhan tambahan dari voice note Pak Waluyo (jadwal WhatsApp otomatis, field "Tagihan", laporan pagi terpisah), itu masih di "Ditunda" menunggu keputusan Founder. Query baru `getDailyGovernedKpiSummary()` baca `sales_kpi_achievement_events` (ledger yang SAMA dipakai dashboard Owner) di-scope 1 hari, dan `getDailySoldItems()` agregasi `sales_order_items` utk breakdown produk (governed KPI tidak resolusi per-produk). Server (`createSalesReportAction`) TIDAK PERNAH percaya angka dari client -- dihitung ulang dari ledger saat submit, form cuma kirim `area`/`remaining_working_days`/`notes`. Panel "Ringkasan KPI Hari Ini" di form live-refetch (server action `getDailyReportPreviewAction`) tiap tanggal/salesperson diganti -- diverifikasi browser: pilih sales lain langsung update Call/EC/Order/Omzet/NOO + daftar produk terjual sesuai data order sungguhan hari itu. **Tidak ada migration DB** (sesuai rencana awal) -- kolom lama `target_oa`/`achieved_oa`/`target_revenue`/`achieved_revenue` tetap ada, sekarang diisi 0 (target, jujur "tidak ada konsep target harian") dan angka governed asli (achieved) alih-alih diketik manual. Halaman list (`reports/page.tsx`) & ranking bulanan disesuaikan supaya tidak menampilkan badge "100%" palsu saat target=0 (cuma tampil kalau ada laporan lama pre-redesain yang masih bawa target manual asli). Halaman detail (`reports/[id]/page.tsx`) hapus section "Pembanding dari Sales Order" (jadi redundant -- angka achieved SEKARANG MEMANG angka order asli, bukan lagi self-report yang perlu dibandingkan) diganti panel governed KPI yang sama seperti di form, dihitung ulang live dari ledger (append-only, jadi konsisten walau dipanggil ulang kapan saja, termasuk utk laporan lama). **Bonus fix ditemukan sambil verifikasi**: teks placeholder "Ringkasan" (`buildAiSummaryPlaceholder`) awalnya masih klaim "Pencapaian omzet Rp X dari target Rp 0 (100%)... Target omzet sudah tercapai" -- menyesatkan karena target memang sengaja 0. Diganti narasi netral dari angka governed langsung ("N effective call dari M kunjungan, menghasilkan K order senilai Rp X"). Diverifikasi end-to-end browser lokal 2 skenario: sales dengan aktivitas hari itu (order dibuat+dikonfirmasi live saat testing, panel menampilkan Order 3/Omzet Rp1.625.709/NOO 1/2 produk benar) dan sales tanpa aktivitas (semua 0, teks ringkasan tetap jujur, bukan dikarang). `getOrdersSnapshot()` (dead code setelah redesain ini) dihapus. Type-check bersih. **Regresi ditemukan & diperbaiki dari test suite penuh**: percobaan awal mengganti label tile "OA Bulan Ini" di Executive Intelligence (`flowsales.ts`) jadi netral (menghapus "Self-Report — Legacy") menabrak test terkunci `gate-owner-bi-b-governed-kpi-consolidation.integration.test.ts` -- setelah ditelaah ulang, test itu BENAR: kolom `achieved_oa` yang dijumlah tile ini masih tercampur antara laporan BARU (governed, akurat) dan laporan LAMA pre-redesain (self-report bebas, bisa ekstrem seperti skenario test `achieved_oa=500`) -- SUM bulanan tidak bisa membedakan asalnya, jadi label "Legacy" tetap wajib dipertahankan supaya tidak diam-diam dianggap governed. Fix final: label dikembalikan ke "OA Bulan Ini (Self-Report — Legacy)", HANYA bagian tampilan pecahan `X/0` yang diperbaiki (jadi `X` saja, karena target harian memang sengaja 0). Test suite penuh diulang setelah fix: 2563/2564 PASS (1 gagal pra-existing tidak terkait, sama seperti baseline sebelum sesi ini). **Belum ada automated test untuk modul `sales-reports`** (gap pra-existing, bukan baru) -- dicatat sebagai susulan. Sisa scope: Fase B (3 kebutuhan voice note) masih di "Berikutnya". | **PASS — LOKAL, terverifikasi browser + test suite penuh** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Gate P4.02 — payment_terms_days: sambungkan input "Termin Pembayaran" ke form order** (`supabase/migrations/20261006000001_gate_p4_02_payment_terms_days_order_input.sql`, `lib/orders/actions.ts`, `components/orders/order-form.tsx`) | Lanjutan langsung dari temuan audit template invoice (baris di bawah) -- Founder minta gap "Tempo" ditutup sekarang juga. Investigasi lebih dalam: kolom `sales_orders.payment_terms_days` sudah ada sejak migration `20260812000003`, dan seluruh lapisan Document Engine (`issue_invoice_atomic` menulis `snapshot.paymentTermsDays`, `print-view-model.ts` menghitung `dueDateLabel`/"Tempo" darinya) sudah lengkap & benar -- gap SEMPIT-nya cuma satu: tidak ada jalur (UI maupun parameter RPC create/update) untuk MENGISI kolom itu. `confirm_sales_order_atomic` sudah punya parameter `p_payment_terms_days` tapi satu-satunya caller (`orders/actions.ts`) hardcode `null`. Fix murni ADDITIVE, pola identik Gate P4.01: `p_payment_terms_days INTEGER DEFAULT NULL` ditambah ke `create_sales_order_atomic`/`update_sales_order_atomic` (DROP+CREATE eksplisit, bukan overload), field baru "Termin Pembayaran / Tempo (hari, opsional)" di `order-form.tsx` dengan validasi client-side (harus > 0 kalau diisi, cermin CHECK constraint DB), di-thread lewat `OrderFormData`. `confirm_sales_order_atomic` TIDAK disentuh -- parameternya sendiri sudah preserve nilai existing kalau dikirim null saat konfirmasi, jadi nilai yang diisi saat create otomatis terbawa. Diverifikasi end-to-end lokal: order baru `SO-2608-0004` dibuat lewat form dengan Termin 14 hari -> dikonfirmasi ke DB `payment_terms_days=14` tersimpan -> order dikonfirmasi, delivery dibuat via RPC (`create_delivery_atomic` dst., driver akun baru `driver@aodp.test` -- dropdown "Assign driver" di UI Delivery Verification juga sudah menampilkannya, walau assign lewat UI tetap gagal karena "belum terdaftar di Telegram", gap lama yang sudah tercatat, bukan baru) -> `issue_invoice_atomic` -> invoice `AODPDEV-INV-20260816-000002` terbit -> halaman print menampilkan **"Tempo: 30 Agustus 2026 (14 Hari)"** dengan benar. `type-check` bersih dari error terkait perubahan ini (error lain yang muncul di run yang sama sudah pra-existing, tidak tersentuh perubahan ini). Test suite penuh diulang setelah kedua commit sesi ini: 2563/2564 PASS (1 gagal pra-existing tidak terkait, `telegram-enrollment-control.security.test.ts`). | **PASS — LOKAL, terverifikasi end-to-end** |
| 2026-08-16 | `[TEMUAN]` **Audit template invoice: logo tenant + "Pengirim" salah tampil "Owner"** (`scripts/seed-dev.ts`, data-only) | Founder tanya kenapa logo tenant tidak tampil di halaman print invoice lokal dan kenapa kartu "Pengirim" menampilkan "Owner AODP". Dicek ke kode: `PrintDocumentPanel.tsx` sudah benar (fallback ke tanpa-logo kalau `companies.logo_url` NULL) -- gap murni data-seed lokal (`scripts/seed-dev.ts` tidak pernah mengisi `logo_url`), bukan bug dan bukan spesifik demo-lokal vs hosted. Belum ada UI upload logo di Settings (baru bisa isi langsung ke DB) -- dicatat sebagai gap terpisah, belum masuk scope perbaikan. "Pengirim" = "Owner AODP" dikonfirmasi ke DB: delivery `SO-2608-0002` (`aea02467-...`) `assigned_driver_id`-nya memang akun Owner -- sisa dari pembuktian RPC Tahap 3-6 sesi lalu yang terpaksa pakai akun Owner sebagai stand-in karena belum ada akun berrole `driver` di seed lokal (role `driver` sendiri sudah ada resmi di tabel `roles`). Perbaikan: tambah 4 user baru di `scripts/seed-dev.ts` (`driver@aodp.test`, `salma@aodp.test`, `waluyo@aodp.test`, `admin@aodp.test`, semua password `Aodp2026!`) lalu delivery direassign ke akun driver baru via service-role, dikonfirmasi visual browser lokal ("PENGIRIM" -> "Kurir Pertama"). **Bonus fix sambil mengerjakan**: `scripts/seed-dev.ts` ternyata sudah gagal total di awal sesi ini (2 bug pra-existing belum ke-commit dari sesi sebelumnya) -- (1) lookup user by email pakai `nextPage`/`lastPage` dari GoTrue lokal yang saling kontradiktif akibat 173 user leftover integration test, diganti hitung berdasar panjang hasil aktual; (2) `upsert` role owner menabrak trigger `enforce_single_owner_per_company` (Gate 3D-B1) yang fire di setiap `UPDATE OF role_id/company_id` walau nilai identik, diganti cek-dulu-baru-insert. Tanpa 2 fix ini script seed tidak bisa jalan sama sekali untuk siapa pun. Commit `4404ceb`. | **PASS — LOKAL SAJA (commit dev-tooling, tidak di-deploy)** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Push 13 commit ke `origin/main` + deploy hosted** (`f13d594..429f63f`, deployment `dpl_CaLp9UDSxavqNNPZoKZyTeQWDjW7`) | Founder approve push setelah fix bug 500 (root cause RLS-blind `generateOrderNumber()`) selesai diverifikasi lokal. Isi: fix bug 500 order creation, Gate P4.01 (`requested_delivery_date` utk AI Dispatch Planner + konsolidasi field tanggal), fix role-aware "Sales yang Menangani" + query roles yang lama rusak, fix listbox pencarian pelanggan, halaman baru Lihat/Cetak Invoice, hapus menu sidebar "Collection". Dicek via `vercel ls`/`vercel inspect --wait`: build production baru selesai **Ready**, ter-alias ke `aodp-waluyo-demo.vercel.app`. Verifikasi fungsional di hosted (reproduksi skenario order yang dulu gagal 500) belum dilakukan sesi ini — menunggu Founder login manual. | **PASS — DEPLOY READY, verifikasi fungsional hosted menyusul** |
| 2026-08-16 | `[REQUEST FOUNDER]` **`docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md` baru — peta order-to-cash per tahap + status PASS/gap** | Founder minta workflow rinci dari sales buat order sampai tagihan lunas, supaya bisa melacak tahap mana yang belum PASS. Diaudit langsung ke kode (3 Explore agent paralel: order→dispatch, invoice→pelunasan, inventaris gate existing) — bukan menyalin asumsi dari dokumen lama. 9 tahap dipetakan (order dibuat → harga khusus → konfirmasi → dispatch → delivery verification → invoice → payment/collection → lunas → retur/cancel), masing-masing dengan mekanisme RPC/tabel, status, dan gate reference. Ditemukan 1 ketidaksesuaian: Constitution menyebut Delivery Verification "next target" tapi ternyata gate-nya sudah closed 2026-07-16 (dikonfirmasi baca langsung `AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`) — Constitution-nya yang belum update bahasa, bukan gap nyata. 5 gap nyata teridentifikasi & di-rollup di bagian atas dokumen: Owner Approval Inbox UI belum ada, Dispatch Planner belum punya gate readiness resmi, Business Guard Collection Risk belum diimplementasi (baru slice discount anomaly), REVENUE governed belum reconcile credit note/return (sudah ada di Backlog #11), NOO belum reversal saat toko pembuka dibatalkan (sudah ada di Backlog #6b). Ditautkan dari `CLAUDE.md` § Sumber Kebenaran dan `TRACKER.md` § Referensi. | **SELESAI** |
| 2026-08-15 | `[REQUEST FOUNDER]` **Restrukturisasi TRACKER.md + `docs/development/WORKFLOW.md` baru** | Founder menilai pengerjaan project "lompat-lompat dan bolong-bolong". Root cause dikonfirmasi lewat audit tracker: tidak ada bagian prospektif (cuma log retrospektif), banyak temuan besar tidak sengaja bukan dari rencana, skema Gate ID sudah terlalu dalam, dokumen gate kadang tidak ke-commit, keputusan pending tidak punya penanda. Perbaikan: tambah section Sedang Dikerjakan/Berikutnya/Ditunda, tagging asal kerja, dokumentasi eksplisit branch production (`main`) setelah insiden salah push ke branch demo hari ini, dan dokumen alur kerja baru `docs/development/WORKFLOW.md`. | **SELESAI** |
| 2026-08-15 | `[REQUEST FOUNDER]` **Dashboard Owner: badge insight/tindakan jadi clickable + Aksi Cepat diganti sesuai scope owner** (`apps/web/src/app/(dashboard)/dashboard/owner/page.tsx`, commit `7fc7875`) | Founder laporkan 2 masalah dari screenshot: (1) badge "Perlu Tindakan Segera" tidak ada aksi — diperbaiki jadi link yang scroll ke daftar Tindakan Direkomendasikan. (2) Aksi Cepat di hero (Laporan Sales/Buat Order/Pelanggan Baru/Import Data) semuanya tugas data-entry sales/admin, bukan tugas owner — bertentangan dengan prinsip Owner First (Constitution §10, "AI merekomendasikan, owner memutuskan"). Diganti ke Risk Alert/Kelola Pengguna/Laporan Sales (lihat)/Pengaturan, dikonfirmasi Founder via pilihan eksplisit sebelum eksekusi. Sempat salah push ke branch `aodp-architecture-demo-v0.1` (dikira branch demo) — ternyata cuma bikin Preview deployment; production Vercel ternyata dari `main`, dikonfirmasi lewat GitHub Deployments API, lalu di-push ulang ke `main` dan dikonfirmasi live. | **PASS — LIVE DI HOSTED** |
| 2026-08-15 | **KPI Salesman UI: kartu achievement berwarna penuh + clickable** (`apps/web/src/components/sales-kpi/kpi-achievement-view.tsx`) | Permintaan Founder atas screenshot dashboard KPI Salma: warna status (Tertinggal/Sesuai Target/Di Atas Target) sebelumnya cuma di badge kecil pojok kartu, dan kartu tidak bisa diklik. Perbaikan: background+border seluruh kartu sekarang ikut warna pacing status (amber/hijau/biru/abu2), progress bar ikut tone yang sama. Order Count & Revenue jadi link ke `/dashboard/orders` (filter sales+status=confirmed+rentang tanggal periode aktif), NOO jadi link ke `/dashboard/customers` (filter sales) -- keduanya reuse filter query param yang sudah ada di halaman itu, tanpa halaman baru. Call/Effective Call HANYA diberi link ke `/dashboard/sales-visits` saat user melihat achievement dirinya sendiri (halaman itu role-gated khusus sales, self-only) -- saat Owner/Manager melihat achievement salesman lain, dua kartu itu sengaja TIDAK diberi link (tidak ada halaman aman utk drill-down lintas-salesman saat ini, daripada silent-redirect yang membingungkan). Diverifikasi visual di browser lokal dgn data KPI fiktif (target+order dibuat via RPC yg sama seperti produksi): warna kartu sesuai status dikonfirmasi lewat computed style, link Order Count/Revenue/NOO diklik dan berhasil navigasi+filter dengan benar. Lint bersih. Push `a4d809d..7cf598c`, auto-deploy Vercel commit `7cf598c` confirmed Ready ("Compiled successfully"). Tidak ada migration (murni UI). | **PASS — LIVE DI HOSTED** |
| 2026-08-15 | **Data backfill hosted: 5 kredit NOO Salma yang hilang akibat timing deploy trigger** (data-only, tanpa migration/code change) | Temuan (dicek atas pertanyaan Founder "apa cara dapat achievement NOO"): akun sales nyata "Salma" (tenant PT Sumber Warna Alam Sudiada) punya 5 toko dengan order pertama sudah `confirmed` (6 Agustus) dan `ORDER_COUNT`/`REVENUE` sudah ter-kredit benar, tapi `NOO = 0` utk semuanya. Root cause dikonfirmasi lewat live-test langsung ke hosted: trigger `credit_noo_for_sales_order` (migration `20260930000001`) berfungsi normal HARI INI (toko+order baru fiktif langsung ter-kredit) -- gap murni historis: trigger di-deploy ke hosted SETELAH 5 order pertama Salma itu confirmed, dan trigger tidak retroaktif + tidak bisa re-fire (constraint "1x NOO seumur hidup per customer" sudah "kehabisan jatah" di order pertama yang lolos). Temuan kedua: target KPI yang diisi Founder minggu lalu (Call/EC/Order Count 15, Revenue 100jt, NOO 3) ternyata masuk ke akun **"Waluyo"** (sales terpisah, dikonfirmasi Founder itu memang benar akun sales Pak Waluyo sendiri) -- BUKAN ke akun Salma, yang justru nyata closing order dan sampai saat ini 0 dari 5 KPI code py target. Backfill NOO disetujui Founder (approve eksplisit via AskUserQuestion): insert 5 baris `NOO CREDITED` lewat service_role, bentuk baris identik output trigger asli (`idempotency_key = noo:<customer_id>`, `source_type=SALES_ORDER`, `order_id`/`business_date` merefer order asli), didahului pre-flight check per baris (order status confirmed, sales_id=Salma, benar order PERTAMA customer itu -- tidak ada confirmed order lain lebih awal, belum ada baris NOO existing) supaya tidak mungkin dobel-kredit atau salah order. 5/5 berhasil, diverifikasi ulang query fresh setelah insert. Susulan: Founder minta target Salma disamakan dengan Waluyo -- 5 target (Call 15, Effective Call 15, Order Count 15, Revenue 100jt, NOO 3) diisi via `set_sales_kpi_target` RPC, `kpi_definition_id` per baris dikonfirmasi identik dengan milik Waluyo (apples-to-apples), semua `result_outcome: created`. | **PASS — SELESAI (backfill NOO + target Salma lengkap)** |
| 2026-08-15 | **Fraud-guard "Daftar Toko": satukan jalur Web & Telegram + foto/GPS opsional** (`supabase/migrations/20261004000001_gate_store_photo_gps_web.sql`, `lib/customer-pic/*`, `components/customer-pic/add-store-form.tsx`) | Temuan: tombol "Tambah Pelanggan" di Web selama ini `.insert()` langsung ke `customers` -- TANPA deteksi duplikat toko, TANPA PIC, TANPA GPS -- padahal RPC lengkap (`create_store_with_pic`, deteksi duplikat, dipakai Telegram) sudah ada tapi tidak pernah disambungkan ke UI manapun (`createStoreAction` dead code). Perbaikan: form Web sekarang pakai RPC yang sama (source `ADMIN_DASHBOARD`, sudah didukung sejak awal). Tambahan murni ADDITIVE (2 param baru DEFAULT NULL di akhir signature, pola identik penambahan email sebelumnya) -- PIC nama+telepon TETAP wajib (keputusan Pak Waluyo, tidak diubah), foto depan toko/foto PIC/GPS SEMUA opsional (toko CASH tidak diribetkan). Infrastruktur upload foto (bucket Storage `store-photos`, RLS tenant-scoped) dibangun baru -- sebelumnya tidak ada di manapun di sistem. Diverifikasi lokal: skenario CASH tanpa foto/GPS PASS, deteksi duplikat PASS (toko sama persis ditolak dengan pesan jelas), regresi jalur Telegram PASS (dipanggil persis gaya lama tanpa param foto, hasil identik `created`, kolom foto default NULL). Build+lint+90 test existing PASS. Hosted: migration `20261004000001` di-apply via `supabase db push --linked` (Local=Remote terkonfirmasi), regresi jalur Telegram diulang langsung ke hosted DB (param gaya lama, hasil `created`, kolom foto NULL) PASS, deploy Vercel commit `5155b5f` confirmed Ready ("Compiled successfully"). Sisa data uji coba throwaway (lokal "Toko Cash Cepat UAT", hosted "Hosted Regression hosted-regr-*") dibiarkan -- terblokir trigger immutable `customer_pic_history`, tidak mengganggu tenant nyata. Susulan (pertanyaan Founder): dites eksplisit end-to-end lokal apakah toko baru lewat form ini ikut mengkredit KPI NOO -- toko dibuat via `create_store_with_pic` (RPC persis dipakai form) -> NOO events = 0 (buka toko saja belum kredit, sesuai definisi Pak Waluyo "buka DAN order"), lalu order pertama toko itu di-confirm -> NOO ter-CREDITED tepat 1x dengan order_id/salesperson_id yang benar. Trigger `credit_noo_for_sales_order` hidup di tabel `sales_orders` (independen dari cara toko dibuat) sehingga otomatis berlaku utk toko dari jalur Web baru maupun Telegram tanpa perubahan tambahan -- 13 test regresi NOO existing tetap PASS (trigger tidak tersentuh migrasi ini). | **PASS — OFFICIALLY LOCKED (hosted)** |
| 2026-08-14 | **Business Guard AI — slice #1: Sales Risk / Discount Anomaly Indicator** (`apps/web/src/lib/business-guard/`) | Vertical slice pertama modul Business Guard AI (sebelumnya 100% placeholder). Rule-based (bukan LLM, konsisten pola `churn-prediction.ts` & keputusan Pak Waluyo soal deteksi duplikat toko), baca `special_price_approval_requests`/`lines` (read-only, tidak ubah RPC/RLS D6-A/D6-B). 4 sinyal: volume pengajuan vs rata-rata sales lain, tingkat penolakan Owner, kedalaman diskon vs rata-rata, eskalasi 30 hari terakhir. Live di `/dashboard/risk`, akses tetap owner/manager/super_admin saja (guard existing tidak diubah). 9/9 unit test PASS, lint bersih, build PASS, diverifikasi manual di browser lokal dengan data real (1 sales, 1 pengajuan, dihitung benar). Push `a3cfe1e..1e75792` fast-forward, auto-deploy Vercel `aodp-waluyo-demo` commit `1e75792` confirmed Ready ("Compiled successfully"), tidak ada migration (murni fitur baca data existing). | **PASS — LIVE DI HOSTED** |
| 2026-08-14 | KPI Target Waluyo dilengkapi (hosted, data) | Tenant real "PT Sumber Warna Alam Sudiada", periode Agustus 2026 (ACTIVE), sebelumnya cuma 2/5 KPI governed punya target (Call, Effective Call) — Order Count, Revenue, NOO kosong sehingga tile-nya tampil "Data belum cukup" di Dashboard Owner (bukan bug kode, murni data belum diisi). Diisi via RPC resmi `set_sales_kpi_target` (RPC sama yang dipakai UI KPI Setup, bukan tulis langsung ke tabel), actor=Owner asli: Order Count=15, Revenue=Rp100.000.000, NOO=3 toko. | **PASS** — 5/5 KPI governed sekarang punya target aktif |
| 2026-08-14 | CTO Audit — status project & gap review | Audit menyeluruh state aktual (bukan cuma baca catatan lama): (1) dikonfirmasi WhatsApp AI & Business Guard AI belum diimplementasi sama sekali, masih placeholder "Segera Hadir"; (2) ditemukan WIP `forgot-password-form.tsx` (protected, belum di-commit) memanggil RPC `begin_self_recovery_password_change` yang migration-nya cuma ada di `supabase/migrations_archive/` — akan error runtime kalau di-deploy apa adanya, perlu keputusan Founder (lanjutkan/batalkan); (3) menemukan gap KPI Waluyo di atas lewat pengecekan langsung ke hosted, bukan cuma grep kode. | **AUDIT SELESAI, temuan didokumentasikan** |
| 2026-08-14 | Governance — Role Split diubah (`CLAUDE.md`) | Keputusan Founder: Claude Code menggantikan ChatGPT sebagai CTO+PM (selain tetap Senior Programmer). Claude Code memutuskan sendiri hal teknis/arsitektur (didokumentasikan, bukan diminta approval per keputusan); arah produk/bisnis tetap diajukan ke Founder dulu. | **BERLAKU** |
| 2026-08-14 | **Phase 3 Final Hosted Closeout** (`docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`) | Audit menyeluruh seluruh gate wajib Phase 3 + deploy migration D6-A ke hosted (`supabase db push`) + 5 skenario UAT hosted (browser + RPC boundary sesi nyata) membuktikan enforcement harga khusus aktif live di hosted, bukan cuma lokal. 3 catatan residual UAT + residual gate-level lain diputuskan satu per satu — seluruhnya ACCEPTED LIMITATION, tidak ada BLOCKING. | **PHASE 3: 100% OFFICIALLY LOCKED (PASS WITH ACCEPTED LIMITATIONS)** |
| 2026-08-13 | Phase 3 — Hosted Deploy & UAT Ulang Enforcement Harga Khusus | Terapkan migration `20261003000001` (D6-A) ke Supabase hosted `AODP-Waluyo-Demo` (sebelumnya belum diterapkan — blocker P0 nyata). 5 skenario UAT di tenant fixture terisolasi: harga normal PASS, harga khusus tanpa approval DITOLAK fail-closed, proposal via UI D6-B PASS, otorisasi/tenant isolation PASS (level UI dan RPC), approve/reject via RPC existing (bukan UI baru) PASS. | **PASS** — blocker P0 tertutup, dibuktikan hidup di hosted |
| 2026-08-13 | Closeout Gate 3E-D6-B (`60e2d9e` + `78b7e76`, push fast-forward ke `origin/main`) | Audit ulang commit (scope/security/authority boundary/test 22/22/lint) + audit stacked commit `78b7e76` (TRACKER.md, documentation-only, tidak overclaim status) → push `ff74a2e..78b7e76` fast-forward, `HEAD == origin/main`, ahead/behind 0/0, protected WIP byte-identical. | **OFFICIALLY LOCKED** |
| 2026-08-13 | Gate 3E-D6-B (`60e2d9e`) | UI Sales "Ajukan Harga Khusus" di `/dashboard/orders/[id]`, memanggil RPC existing `submit_special_price_proposal_atomic` (session-scoped client, auth.uid()-only). Verifikasi browser end-to-end: submit → status `pending_owner_approval`, badge & panel status tampil benar, tombol hilang saat PENDING, Owner tidak melihat tombol approve/reject. | PASS (local) — closeout/lock lihat baris di atas |
| 2026-08-12 | Gate 3E-D6-A (`ff74a2e`) | `confirm_sales_order_atomic` sekarang selalu re-evaluasi harga item saat ini vs master price/kebijakan diskon sebelum izinkan `confirmed`, menutup kasus "tidak pernah mengajukan proposal" dan "approval partial-coverage". RLS `sales_orders` menutup direct-write ke `confirmed`. | **PASS** (menutup P0 #1) |
| 2026-08-12 | Audit closeout Phase 3 (`b8051e8`) | Full audit read-only + 1 skenario UAT lokal live-reproduce. Ditemukan 2 gap P0 (lihat Backlog), 8 gap P1/P2. `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md`. | **BLOCKED** |
| 2026-08-12 | Gate Owner BI-E (`b1b396e`) | Hapus dead code `pctOa` dari kontributor FlowSales dashboard. | PASS |
| 2026-08-11/12 | Gate Owner BI-A/B/C (`03113fa`, `cb6e3af`, `ba8959f`) | Governed REVENUE + rolling window; konsolidasi 5 KPI governed di Owner BI; drilldown Sales Performance per-salesperson. | PASS |
| 2026-08-10 | Gate 3E-D5-C (`c06f12c`) | Wiring KPI Foundation ke UI Owner (KPI Setup). | PASS |
| s.d. 2026-08-10 | Gate 3A → 3E-D5-B-H-R1 (35 gate) | Lihat ringkasan lengkap di tabel scorecard `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md` §4 — mencakup role/permission matrix, onboarding/provisioning, password recovery, boundary mutasi order/item, special-price approval schema+RPC (3E-D4-C1–C7), governed NOO, Kunjungan Sales web. | Beragam (mayoritas PASS, 4 PARTIAL selain P0 di atas) |

**Sebelum Gate 3A** (Phase 0–2, baseline fork s.d. awal Phase 3): fork dari
FlowSalesAI Beta v1.0 RC, Product Constitution v1.0/v1.1, Executive
Intelligence command center, AI Dispatch Planner, delivery verification,
owner-control (audit log, coverage area, salesman activation), Finance
Operations Workspace lengkap (invoice, collection, credit, return,
cancellation — Gate 2I.x), Sales KPI foundation, n8n automation, Business
Document Engine, Telegram salesman enrollment, distributor onboarding &
import. Tidak direkonstruksi ulang di sini — lihat `git log` (commit sebelum
`50b8cab`) untuk detail per-commit bila diperlukan.

---

## Referensi Dokumen Penting

- **Alur kerja (dari ide sampai selesai)**: `docs/development/WORKFLOW.md`
- **Workflow order-to-cash + status PASS/gap per tahap (sales order sampai
  tagihan lunas)**: `docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md`
- Konstitusi produk: `docs/product/AODP_PRODUCT_CONSTITUTION.md`
- Scope MVP: `docs/product/01_PRD.md`
- Arsitektur teknis: `docs/architecture/02_TECH_ARCHITECTURE.md`
- Spec per modul: `docs/product/modules/*.md`
- Audit closeout Phase 3 historis (2026-08-12, RESULT: BLOCKED — status
  historis, tidak diubah): `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md`
- **Closeout final Phase 3 (2026-08-14, 100% OFFICIALLY LOCKED — rujukan
  status terkini)**: `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`
- Sprint plan awal: `docs/development/sprints/*.md`
- Aturan kerja Claude Code: `CLAUDE.md`
