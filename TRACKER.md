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
| Tanggal update terakhir | 2026-08-13 |
| Branch | `main` |
| HEAD | `78b7e76` — docs: add project tracker (== `origin/main`, sudah dipush, fast-forward, ahead/behind 0/0) |
| Status Phase 3 | **BLOCKED (partial recovery)** — audit closeout 2026-08-12 menemukan 2 gap P0 (lihat Backlog); 1 dari 2 sudah ditutup (Gate 3E-D6-A), sisanya sebagian ditutup (Gate 3E-D6-B: sisi Sales; sisi Owner masih kosong) |
| Deployment | **Local-only untuk aplikasi/Supabase.** Belum ada mutasi hosted (Supabase) terverifikasi sejak audit Phase 3. Git repo (`origin/main` di GitHub) sudah in sync s.d. `78b7e76` — ini bukan hosted app deployment. `.env.local` → Supabase lokal (`127.0.0.1`); `.env.demo.local` → project hosted `AODP-Waluyo-Demo` (tidak disentuh rutin) |
| Full LOCK Phase 3 | Belum — menunggu Owner Approval Inbox UI (lihat P0 di bawah) + keputusan Founder atas gap P1/P2 |

---

## Progres Modul MVP (PRD §5)

Rujukan: `docs/product/01_PRD.md` §5, `docs/product/modules/*.md`.

| Modul | Status | Catatan |
|---|---|---|
| **Core Platform** (auth, RBAC multi-tenant, sales order, customers, products, delivery, finance/invoicing) | Matang, gate terbanyak (3A–3D, 3E-D3–D5) | Gap terbuka: approval harga khusus (lihat Backlog P0) |
| **FlowSales AI** (laporan sales, KPI, AI Dispatch Planner, Telegram Sales Order Entry, AI Insights) | Matang, aktif dikembangkan | Gate 3E-D4/D5, Owner BI A–E |
| **Collection Intelligence** | Diimplementasikan sebagai bagian Finance Operations Workspace | `/dashboard/collection` redirect ke `/dashboard/finance/collection` (Gate 2I.x) |
| **Business Guard AI** (Risk Alert) | **Belum diimplementasi** — UI "Segera Hadir" | `apps/web/src/app/(dashboard)/dashboard/risk/page.tsx` |
| **WhatsApp AI** | **Belum diimplementasi** — UI "Segera Hadir" | `apps/web/src/app/(dashboard)/dashboard/whatsapp/page.tsx` |
| **Warehouse Intelligence** | **Placeholder resmi MVP** (bukan gap — keputusan produk terkunci, CLAUDE.md aturan #6) | Dashboard dasar delivery stats saja |

---

## Backlog & Gap Diketahui

Sumber: `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md` §15–16
(audit 2026-08-12), diperbarui dengan progres pasca-audit.

### P0 — blocking full LOCK Phase 3

1. ~~Web order create/update RPC tidak validasi `unit_price` terhadap
   `products.price`/`knowledge_discount_policies`~~ — **DITUTUP** Gate
   3E-D6-A (`ff74a2e`). `confirm_sales_order_atomic` sekarang selalu
   re-evaluasi item saat ini terhadap formula harga master/kebijakan diskon;
   RLS `sales_orders` juga menutup direct-write ke `status=confirmed`.
2. Special-price approval workflow tidak punya UI:
   - Sisi Sales (ajukan harga khusus) — **DITUTUP** Gate 3E-D6-B (`60e2d9e`,
     sesi ini). Entry point di `/dashboard/orders/[id]`, memanggil RPC
     existing `submit_special_price_proposal_atomic`.
   - Sisi Owner (approve/reject) — **BELUM ADA**. RPC
     `decide_special_price_proposal_atomic` masih 0 caller produksi sampai
     sekarang. **Ini gap P0 terbuka berikutnya.**

### P1/P2 — tidak blocking LOCK sendirian, tapi material untuk keputusan Founder

3. Dokumen Gate 3D-B3-F5 dan seluruh Gate 3E-D0 (hosted clean-slate) tidak
   pernah di-commit ke git; status eksekusi destruktif di hosted **tidak
   dapat diverifikasi** dari repo. Perlu konfirmasi Founder (akses Studio
   hosted).
4. `docs/product/discovery/AODP_WALUYO_SALESMAN_KPI_FINAL.md` (LOCKED) belum
   diperbarui untuk mencerminkan keputusan Gate 3E-D5-B (EFFECTIVE_CALL tidak
   lagi wajib punya order).
5. Tidak ada `error.tsx` di route Dashboard Owner; beberapa fetcher Owner BI
   tidak fault-isolated (beda dengan kontributor Executive Intelligence).
6. Dead code `getMonthlySalesPerformance` (0 caller, sejenis `pctOa` yang
   sudah dibersihkan Gate Owner BI-E).
7. REVENUE governed belum menyesuaikan credit note/return; NOO belum
   reversal saat order pembuka toko baru dibatalkan — sudah terdokumentasi
   eksplisit sebagai accepted risk di migration header, bukan oversight.
8. Gate 3B/3C/3C-A/3E-D2 (seluruh family) tidak punya dokumen kontrak
   `docs/` sendiri — hanya commit message + komentar migration.
9. **3 mekanisme password recovery aktif bersamaan**: email magic-link
   legacy (`forgot-password-form.tsx`, protected WIP user, live), super-admin
   DB-only reset, dan Telegram self-service. Perlu klarifikasi Founder apakah
   email legacy disengaja tetap hidup atau seharusnya dimatikan.
10. WIP `forgot-password-form.tsx` (protected, belum di-commit) memanggil RPC
    `begin_self_recovery_password_change` yang migration-nya **hanya ada di
    `supabase/migrations_archive/`**, bukan `supabase/migrations/` aktif —
    akan gagal runtime bila di-deploy apa adanya. Belum diperbaiki karena
    berstatus protected WIP milik user.

---

## Log Milestone (terbaru di atas)

| Tanggal | Gate / Commit | Ringkasan | Status |
|---|---|---|---|
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
- Audit closeout Phase 3 (paling detail, jadi baseline gap saat ini):
  `docs/product/readiness/AODP_PHASE_3_CLOSEOUT_AUDIT.md`
- Sprint plan awal: `docs/development/sprints/*.md`
- Aturan kerja Claude Code: `CLAUDE.md`
