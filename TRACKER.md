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

1. **Setiap menyelesaikan sebuah gate/milestone** (PASS, PARTIAL, maupun
   BLOCKED), tambahkan satu baris baru di paling atas tabel
   [Log Milestone](#log-milestone-terbaru-di-atas) — jangan menimpa baris lama.
2. Perbarui [Status Ringkas](#status-ringkas) (tanggal, HEAD, gate terakhir).
3. Jika milestone tsb menutup atau membuka gap baru, perbarui
   [Backlog & Gap Diketahui](#backlog--gap-diketahui).
4. Jika progres modul MVP berubah level (mis. placeholder → aktif dibangun),
   perbarui [Progres Modul MVP](#progres-modul-mvp-prd-5).
5. Jangan menyalin isi migration/RPC/test ke sini — cukup nama file/gate id
   dan satu kalimat ringkasan. Detail penuh selalu di `docs/product/readiness/`
   atau commit message aslinya.

---

## Status Ringkas

| | |
|---|---|
| Tanggal update terakhir | 2026-08-14 |
| Branch | `main` |
| HEAD | (lihat commit closeout dokumentasi ini — `== origin/main`, fast-forward, ahead/behind 0/0) |
| Status Phase 3 | **100% — OFFICIALLY LOCKED (PASS WITH ACCEPTED LIMITATIONS)** — lihat `docs/product/readiness/AODP_PHASE_3_FINAL_HOSTED_CLOSEOUT.md`. Blocker P0 (enforcement harga khusus) tertutup penuh & diverifikasi hidup di hosted lewat 5 skenario UAT (2026-08-13/14). |
| Deployment | Vercel `aodp-waluyo-demo` menjalankan commit `465a26f` (mengandung Gate 3E-D6-A `ff74a2e` + 3E-D6-B `60e2d9e`), dikonfirmasi hosted. Migration `20261003000001` (D6-A) sudah diterapkan ke Supabase hosted `AODP-Waluyo-Demo`. `.env.local` → Supabase lokal (`127.0.0.1`) untuk dev; `.env.demo.local` → hosted demo (kredensial demo di file itu **basi**, lihat Backlog) |
| Full LOCK Phase 3 | **Sudah** — lihat closeout final. Owner Approval Inbox UI TETAP belum ada (bukan blocker Phase 3, gate baru terpisah untuk next workstream) |
| Governance | Sejak 2026-08-14: **Claude Code = CTO + Senior Programmer AODP** (menggantikan ChatGPT sebagai CTO+PM). Keputusan teknis/arsitektur diputuskan langsung oleh Claude Code (didokumentasikan di sini/commit message); keputusan arah produk/bisnis tetap diajukan ke Founder dulu. Detail: `CLAUDE.md` §Role Split. |
| Data Operasional (tenant Waluyo, hosted) | KPI Setup lengkap — 5/5 KPI governed punya target aktif periode Agustus 2026 (Call 15, Effective Call 15, Order Count 15, Revenue Rp100jt, NOO 3 toko). Dashboard Owner sekarang menampilkan progres real untuk semuanya, bukan lagi "Data belum cukup". |

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

| Tanggal | Gate / Commit | Ringkasan | Status |
|---|---|---|---|
| 2026-08-15 | **Fraud-guard "Daftar Toko": satukan jalur Web & Telegram + foto/GPS opsional** (`supabase/migrations/20261004000001_gate_store_photo_gps_web.sql`, `lib/customer-pic/*`, `components/customer-pic/add-store-form.tsx`) | Temuan: tombol "Tambah Pelanggan" di Web selama ini `.insert()` langsung ke `customers` -- TANPA deteksi duplikat toko, TANPA PIC, TANPA GPS -- padahal RPC lengkap (`create_store_with_pic`, deteksi duplikat, dipakai Telegram) sudah ada tapi tidak pernah disambungkan ke UI manapun (`createStoreAction` dead code). Perbaikan: form Web sekarang pakai RPC yang sama (source `ADMIN_DASHBOARD`, sudah didukung sejak awal). Tambahan murni ADDITIVE (2 param baru DEFAULT NULL di akhir signature, pola identik penambahan email sebelumnya) -- PIC nama+telepon TETAP wajib (keputusan Pak Waluyo, tidak diubah), foto depan toko/foto PIC/GPS SEMUA opsional (toko CASH tidak diribetkan). Infrastruktur upload foto (bucket Storage `store-photos`, RLS tenant-scoped) dibangun baru -- sebelumnya tidak ada di manapun di sistem. Diverifikasi lokal: skenario CASH tanpa foto/GPS PASS, deteksi duplikat PASS (toko sama persis ditolak dengan pesan jelas), regresi jalur Telegram PASS (dipanggil persis gaya lama tanpa param foto, hasil identik `created`, kolom foto default NULL). Build+lint+90 test existing PASS. | **PASS (lokal)** — belum di-apply ke hosted, menunggu konfirmasi |
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
