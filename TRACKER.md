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

**Catatan 2026-08-18**: dokumen ini di-**compact** atas permintaan Founder
(hemat token) — entri Log Milestone yang sudah OFFICIALLY PASS/LOCKED
dipadatkan jadi 1-2 kalimat (fakta inti: gate ID/commit/tanggal/status
dipertahankan penuh, narasi debugging/verifikasi panjang dihapus). Detail
penuh versi sebelum kompaksi tetap ada di `git log -p` untuk file ini bila
suatu saat dibutuhkan kembali. Section prospektif (Sedang Dikerjakan/
Berikutnya/Ditunda) TIDAK ikut dipadatkan — masih dipertahankan detail
penuh karena masih operasional.

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
   di luar rencana berjalan). Ringkasan Log Milestone cukup 1-2 kalimat
   padat (apa + kenapa + status) — bukan narasi debugging lengkap.
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
| Tanggal update terakhir | 2026-08-19 |
| Branch | `main` |
| HEAD | `8432a43` — **sinkron penuh dengan `origin/main`** (0 ahead/behind). Mencakup seluruh gate s.d. Risk Alert List gabungan (Business Guard Collection Risk 4 milestone, Sales Risk → Executive Intelligence, PR data toko kredit, Gate P4.08, Owner Approval Inbox, dst.). Vercel production **Ready**, health-check bersih. |
| Deploy pipeline | **Production Vercel (`aodp-waluyo-demo.vercel.app`) auto-deploy dari branch `main`.** Branch lain hanya menghasilkan Preview deployment terpisah. `aodp-architecture-demo-v0.1` tetap target branch PR (CLAUDE.md), bukan branch deploy. **Vercel CLI terinstall & linked** — `vercel ls`/`vercel inspect` sumber kebenaran status deploy, jangan asumsi dari tanggal tracker. **PENTING**: `git push` KODE tidak menerapkan migration ke hosted — 2 langkah TERPISAH wajib manual: `git push` lalu `npx supabase db push` (project linked `mcbwgvtkhykrrtvbpeys`) SETIAP kali ada file baru di `supabase/migrations/`, cek dulu `npx supabase migration list` (Remote kosong = belum diterapkan). Insiden 2026-08-18: 6 migration sempat 3 hari tidak ter-apply ke hosted tanpa terdeteksi — pelajaran ini alasan aturan di atas. |
| Status Phase 3 | **100% OFFICIALLY LOCKED (PASS WITH ACCEPTED LIMITATIONS)** — `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`. |
| Governance | Sejak 2026-08-14: **Claude Code = CTO + Senior Programmer AODP**. Keputusan teknis/arsitektur diputuskan langsung (didokumentasikan di sini/commit message); arah produk/bisnis tetap diajukan ke Founder dulu. Detail: `CLAUDE.md` §Role Split. |
| Data Operasional (tenant Waluyo, hosted) | KPI Setup lengkap — 5/5 KPI governed punya target aktif periode Agustus 2026 (Call 15, Effective Call 15, Order Count 15, Revenue Rp100jt, NOO 3 toko). |

---

## Catatan Lingkungan Kerja (evergreen — dipertahankan lintas sesi)

- Docker Desktop harus jalan dulu sebelum `supabase start`/`db reset` bisa
  connect.
- Port 3000 bisa bentrok dengan sesi chat lain — `.claude/launch.json`
  sudah diset `"autoPort": true` untuk `aodp-web`.
