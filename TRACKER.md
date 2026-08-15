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
| HEAD | `67e555d` (dokumen workflow order-to-cash) |
| Deploy pipeline | **Production Vercel (`aodp-waluyo-demo.vercel.app`) auto-deploy dari branch `main`.** Branch lain (`aodp-architecture-demo-v0.1`, dst.) hanya menghasilkan **Preview deployment** terpisah, TIDAK mengupdate domain demo — dikonfirmasi ulang 2026-08-15 lewat GitHub Deployments API setelah salah asumsi sempat terjadi. `aodp-architecture-demo-v0.1` tetap dipakai sebagai target branch untuk PR (CLAUDE.md), bukan branch deploy. |
| Status Phase 3 | **100% — OFFICIALLY LOCKED (PASS WITH ACCEPTED LIMITATIONS)** — lihat `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`. Blocker P0 (enforcement harga khusus) tertutup penuh & diverifikasi hidup di hosted lewat 5 skenario UAT (2026-08-13/14). |
| Deployment | Vercel `aodp-waluyo-demo` menjalankan commit `7fc7875` (production, dikonfirmasi via GitHub Deployments API 2026-08-15). Migration `20261003000001` (D6-A) sudah diterapkan ke Supabase hosted `AODP-Waluyo-Demo`. `.env.local` → Supabase lokal (`127.0.0.1`) untuk dev; `.env.demo.local` → hosted demo (kredensial demo di file itu **basi**, lihat Backlog) |
| Full LOCK Phase 3 | **Sudah** — lihat closeout final. Owner Approval Inbox UI TETAP belum ada (bukan blocker Phase 3, gate baru terpisah untuk next workstream) |
| Governance | Sejak 2026-08-14: **Claude Code = CTO + Senior Programmer AODP** (menggantikan ChatGPT sebagai CTO+PM). Keputusan teknis/arsitektur diputuskan langsung oleh Claude Code (didokumentasikan di sini/commit message); keputusan arah produk/bisnis tetap diajukan ke Founder dulu. Detail: `CLAUDE.md` §Role Split. |
| Data Operasional (tenant Waluyo, hosted) | KPI Setup lengkap — 5/5 KPI governed punya target aktif periode Agustus 2026 (Call 15, Effective Call 15, Order Count 15, Revenue Rp100jt, NOO 3 toko). Dashboard Owner sekarang menampilkan progres real untuk semuanya, bukan lagi "Data belum cukup". |

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

_(kosong — isi saat mulai kerja, pindahkan ke Log Milestone saat selesai)_

### Berikutnya (urutan prioritas, atas = duluan)

1. `[REQUEST FOUNDER]` **Role-play UAT order-to-cash end-to-end** — Claude Code
   jalankan siklus penuh sebagai role `sales` sesuai
   `docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md` (order → harga khusus bila
   perlu → konfirmasi → dispatch → delivery verification → invoice →
   pembayaran → lunas) sambil Founder mengamati. Founder bisa
   interupsi/bertanya kapan saja — **saat interupsi: stop dulu, jawab,
   catat di tracker, JANGAN lanjut eksekusi sebelum perintah eksplisit
   Founder.**
   - Environment: **hosted demo** `aodp-waluyo-demo.vercel.app` (data tenant
     nyata PT Sumber Warna Alam Sudiada — order/invoice yang dibuat akan
     nambah data sungguhan di situ, bukan data seed sekali-pakai)
   - Cara amati: **Browser pane** (panel bawaan app Claude Code) — panel ini
     harus aktif/terlihat di sisi Founder supaya screenshot/compositing
     jalan (sempat gagal di sesi sebelumnya saat panel tidak terbuka)
   - **Login dilakukan Founder sendiri** (bukan Claude Code) — Founder yang
     masuk ke akun `sales` di tab Browser pane itu, baru Claude Code
     melanjutkan aksi dari sesi yang sudah login
   - Belum mulai — menunggu Founder membuka session & login

### Ditunda — menunggu keputusan Founder

| Item | Tag | Sejak | Konteks |
|---|---|---|---|
| NOO tidak punya mekanisme reversal saat order pembuka toko dibatalkan | `[TEMUAN]` | 2026-08-14 | Menyentuh gate LOCKED 3E-D5-A + definisi bisnis KPI. Detail: Backlog #6b |
| 3 mekanisme password recovery aktif bersamaan (email legacy, super-admin DB-only, Telegram self-service) — email legacy disengaja atau harus dimatikan? | `[TEMUAN]` | 2026-08-14 | Detail: Backlog #13 |
| WIP `forgot-password-form.tsx` memanggil RPC yang migration-nya cuma ada di `migrations_archive/` — akan gagal runtime bila dideploy apa adanya | `[TEMUAN]` | 2026-08-14 | Protected WIP milik Founder, belum diperbaiki karena statusnya. Detail: Backlog #14 |
| Owner Approval Inbox UI (proposal harga khusus) | `[TERENCANA]` | 2026-08-14 | RPC sudah ada & teruji (`decide_special_price_proposal_atomic`), tinggal UI. Detail: Backlog #3 |
| Halaman drill-down Call/Effective Call lintas-salesman untuk Owner/Manager | `[TEMUAN]` | 2026-08-15 | Detail: Backlog #7 |

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

7. Dokumen Gate 3D-B3-F5 dan seluruh Gate 3E-D0 (hosted clean-slate) tidak
   pernah di-commit ke git; status eksekusi destruktif di hosted **tidak
   dapat diverifikasi** dari repo. Perlu konfirmasi Founder (akses Studio
   hosted). Bukti tambahan 2026-08-14: state hosted saat ini koheren, tenant
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