- Seed lokal: `pnpm seed:dev` → `owner@aodp.test` / `sales@aodp.test` /
  `salma@aodp.test` / `waluyo@aodp.test` / `driver@aodp.test` /
  `admin@aodp.test`, password `Aodp2026!` (login manual, tombol "🧪 Masuk
  Demo" beda akun).
- **Vercel CLI terpasang & terautentikasi** (`.vercel/` linked ke project
  `aodp-waluyo-demo`) — `vercel logs <deployment-url>` cuma live-snapshot
  (reproduksi errornya dulu, baru panggil).
- Login ke hosted demo sebagai `slamatwaluyo@gmail.com` (akun sales asli
  Pak Waluyo) **wajib dilakukan Founder sendiri** — Claude Code tidak
  pernah pegang passwordnya.
- Infra lokal kadang flaky: Kong gateway (`supabase_kong_AODP`) atau
  container `supabase_vector_AODP` sesekali unresponsive/crash-loop
  bersamaan — fix `docker restart supabase_kong_AODP` (kadang perlu +
  `supabase_vector_AODP` juga). Kalau browser tool melaporkan konten
  kosong/`Viewport: 0x0` tapi server log menunjukkan response 200 normal,
  itu artefak tooling (`get_page_text`/innerText gagal ekstrak saat
  viewport 0x0) — pakai `read_page` (accessibility tree) untuk verifikasi
  ulang sebelum menyimpulkan ada bug.
- Peta lengkap order-to-cash per tahap: `docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md`
  (belum diupdate merefleksikan gate-gate terbaru — lihat Backlog).
- **RESOLVED (2026-08-19)**: Node.js lokal (`v26.3.0`) sempat
  **segfault/access violation** (2026-08-18) saat load bundle CJS besar
  (`vitest`, `tsc`, `next dev` semua kena) — **hilang total setelah restart
  PC**, dikonfirmasi ulang lewat Gate P4.09 (test suite 25/25 PASS, tsc
  bersih, dev server + browser normal). Root cause pasti tidak diketahui
  (state proses/memory yang corrupt, bukan bug permanen kode/instalasi) --
  dicatat di sini murni sebagai jejak kalau gejala serupa muncul lagi:
  **coba restart PC dulu** sebelum reinstall Node atau ubah nama folder.

---

## Sedang Dikerjakan / Berikutnya / Ditunda

Ini **bagian prospektif** (apa yang sedang/akan dikerjakan) — beda dari
[Log Milestone](#log-milestone-terbaru-di-atas) yang **retrospektif** (apa
yang sudah selesai). Semua item baru wajib singgah di sini dulu sebelum
dikerjakan. Lihat juga `docs/development/WORKFLOW.md` untuk alur lengkapnya.

Tag asal: `[REQUEST FOUNDER]` diminta langsung Founder · `[TEMUAN]`
ditemukan CTO saat audit/kerja lain · `[TERENCANA]` bagian roadmap yang
memang sudah direncanakan.

### Sedang Dikerjakan

**KOSONG.** Menu "Tambah Webhook" selesai — lihat Log Milestone.

---

**Item lama (arsip, sudah DITUTUP)**. Ringkasan (detail penuh
versi pra-kompaksi ada di `git log -p` untuk file ini):

1. **Role-play UAT order-to-cash** (2026-08-16) — DITUTUP. Temuan kunci:
   bug 500 saat create order, root cause `generateOrderNumber()` pakai
   RLS-scoped client (undercount nomor order lintas-sales, tabrakan unique
   constraint) — fix ganti ke admin client. Turunan gate dari role-play ini:
   Gate P4.01 (`requested_delivery_date` untuk AI Dispatch Planner), field
   "Sales yang Menangani" jadi role-aware, fix UX search pelanggan (listbox
   tidak collapse), temuan gap Delivery/Invoice Tahap 5-6 (jalur web belum
   ada UI terbit invoice, cuma Telegram — lihat Backlog), halaman baru
   Lihat/Cetak Invoice, audit template invoice vs LOCKED guide (gap baris
   "Tempo" → ditutup Gate P4.02; gap `PhysicalPrintSheet` continuous-form →
   ditutup entri cetak-batch di Log Milestone), sidebar "Collection"
   dihapus (redirect lama tetap jalan).
2. **Checkpoint 4-poin** (disetujui 2026-08-17) — DITUTUP semua: commit
   dokumen readiness (`8ec2eb0`), konfirmasi P4.01/P4.02 ternyata sudah
   live hosted (tidak perlu push ulang), Gate P4.04 (audit visibility
   override status pengiriman), bundel 5 keputusan bisnis (lihat poin
   berikut).
3. **5 keputusan bisnis Founder** (2026-08-17) — DITUTUP semua: NOO
   reversal saat order pembuka toko dibatalkan → Gate P4.05; password
   recovery email legacy → tetap aktif (keputusan final, tanpa eksekusi
   kode); `payment.record` untuk sales/driver all-in → Gate P4.06 (klaim
   pembayaran + review Finance); tombol status generik "Kirim"/"Terkirim"
   → Gate P4.07 (dibatasi role owner/manager/admin); role `driver` untuk
   sales all-in → **tidak jadi role baru**, cukup dropdown "Assign driver"
   diperluas menampilkan role `sales` juga (`24afd47`), TANPA menyentuh
   RBAC/security allowlist.

### Berikutnya (urutan prioritas, atas = duluan)

1. `[REQUEST FOUNDER]` **Redesain Laporan Sales — Fase A SELESAI (2026-08-16,
   Gate P4.03), Fase B (voice note) masih menunggu.** Fase A: form
   `dashboard/reports/new` tidak lagi minta sales ketik ulang angka KPI —
   semua otomatis dari governed KPI ledger + `sales_order_items`. Sales
   cuma isi `area`/`remaining_working_days`/`notes`.

   **Sisa scope (Fase B, dari voice note Pak Waluyo ke Mas Hendro,
   2026-08-16) — BELUM dikerjakan, masih menunggu keputusan Founder**:
   1. **Jadwal kirim otomatis ~16.00-17.00** setiap hari kerja sales
      (kemungkinan terkait fitur "Executive WhatsApp Report" di
      `AODP_PRODUCT_CONSTITUTION.md` §13, belum pernah dibangun — scope
      lebih besar dari sekadar redesain form). **Update 2026-08-19**: ini
      lewat jalur `automation_outbox` (bukan `n8n_webhooks` langsung
      seperti Gate P4.08) — dan jalur itu **sengaja di-hardcode dry-run
      untuk channel WhatsApp** di `route.ts` internal-nya (lihat Backlog
      #9). Artinya begitu kredensial Bablast siap sekalipun, item ini
      TETAP butuh 1 perubahan kode lagi (hapus hardcode dry-run) sebelum
      bisa benar-benar kirim — bukan sekadar tunggu poin 3 (WhatsApp AI)
      selesai seperti asumsi sebelumnya.
   2. **Konten spesifik**: EC/kunjungan toko → EC-to-transaksi (bukan
      cuma kunjungan) → Tagihan (status collection/penagihan) → Omzet
      (nominal + % target). Perlu dipetakan ke KPI code existing +
      dicek apakah "Tagihan" sudah governed atau perlu sumber terpisah.
   3. **Varian laporan PAGI terpisah** — bukan hasil kerja, tapi RENCANA
      hari itu (toko mana yang mau ditagih). Konsep forward-looking baru,
      belum ada padanannya.
   Catatan: satu bagian transkrip tidak jelas ("LFD bekolnya") — perlu
   klarifikasi ulang ke Pak Waluyo langsung sebelum dieksekusi.
2. `[REQUEST FOUNDER]` **Fondasi data untuk chatbot bisnis Owner —
   DISETUJUI arahnya (2026-08-16), EKSEKUSI SENGAJA DITUNDA** ("kerjakan
   kalau waktunya tiba"). Audit kesiapan: "Produk paling laku"/"Toko
   paling banyak order" — data mentah sudah lengkap, tinggal digeneralisir
   jadi agregat rentang tanggal bebas. Governed KPI + Business Guard
   discount anomaly — sudah ada, tinggal disurfacing. "Tagihan mana yang
   bakal macet" — **sekarang SUDAH ADA** (Business Guard Collection Risk,
   dibangun 2026-08-18), sebelumnya ini satu-satunya kategori kosong.
   Rekomendasi CTO (belum dieksekusi): bangun satu lapisan agregat
   terstruktur dulu sebelum chatbot-nya sendiri. Chatbot wajib lewat
   `packages/ai` (CLAUDE.md #3), bukan panggil vendor AI langsung.
3. `[REQUEST FOUNDER]` **Ide strategis: network-effect intelligence dari
   data multi-tenant — DISETUJUI arahnya (2026-08-18), EKSEKUSI/DESAIN
   TEKNIS DISERAHKAN PENUH ke CTO, belum dimulai.** Muncul dari diskusi
   follow-up demo SURABRADJA (lihat juga memory
   `surabradja-demo-plan` di luar repo). Ide inti: begitu ada >1
   distributor aktif di platform (mis. Waluyo + SURABRADJA), data
   lintas-tenant yang governed (`company_id` + RLS per CLAUDE.md #7)
   berpotensi jadi moat yang susah ditiru kompetitor single-tenant —
   contoh konkret: skor kredibilitas toko lintas-distributor (broken
   promise/piutang macet di Distributor A jadi sinyal risiko buat
   Distributor B sebelum kasih kredit), atau prediksi cash-flow real
   (bukan cuma Revenue booked) dari kombinasi outstanding invoice +
   payment terms + Collection Risk. **Belum di-scope teknis** — perlu
   pertimbangan serius soal privasi/consent lintas-tenant sebelum desain
   konkret (data sharing antar perusahaan klien beda karakter dari fitur
   single-tenant biasa), plus baru relevan begitu ada tenant kedua aktif.

### Ditunda — menunggu keputusan Founder

| Item | Tag | Sejak | Konteks |
|---|---|---|---|
| WIP `forgot-password-form.tsx` memanggil RPC yang migration-nya cuma ada di `migrations_archive/` — akan gagal runtime bila dideploy apa adanya | `[TEMUAN]` | 2026-08-14 | Protected WIP milik Founder, belum diperbaiki karena statusnya. Detail: Backlog #14 |
| Halaman drill-down Call/Effective Call lintas-salesman untuk Owner/Manager | `[TEMUAN]` | 2026-08-15 | Detail: Backlog #7 |
| Notifikasi WhatsApp realtime ke Owner (Owner Approval Inbox) belum benar-benar kirim — provider Bablast dipilih Founder tapi API key/endpoint/template WA belum disetujui Meta | `[REQUEST FOUNDER]` | 2026-08-18, **dikoreksi 2026-08-19** | Sisi AODP (trigger event + payload pesan + link) sudah selesai & teruji (Gate P4.08). **KOREKSI (2026-08-19, audit arsitektur lengkap — lihat Backlog #9)**: klaim "tinggal daftarkan `n8n_webhooks`, tidak perlu kode baru" **TERNYATA TIDAK LENGKAP**. Yang ditunggu dari Founder tetap sama (API key + endpoint Bablast + template disetujui Meta), TAPI begitu itu didapat masih ada 2 pekerjaan KODE tambahan sebelum WA beneran terkirim: (1) workflow n8n yang ada (`n8n/flowsales-*.json`) masih template dengan URL placeholder, belum tersambung ke Bablast sama sekali; (2) tidak ada UI untuk mendaftarkan `n8n_webhooks` — cuma bisa insert manual lewat SQL. Detail lengkap 2 pipeline (event-triggered vs scheduled outbox) di Backlog #9. |

---

## Progres Modul MVP (PRD §5)

Rujukan: `docs/product/01_PRD.md` §5, `docs/product/modules/*.md`.

| Modul | Status | Catatan |
|---|---|---|
| **Core Platform** (auth, RBAC multi-tenant, sales order, customers, products, delivery, finance/invoicing) | Matang, gate terbanyak (3A–3D, 3E-D3–D5) | Enforcement harga khusus LOCKED & hosted-verified; Owner Approval Inbox UI live |
| **FlowSales AI** (laporan sales, KPI, AI Dispatch Planner, Telegram Sales Order Entry, AI Insights) | Matang, aktif dikembangkan | Gate 3E-D4/D5, Owner BI A–E |
| **Collection Intelligence** | Diimplementasikan sebagai bagian Finance Operations Workspace | `/dashboard/collection` redirect ke `/dashboard/finance/collection` (Gate 2I.x) |
| **Business Guard AI** (Risk Alert) | **OFFICIALLY PASS — 4/4 slice hidup, semua dikontribusikan ke Executive Intelligence** — Sales Risk/Discount Anomaly (2026-08-14) + Collection Risk/piutang macet (2026-08-18) + Behavior Change/pola customer (2026-08-19, Gate P4.09) + Transaction Risk Score/per-order (2026-08-19, Gate P4.10) + Risk Alert List gabungan. Tidak ada lagi placeholder "Segera Hadir" di halaman Risk. | `apps/web/src/lib/business-guard/`, `apps/web/src/app/(dashboard)/dashboard/risk/page.tsx`, `apps/web/src/lib/executive/contributors/business-guard.ts` |
| **WhatsApp AI** | **Belum diimplementasi** — UI "Segera Hadir" | `apps/web/src/app/(dashboard)/dashboard/whatsapp/page.tsx` |
| **Warehouse Intelligence** | **Placeholder resmi MVP** (bukan gap — keputusan produk terkunci, CLAUDE.md aturan #6) | Dashboard dasar delivery stats saja |

---

## Backlog & Gap Diketahui

Sumber: `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md` §15–16
(audit 2026-08-12) + `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`
(closeout final 2026-08-14). **Phase 3 sudah LOCKED** — daftar di bawah ini
sekarang murni next-workstream/accepted-limitation, bukan lagi P0 blocking.

### Next workstream (di luar Phase 3, tidak blocking)

1. ~~Web order create/update RPC tidak validasi `unit_price`~~ — **DITUTUP** Gate 3E-D6-A (`ff74a2e`).
2. ~~Special-price approval workflow sisi Sales tidak punya UI~~ — **DITUTUP** Gate 3E-D6-B (`60e2d9e`).
3. ~~Owner Approval Inbox UI belum ada~~ — **DITUTUP** (`b6fe1d9`), `/dashboard/orders/approvals` di atas RPC existing.
4. Pesan error Server Action di-redaksi generik oleh Next.js production (app-wide) — accepted limitation, follow-up UX kecil terpisah.
5. Kredensial demo `.env.demo.local` basi (3 akun demo tidak eksis di hosted) — accepted limitation, terkait #7.
6. React error #418 (hydration) intermiten saat automated testing hosted — root cause tidak 100% dipastikan (kemungkinan artefak tooling), accepted limitation.
6b. ~~NOO tidak punya mekanisme reversal saat order pembuka toko dibatalkan~~ — **DITUTUP** Gate P4.05 (`8199a6a`).
7. **[USULAN, BELUM DIKERJAKAN]** Halaman laporan kunjungan sales untuk Owner/Manager (drill-down Call/Effective Call lintas-salesman). Kartu Call/EC di `/dashboard/kpi` hanya clickable saat sales melihat achievement dirinya sendiri — Owner/Manager melihat salesman lain, kartu sengaja tidak clickable (belum ada halaman aman untuk drill-down lintas-salesman).
8. **[TEMUAN 2026-08-19]** `packages/ai` belum pernah benar-benar dipakai di `apps/web` — cuma `complete()` one-shot (bukan chat multi-turn), provider OpenAI/Anthropic ada tapi tidak pernah `registerProvider()`. Chatbot bisnis Owner (LLM beneran, di atas fondasi data `lib/owner-chat/` yang sudah PASS) butuh: pilih provider, API key, tambah dukungan multi-turn di `packages/ai`, dan chat UI baru — belum dieksekusi, effort terpisah & lebih besar dari fondasi datanya.
9. **[TEMUAN 2026-08-19]** Audit arsitektur lengkap "event AODP → WhatsApp" — mengoreksi klaim lama "tinggal daftarkan `n8n_webhooks`, tidak perlu kode baru". Ternyata ada **2 pipeline terpisah**, keduanya belum siap kirim WA nyata meski kredensial Bablast sudah di tangan:
   - **Jalur A (event-triggered, dipakai Gate P4.08)**: `submitSpecialPriceProposalAction` → `processAutomationEvent` → cek `automation_rules` → cek `n8n_webhooks` (**berhenti di sini sekarang, tidak ada baris terdaftar, hasil "skipped" diam-diam**) → POST ke n8n → n8n susun pesan → panggil Bablast. **2 gap kode**: (a) tidak ada UI untuk insert `n8n_webhooks` (cuma SQL manual); (b) workflow n8n yang ada (`n8n/flowsales-*.json`) baru template, URL masih placeholder `api.whatsapp-provider.example.com`, belum tersambung ke Bablast sama sekali.
   - **Jalur B (scheduled, dipakai untuk MORNING_BRIEF/KPI_DAILY_SUMMARY, relevan buat Laporan Sales Fase B "kirim jam 16-17")**: lewat `automation_outbox`, di-poll `n8n/aodp-outbox-dispatcher.json` tiap menit ke endpoint internal `/api/internal/automation/dispatch`. Endpoint ini **sengaja hardcode channel `whatsapp` selalu dry-run** — tidak peduli kredensial ada atau tidak, tidak akan pernah kirim nyata sampai kode itu diubah.
   Rekomendasi CTO: 3 pekerjaan terpisah kalau mau WA beneran nyala — (1) ~~menu "Tambah Webhook" di halaman Automation~~ **DITUTUP 2026-08-19**, (2) workflow n8n nyata ke Bablast (butuh kredensial dulu dari Founder), (3) hapus hardcode dry-run Jalur B (kode, bisa dikerjakan kapan saja tapi baru ada gunanya setelah (2) beres).

### Accepted limitations (dari audit 2026-08-12, tidak berubah, tidak blocking)

7. ~~Dokumen Gate 3D-B3-F5 dan seluruh Gate 3E-D0 tidak pernah di-commit~~ — **DITUTUP** (`8ec2eb0`), 4 dokumen di-commit.
8. `AODP_WALUYO_SALESMAN_KPI_FINAL.md` (LOCKED) belum diperbarui untuk mencerminkan Gate 3E-D5-B (EFFECTIVE_CALL tidak lagi wajib punya order).
9. Tidak ada `error.tsx` di route Dashboard Owner; beberapa fetcher Owner BI tidak fault-isolated.
10. Dead code `getMonthlySalesPerformance` (0 caller).
11. REVENUE governed belum menyesuaikan credit note/return — accepted risk terdokumentasi di migration header.
12. Gate 3B/3C/3C-A/3E-D2 (seluruh family) tidak punya dokumen kontrak `docs/` sendiri — hanya commit message + komentar migration.
13. **3 mekanisme password recovery aktif bersamaan**: email magic-link legacy (protected WIP), super-admin DB-only reset, Telegram self-service. Keputusan Founder 2026-08-17: email legacy tetap aktif.
14. WIP `forgot-password-form.tsx` memanggil RPC yang migration-nya hanya ada di `supabase/migrations_archive/` — akan gagal runtime bila dideploy apa adanya. Protected WIP, belum diperbaiki.

---

## Log Milestone (terbaru di atas)

Tag `[TERENCANA]`/`[TEMUAN]`/`[REQUEST FOUNDER]` berlaku untuk entri sejak
2026-08-15. Entri sebelumnya tidak ditandai retroaktif. **Entri sejak
2026-08-14 dipadatkan 2026-08-18** (fakta inti dipertahankan, narasi
debugging/verifikasi panjang dihapus — lihat catatan di kepala dokumen).

| Tanggal | Gate / Commit | Ringkasan | Status |
|---|---|---|---|
| 2026-08-19 | `[REQUEST FOUNDER]` **Audit folder `n8n/` — 5 file `flowsales-*.json` "lama" TERNYATA masih dipakai, tidak jadi dibersihkan** | Diminta audit & bersihkan template n8n yang tidak akan dipakai. Temuan: 5 file `flowsales-*.json` memang rusak untuk deploy nyata (skema HMAC lama, provider generic bukan Bablast), TAPI aktif dijaga `workflow-channel-routing.test.ts` (78 test PASS) yang terikat ke **Gate 3A Domain 5 (LOCKED)** — validasi aturan routing kanal (Sales→Telegram, Owner→WhatsApp). Menyentuh file ini akan menggagalkan 78 test & menyentuh gate LOCKED. Keputusan Founder: **dibiarkan apa adanya**, tidak dibersihkan. Murni audit read-only, tidak ada kode berubah. | **AUDIT SELESAI — tidak ada perubahan, keputusan: biarkan** |
| 2026-08-19 | `[REQUEST FOUNDER]` **Risk Alert: sembunyikan entitas "Aman" di 4 section detail** (quick fix) | Sebelumnya Sales Risk/Collection Risk/Behavior Change/Transaction Risk Score menampilkan SEMUA entitas termasuk yang risk_level NONE ("Aman") — cuma Risk Alert List gabungan yang sudah filter. Sekarang 4 section detail ikut filter ke yang perlu perhatian saja (pola sama), dengan empty-state "Semua ... dalam pola wajar" saat 0 yang di-flag. Header count (`X total · Y perlu perhatian`) dipertahankan supaya transparansi jumlah yang dicek tetap ada. Tidak ada perubahan logic scoring, murni UI. Diverifikasi browser: Sales Risk 3→1 baris tampil, Behavior Change & Transaction Risk Score tampil empty-state karena kebetulan semua "Aman" saat ini. | **PASS — lokal, browser terverifikasi** |
| 2026-08-19 | `[REQUEST FOUNDER]` **Menu "Tambah Webhook" di halaman Automation** (item 1/3 dari Backlog #9) | Form UI untuk insert `n8n_webhooks` — sebelumnya cuma bisa lewat SQL manual walau halaman Automation sendiri sudah lama menyebut instruksi "Tambah Webhook" yang ternyata tidak pernah dibangun. RLS `nw_manage` sudah membatasi ke role owner/admin/super_admin (bukan manager) — tidak perlu RPC baru, cuma server action + insert. File: `lib/automation/webhook-validation.ts` (pure validation + `canManageWebhooks`, 12 test), `lib/automation/actions.ts` (`createN8nWebhookAction`), `lib/automation/trigger-labels.ts` (extract `TRIGGER_LABELS` dari `automation/page.tsx` supaya form & tabel konsisten), `components/automation/add-webhook-form.tsx`, wiring `automation/page.tsx`. Diverifikasi end-to-end browser nyata: submit form → webhook baru muncul di tabel ("Bablast WA Notif (Test)", event Pengajuan Harga Khusus, status Aktif) — 1 baris data uji tertinggal di DB lokal (harmless, cuma dev). Test suite 12/12 PASS, `tsc --noEmit` bersih. **Item 2 (workflow n8n ke Bablast) & item 3 (hapus hardcode dry-run Jalur B) masih menunggu kredensial Bablast dari Founder.** | **PASS — lokal, test+browser end-to-end** |
| 2026-08-19 | `[TEMUAN]` **Koreksi dokumentasi: audit arsitektur "event AODP → WhatsApp" lengkap, klaim lama "tinggal daftarkan n8n_webhooks" TERNYATA tidak lengkap** | Ditemukan 2 pipeline terpisah (event-triggered via `n8n_webhooks` vs scheduled via `automation_outbox`), keduanya masih butuh kerja kode tambahan sebelum WA nyala nyata meski kredensial Bablast sudah ada — detail penuh di Backlog #9. Murni audit read-only, tidak ada kode berubah. | **KOREKSI DOKUMENTASI** |
| 2026-08-19 | `[REQUEST FOUNDER]` **Fondasi data chatbot bisnis Owner** (arah disetujui 2026-08-16, dieksekusi sekarang) | Modul baru `lib/owner-chat/`: `aggregates.ts` (pure function tanpa I/O: `aggregateTopProducts`, `aggregateTopCustomers`, `summarizeRiskLevels`, +test 8 kasus) + `snapshot.ts` (`getOwnerBusinessSnapshot(companyId, dateRange)` — satu titik akses gabungan produk paling laku + toko paling banyak order/omzet digeneralisir ke rentang tanggal bebas, KPI governed via reuse `aggregateGovernedKpis` dari `flowsales.ts`, ringkasan 4 Business Guard risk via reuse `generate*Report`). **Scope sengaja dibatasi ke lapisan data saja** — TIDAK menyentuh `packages/ai`/LLM/chat UI. Temuan penting: `packages/ai` ternyata belum pernah benar-benar dipakai di `apps/web` — `complete()` cuma one-shot (bukan chat multi-turn), provider OpenAI/Anthropic ada tapi tidak pernah `registerProvider()` di manapun. Chatbot beneran (manggil LLM) jadi effort terpisah & lebih besar (API key, pilih provider, biaya) — item baru di Backlog. Tidak ada UI baru di fase ini — diverifikasi test suite (69/69 PASS gabungan owner-chat+business-guard+executive) + `tsc --noEmit` bersih saja, sesuai CLAUDE.md (tidak klaim verifikasi UI yang tidak dilakukan). | **PASS — lokal, test+typecheck. UI/LLM belum ada, itu scope terpisah** |
| 2026-08-19 | `[REQUEST FOUNDER]` **Gate P4.10 — Business Guard AI: Transaction Risk Score, slice ke-4 (terakhir) — Business Guard AI OFFICIALLY PASS** | Skor **per transaksi individual** (per sales_order), beda dari 3 slice lain yang agregat per-entity. 3 sinyal per order dalam window recent 30 hari (baseline dari window 180 hari, terpisah dari window recent supaya order yang dinilai tidak mencemari baseline-nya sendiri): (1) nilai order vs rata-rata order historis customer itu sendiri (self-baseline), (2) order pertama customer baru langsung besar vs rata-rata order company, (3) kuantitas item 1 baris jauh melebihi rata-rata kuantitas order untuk produk itu (company-wide, min. 3 baris histori). File: `lib/business-guard/features/transaction-risk.ts` (+test 12 kasus, 2 kasus awal ditemukan salah kalibrasi ambang saat run test lalu diperbaiki), `lib/business-guard/engine.ts` (+`generateTransactionRiskReport`), `app/(dashboard)/dashboard/risk/page.tsx` (card aktif keempat, banner ganti jadi hijau "4 fitur aktif", FEATURE_CARDS placeholder terakhir dihapus karena sudah kosong), `lib/executive/contributors/business-guard.ts` (+health "Kewajaran Transaksi (30 Hari)"). Read-only murni, tanpa migration. Diverifikasi penuh: test suite Business Guard 46/46 PASS, `tsc --noEmit` 0 error baru, browser dikonfirmasi data nyata (`SO-DEV-0001` — Toko Sumber Rejeki, Rp680rb, "Aman") DAN Executive Intelligence menampilkan health baru skor 100 (Business Health Score naik 66→69/100). **Business Guard AI sekarang 4/4 slice hidup, semua dikontribusikan ke Executive Intelligence.** | **PASS — lokal, test + browser terverifikasi, OFFICIALLY PASS** |
| 2026-08-19 | `[REQUEST FOUNDER]` **Gate P4.09 — Business Guard AI: Behavior Change (customer), slice ke-3** | Rule-based, 2 sinyal customer-level — (1) order pattern drop self-baseline (hari sejak order terakhir vs rata-rata interval historis customer sendiri, min. 3 order utk baseline), (2) PIC berganti (dari `customer_relationship_events` yang sudah ada, tanpa tabel baru). File: `lib/business-guard/features/behavior-change.ts` (+test 12 kasus), `lib/business-guard/engine.ts` (+`generateBehaviorChangeReport`), `app/(dashboard)/dashboard/risk/page.tsx` (card aktif ke-3 + masuk Risk Alert List gabungan), `lib/executive/contributors/business-guard.ts` (+health "Stabilitas Perilaku Customer" weight 1 + insight/action HIGH/MEDIUM). Read-only murni, tanpa migration. Sempat blocked 1 hari oleh bug environment Node v26.3.0 (segfault) — **hilang setelah restart PC**, ternyata bukan masalah kode. Diverifikasi penuh setelah restart: test suite 25/25 PASS, `tsc --noEmit` bersih (0 error baru), browser lokal dikonfirmasi data nyata (`Toko Sumber Rejeki` -- "Aman", histori order <3 sehingga baseline di-skip sesuai desain) DAN Executive Intelligence menampilkan health "Stabilitas Perilaku Customer" skor 100. | **PASS — lokal, test + browser terverifikasi** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Risk Alert List — gabungan Sales Risk + Collection Risk** (`60e8352`) | Menutup placeholder terakhir "Segera Hadir" yang mudah — murni gabungan + sort severity dari 2 report existing, tanpa logic scoring baru. Diverifikasi browser: urutan & label benar. | **PASS — hosted (push `8432a43`)** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Sales Risk (discount anomaly) ikut dikontribusikan ke Executive Intelligence** (`45d6901`) | Murni wiring `generateDiscountAnomalyReport` existing ke `businessGuardContributor` — health "Kewajaran Diskon Sales" + insight/action per tier. Diverifikasi browser dengan data nyata. | **PASS — hosted** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Business Guard — Collection Risk (piutang berisiko macet), 4 milestone** (`ada1a1e`, `bec747a`, `59f4326`, `c2646c6`) | Modul baru: scoring rule-based aging piutang (31-60/61-90/>90 hari, +20/+40/+60) + broken promise (+15/janji, cap 30) + dispute (+10), tier sama Sales Risk (60/35/15). `generateCollectionRiskReport` (read-only) + contributor Executive Intelligence + kartu di `/dashboard/risk`. Diverifikasi end-to-end nyata: 1 invoice asli via `issue_invoice_atomic` + 1 broken promise, dikonfirmasi browser. | **PASS — hosted** |
| 2026-08-18 | `[REQUEST FOUNDER]` **PR kelengkapan data toko kredit (foto/GPS) di Executive Intelligence + Daily Brief** (`64690df`) | "Kredit" diturunkan dari `sales_orders.payment_terms_days` (bukan kolom customer) — toko CASH tidak diribetkan, hanya toko kredit kena PR. `lib/customers/data-completeness.ts` dipakai Executive Intelligence + Morning Brief (proaktif & Telegram on-demand) + filter `?data_gap=photo\|gps` di halaman Pelanggan. Diverifikasi browser + DB penuh dengan toggle kredit/cash. | **PASS — hosted** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Gate P4.08 — picu event automation saat harga khusus diajukan (bagian tanpa kredensial provider)** (`1410584`, migration `20261011000001`) | Provider WA dipilih Bablast (WABA resmi), tapi API key/template belum siap — dibangun bagian yang tidak butuh kredensial: `automation_rules`/`n8n_webhooks`/`processAutomationEvent()` (bukan `automation_outbox`, butuh n8n credential yang tidak tersedia dari server action user). `submitSpecialPriceProposalAction` memicu event fire-and-forget. Diverifikasi: pipeline lengkap via rule uji sementara, `automation_logs` mencatat sukses. | **PASS — hosted. Kirim WA nyata DITUNDA menunggu kredensial Bablast (lihat Ditunda).** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Owner Approval Inbox — halaman terpusat persetujuan harga khusus** (`b6fe1d9`) | `/dashboard/orders/approvals`, murni UI baru di atas RPC existing LOCKED (`submit_special_price_proposal_atomic`/`decide_special_price_proposal_atomic`), tanpa RPC/migration baru. Bug ditemukan & diperbaiki saat verifikasi browser: RPC terima verb `APPROVE`/`REJECT`, bukan `APPROVED`/`REJECTED`. Diverifikasi end-to-end dua arah (approve & reject). | **PASS — hosted** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Push 19 commit + TEMUAN KRITIS: 6 migration belum pernah diterapkan ke hosted** (`0bb7e52`) | `git push` kode dan `supabase db push` migration ternyata 2 langkah terpisah yang tidak pernah dijalankan bersamaan — 6 migration (P4.01/P4.02/P4.04-07) sempat tidak live di hosted tanpa terdeteksi. Ditutup: `supabase db push` dijalankan, Local==Remote dikonfirmasi. Pelajaran dicatat permanen di Status Ringkas. | **SELESAI — origin/main + hosted DB sinkron penuh** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Lengkapi kontrak kanonis `logAuditEvent` di 22 titik pemanggilan** (`a449622`) | Helper bersama `logAuditEvent()` tidak pernah mengisi kolom kanonis Gate 1D-A sejak awal dibuat. Fix: `module` wajib (compile-time net), default `event_category`/`source`/`outcome` masuk akal. Update `ACTIVITY_AUDIT_COVERAGE_MATRIX.md`: Laporan Sales/Produk/Platform/Auth → `covered`; Pelanggan/Pengguna/Import Data → `partial`. | **PASS — hosted** |
| 2026-08-18 | `[REQUEST FOUNDER]` **Koreksi dokumentasi: Collection TERNYATA sudah `covered` di Activity & Audit Log** (`69ec025`) | Matrix salah tercatat `missing` — RPC Gate 2C sudah menulis audit_logs kanonis sejak dibuat, dokumen saja yang stale (migration landed setelah matrix terakhir update). Murni koreksi dokumen, tidak ada kode baru. | **PASS — koreksi dokumentasi** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Gate P4.06 — Klaim Pembayaran sales/driver + review Owner/Finance** (`e310001`, migration `20261010000001`) | AODP = "ERP AI yang jagain owner" — sales all-in tidak punya jalur resmi lapor uang diterima. `submit_payment_claim_atomic` (permission baru `payment.claim`) tidak sentuh ledger; `approve_payment_claim_atomic` delegasi penuh ke `record_verified_payment_atomic` (LOCKED); guardrail kolom terkunci sejak submit. Keputusan Founder: bukti sisi klaim opsional dulu, wajib di titik approve. UI: `/dashboard/payment-claims` + `/dashboard/finance/payment-claims`. Diverifikasi end-to-end browser penuh. | **PASS — hosted** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Gate P4.05 — NOO reversal saat order pembuka toko dibatalkan** (`8199a6a`, migration `20261009000001`) | Menutup Backlog #6b — kredit NOO sebelumnya bisa "diakali" (confirm lalu batal, kredit tetap nempel). Trigger reversal baru + unique index rescope `customer_id`→`order_id`. Bug ditemukan saat verifikasi: `idempotency_key` asal customer-scoped, collide lintas order — diperbaiki jadi order-scoped. | **PASS — hosted** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Sales all-in bisa di-assign sebagai driver order sendiri, TANPA role driver baru** (`24afd47`) | Role `driver` untuk user existing ternyata tidak bisa lewat jalur resmi manapun (allowlist form + RLS). Founder pilih pendekatan lebih sederhana: dropdown "Assign driver" diperluas include role `sales` (`create_delivery_atomic` tidak pernah mensyaratkan role driver). Tidak menyentuh RBAC/security sama sekali. | **PASS — hosted** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Gate P4.07 — batasi override status kirim/terkirim ke owner/manager/admin/super_admin** (`d3bace3`, migration `20261008000001`) | `update_sales_order_status_atomic` transisi ke `delivering`/`delivered` sekarang hanya diizinkan role tertentu. Diverifikasi psql + browser sebagai `sales@aodp.test`: blocked dengan pesan error jelas. | **PASS — hosted** |
| 2026-08-17 | `[TEMUAN]` **Gate P4.04 — audit visibility untuk override status pengiriman via tombol generik** (`0152422`, migration `20261007000001`) | Tombol status generik tidak pernah cek tabel `deliveries` sebelum izinkan `delivering`/`delivered` — ternyata sengaja ada sebagai "override manusia valid" (bukan bug). Fix murni observability: `audit_logs.new_data` merekam `delivery_verified`/`manual_override`. Bonus fix: regresi `gate-2i2-workspace-containment.test.ts` di `origin/main` dari refactor sebelumnya, diperbaiki. | **PASS — hosted** |
| 2026-08-17 | `[TEMUAN]` **Koreksi: Gate P4.01/P4.02/P4.03 Fase A + document engine print/batch TERNYATA sudah live hosted** | `vercel inspect` konfirmasi commit-commit itu sudah live — tracker saja yang belum diupdate retroaktif. Pelajaran: `vercel ls`/`vercel inspect` harus jadi sumber kebenaran, bukan asumsi dari tracker lama. | **DIKONFIRMASI LIVE** |
| 2026-08-17 | `[TEMUAN]` **Commit 4 dokumen readiness Gate 3D-B3-F5 & 3E-D0** (`8ec2eb0`) | Menutup Backlog #7 — runbook cleanup, execution SQL, hosted inventory, pre-cleanup snapshot di-commit (dicek tidak ada secret). | **DITUTUP — hosted** |
| 2026-08-17 | `[TEMUAN]` **Fix bug: ikon amplop/telepon di header cetak pecah ke baris terpisah** (`components/document-engine/print.css`) | Root cause: Tailwind preflight `svg{display:block}` global membuat ikon jadi block-level. Fix `.doc-engine-contact-icon{display:inline-block}`. Diverifikasi via DOM measurement (`getBoundingClientRect`), bukan tebakan visual. | **PASS — hosted** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Identitas company lokal diganti ke data tenant asli PT Sumber Warna Alam Sudiada + logo asli** (data-only) | Header cetak diisi data company asli (nama ALL CAPS setelah 1 koreksi casing, alamat, kontak, logo). Header komponen sendiri tidak diubah — sudah cocok sejak awal, gap murni data seed placeholder. | **PASS — lokal** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Tombol "Cetak Sekarang" di halaman print invoice (single & batch)** | `PrintNowButton` (`window.print()`, `print:hidden`) di kedua halaman print. Pengaturan printer dot-matrix sendiri di luar jangkauan web app (level OS/driver). | **PASS — lokal** |
| 2026-08-17 | `[REQUEST FOUNDER]` **Cetak Invoice Batch — pilih banyak invoice, cetak sekaligus 1 lembar fisik continuous form** (`lib/finance/print-snapshot.ts`, `invoice-selection-table.tsx`, `print-batch/page.tsx`) | Founder konfirmasi pola cetak nyata batch, bukan satu-satu — 2 invoice pendek berbagi 1 lembar (hemat kertas). `buildPrintSheets()` Document Engine sudah support multi-dokumen sejak awal, tidak disentuh. UI baru: checkbox multi-select + `print-batch?ids=`. Diverifikasi browser: 2 invoice di 2 panel, urutan & angka benar. | **PASS — lokal** |
| 2026-08-16 | `[TEMUAN]` **Sambungkan halaman print invoice ke `PhysicalPrintSheet.tsx`** (2 panel/lembar, continuous form 3 ply) | Founder konfirmasi printer memang continuous form 3 ply — layout A4 penuh sebelumnya salah untuk kertas roll. Ganti render ke `buildPrintSheets()` + `PhysicalPrintSheet`, komponen Document Engine sendiri (LOCKED) tidak diubah. | **PASS — lokal** |
| 2026-08-16 | `[TEMUAN]` **Audit (role-play lokal Tahap 3-6): 3 gap "all-in sales" + laporan status Proof Payment & Collection Intelligence** | (1) FIXED: role `driver` ditambahkan ke `TELEGRAM_PAIRING_ELIGIBLE_ROLES` (sebelumnya tombol pairing Telegram tidak pernah muncul untuk driver). (2)(3) DICATAT untuk keputusan Founder: dropdown Assign driver terlalu ketat (kemudian ditutup 2026-08-17 lihat baris di atas); `payment.record` scope sempit by design. Laporan status murni (tanpa kode baru): Proof Payment cuma 2 text field (belum ada upload foto); Collection Intelligence sudah jalan tapi Business Guard Collection Risk masih kosong (kemudian dibangun 2026-08-18). | **PASS (fix #1) + 2 temuan dicatat** |
| 2026-08-16 | `[TEMUAN]` **Fix bug: mengunci periode KPI mematikan seluruh Dashboard Owner + rewire ranking Laporan Sales ke target governed asli** | Bug signifikan: klik "Kunci Periode" (LOCKED) membuat seluruh tile governed + Business Health Score salah tampil "Bisnis Sehat" padahal seharusnya "Perlu Tindakan Segera" — root cause query `.eq(status,"ACTIVE")` seharusnya `.in(status,["ACTIVE","LOCKED"])`. Ranking Laporan Sales dirombak pakai sumber sama dengan Dashboard Owner (tidak lagi dari snapshot `sales_reports` yang bisa understate). | **PASS — bug signifikan tertutup** |
| 2026-08-16 | `[REQUEST FOUNDER]` **KPI Setup: "Hari Kerja" otomatis + fix layout alasan target yang nyasar** | Field "Hari kerja" dihapus dari UI (tidak dipakai perhitungan manapun, dihitung otomatis background). Bug layout: blok alasan+tombol Call/EC salah taruh di bawah section NOO — dipindah ke lokasi benar. | **PASS — lokal** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Data operasional lokal: import 142 produk + 291 pelanggan SWAS, 3 Wilayah Penjualan, KPI Setup 3 sales** (data-only) | Import via jalur resmi Universal Data Onboarding. 3 Wilayah Penjualan dibuat + di-assign, 292 pelanggan dibagi rata ke 3 sales. Periode KPI Agustus 2026 + 5 target diisi via RPC resmi. | **PASS — lokal, data-only** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Gate P4.03 — Redesain Laporan Sales Fase A: ringkasan KPI harian otomatis, hapus double-entry** | Form `reports/new` tidak lagi minta sales ketik ulang angka KPI — dihitung dari ledger governed + `sales_order_items`, server tidak pernah percaya angka client. Tidak ada migration DB (kolom lama tetap ada, diisi otomatis). Regresi ditemukan & diperbaiki: label "OA Bulan Ini (Self-Report — Legacy)" tetap wajib dipertahankan (data campur lama/baru). Sisa scope Fase B (voice note) di "Berikutnya". | **PASS — lokal, browser + test suite penuh** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Gate P4.02 — payment_terms_days: sambungkan input "Termin Pembayaran" ke form order** (migration `20261006000001`) | Kolom `payment_terms_days` sudah ada sejak lama + Document Engine sudah lengkap membacanya — gap sempit murni tidak ada UI/parameter untuk mengisinya. Fix additive: parameter baru di RPC create/update + field baru di form. Diverifikasi end-to-end: order dengan Termin 14 hari → invoice cetak "Tempo: ... (14 Hari)" benar. | **PASS — hosted** |
| 2026-08-16 | `[TEMUAN]` **Audit template invoice: logo tenant + "Pengirim" salah tampil "Owner"** (`scripts/seed-dev.ts`, data-only) | Gap murni data-seed (logo_url NULL, delivery driver seed pakai akun Owner sebagai stand-in). Fix: 4 user seed baru ditambahkan (`driver`/`salma`/`waluyo`/`admin`@aodp.test). Bonus fix: 2 bug pra-existing di `seed-dev.ts` yang bikin script gagal total. | **PASS — lokal, dev-tooling** |
| 2026-08-16 | `[REQUEST FOUNDER]` **Push 13 commit ke `origin/main` + deploy hosted** (`f13d594..429f63f`) | Fix bug 500 order creation, Gate P4.01, role-aware "Sales yang Menangani", fix search pelanggan, halaman Lihat/Cetak Invoice, hapus sidebar "Collection". Vercel Ready dikonfirmasi. | **PASS — deploy Ready** |
| 2026-08-16 | `[REQUEST FOUNDER]` **`docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md` baru — peta order-to-cash per tahap + status PASS/gap** | 9 tahap dipetakan dari audit langsung ke kode (3 Explore agent paralel). 5 gap nyata teridentifikasi & di-rollup (Owner Approval Inbox, Dispatch Planner readiness, Business Guard Collection Risk, REVENUE credit note, NOO reversal — sebagian besar sudah ditutup sejak). | **SELESAI** |
| 2026-08-15 | `[REQUEST FOUNDER]` **Restrukturisasi TRACKER.md + `docs/development/WORKFLOW.md` baru** | Founder menilai pengerjaan "lompat-lompat". Ditambah section prospektif (Sedang Dikerjakan/Berikutnya/Ditunda), tagging asal kerja, dokumentasi branch production. | **SELESAI** |
| 2026-08-15 | `[REQUEST FOUNDER]` **Dashboard Owner: badge insight/tindakan jadi clickable + Aksi Cepat diganti sesuai scope owner** (`7fc7875`) | Aksi Cepat sebelumnya semua tugas data-entry sales/admin (bertentangan prinsip Owner First) — diganti Risk Alert/Kelola Pengguna/Laporan Sales/Pengaturan. Sempat salah push ke branch demo (cuma Preview deployment) — dikoreksi push ke `main`. | **PASS — hosted** |
| 2026-08-15 | **KPI Salesman UI: kartu achievement berwarna penuh + clickable** (`kpi-achievement-view.tsx`) | Background+border kartu ikut warna pacing status. Order Count/Revenue/NOO jadi link filter ke halaman terkait. Call/EC hanya link saat sales lihat achievement sendiri. | **PASS — hosted** |
| 2026-08-15 | **Data backfill hosted: 5 kredit NOO Salma yang hilang akibat timing deploy trigger** (data-only) | Trigger NOO di-deploy setelah 5 order pertama Salma confirmed — tidak retroaktif. Backfill disetujui Founder, pre-flight check per baris (tidak mungkin dobel-kredit). Susulan: target KPI Salma disamakan dengan Waluyo. | **PASS — selesai** |
| 2026-08-15 | **Fraud-guard "Daftar Toko": satukan jalur Web & Telegram + foto/GPS opsional** (migration `20261004000001`) | Tombol "Tambah Pelanggan" Web sebelumnya `.insert()` langsung tanpa deteksi duplikat/PIC/GPS — diganti pakai RPC lengkap `create_store_with_pic` yang sama dengan Telegram. PIC wajib, foto/GPS opsional (toko CASH tidak diribetkan). Diverifikasi lokal+hosted, regresi Telegram PASS. | **PASS — OFFICIALLY LOCKED (hosted)** |
| 2026-08-14 | **Business Guard AI — slice #1: Sales Risk / Discount Anomaly Indicator** | Vertical slice pertama (sebelumnya 100% placeholder). Rule-based, 4 sinyal (volume, rejection rate, kedalaman diskon, eskalasi). Live di `/dashboard/risk`. | **PASS — LIVE DI HOSTED** |
| 2026-08-14 | KPI Target Waluyo dilengkapi (hosted, data) | 5/5 KPI governed diisi target via RPC resmi (sebelumnya cuma 2/5). | **PASS** |
| 2026-08-14 | CTO Audit — status project & gap review | Audit menyeluruh: WhatsApp AI & Business Guard AI placeholder, WIP forgot-password RPC gap ditemukan, gap KPI Waluyo ditemukan. | **AUDIT SELESAI** |
| 2026-08-14 | Governance — Role Split diubah (`CLAUDE.md`) | Claude Code menggantikan ChatGPT sebagai CTO+PM. | **BERLAKU** |
| 2026-08-14 | **Phase 3 Final Hosted Closeout** | Audit menyeluruh + deploy migration D6-A ke hosted + 5 skenario UAT hosted membuktikan enforcement harga khusus live. Seluruh residual — accepted limitation, tidak blocking. | **PHASE 3: 100% OFFICIALLY LOCKED** |
| 2026-08-13 | Phase 3 — Hosted Deploy & UAT Ulang Enforcement Harga Khusus | Migration D6-A diterapkan ke hosted (blocker P0 nyata). 5 skenario UAT PASS semua. | **PASS** — blocker P0 tertutup |
| 2026-08-13 | Closeout Gate 3E-D6-B (`60e2d9e` + `78b7e76`) | Audit ulang + push fast-forward, HEAD==origin/main. | **OFFICIALLY LOCKED** |
| 2026-08-13 | Gate 3E-D6-B (`60e2d9e`) | UI Sales "Ajukan Harga Khusus", memanggil RPC existing session-scoped. | PASS (local) |
| 2026-08-12 | Gate 3E-D6-A (`ff74a2e`) | `confirm_sales_order_atomic` selalu re-evaluasi harga vs master price sebelum izinkan `confirmed` — menutup P0 #1. | **PASS** |
| 2026-08-12 | Audit closeout Phase 3 (`b8051e8`) | Full audit read-only + 1 skenario UAT. 2 gap P0, 8 gap P1/P2 ditemukan. | **BLOCKED** |
| 2026-08-12 | Gate Owner BI-E (`b1b396e`) | Hapus dead code `pctOa`. | PASS |
| 2026-08-11/12 | Gate Owner BI-A/B/C (`03113fa`, `cb6e3af`, `ba8959f`) | Governed REVENUE + rolling window; konsolidasi 5 KPI governed; drilldown Sales Performance per-salesperson. | PASS |
| 2026-08-10 | Gate 3E-D5-C (`c06f12c`) | Wiring KPI Foundation ke UI Owner (KPI Setup). | PASS |
| s.d. 2026-08-10 | Gate 3A → 3E-D5-B-H-R1 (35 gate) | Lihat scorecard `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md` §4 — role/permission matrix, onboarding/provisioning, password recovery, boundary mutasi order/item, special-price approval schema+RPC, governed NOO, Kunjungan Sales web. | Beragam (mayoritas PASS, 4 PARTIAL selain P0) |

**Sebelum Gate 3A** (Phase 0–2, baseline fork s.d. awal Phase 3): fork dari
FlowSalesAI Beta v1.0 RC, Product Constitution v1.0/v1.1, Executive
Intelligence command center, AI Dispatch Planner, delivery verification,
owner-control (audit log, coverage area, salesman activation), Finance
Operations Workspace lengkap (invoice, collection, credit, return,
cancellation — Gate 2I.x), Sales KPI foundation, n8n automation, Business
Document Engine, Telegram salesman enrollment, distributor onboarding &
import. Lihat `git log` (commit sebelum `50b8cab`) untuk detail.

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
