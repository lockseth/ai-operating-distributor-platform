# Activity & Audit Log — Coverage Matrix

Status: **Gate 1D-A selesai + Kelompok 1 (K1 KPI, K2 Order, K3 Discount, K4
Delivery) selesai**. Dokumen ini adalah inventaris gap, BUKAN klaim selesai
untuk baris yang belum granular diverifikasi. Gate 1D secara keseluruhan baru
PASS setelah seluruh baris di bawah berstatus `covered`.

## Cara membaca

- **Event existing** — writer `audit_logs` yang SUDAH ada sebelum Gate 1D-A
  (RPC `INSERT INTO audit_logs` atau server action `logAuditEvent`).
- **Gap** — apa yang belum memenuhi kontrak kanonis Gate 1D (lihat
  `CANONICAL EVENT CONTRACT` pada laporan gate), atau aktivitas yang sama
  sekali belum tercatat.
- **Status**:
  - `missing` — tidak ada writer audit sama sekali untuk modul ini.
  - `partial` — writer existing ada (event lama tercatat), tapi kolom kanonis
    baru (`actor_type`, `event_category`, `module`, `source`, `outcome`) belum
    diisi oleh writer manapun untuk modul ini (scope retrofit 1D-B/1D-C), atau
    hanya sebagian aktivitas modul yang tercatat.
  - `covered` — writer mengisi kontrak kanonis penuh DAN ada test yang
    membuktikannya (bukan UI-only).
- **PENTING (histori)**: pada Gate 1D-A, kontrak kanonis baru (kolom tambahan
  migration `20260819000001`) belum diisi oleh writer manapun yang sudah ada
  — retrofit writer adalah scope 1D-B (Kelompok 1 ini), bukan gate 1D-A. Sejak
  Kelompok 1 (commit `29f9c4c`, `b54e8c2`, `f2890d3`), tiga baris di bawah
  (KPI Salesman, Sales Order, Delivery Verification) sudah `covered` untuk
  transisi material yang dicakup masing-masing commit — baris lain yang masih
  `partial`/`missing` BELUM disentuh Kelompok 1 (di luar scope K1–K4) dan tetap
  menunggu Gate 1D-C/gate lanjutan.
- **Discount (K3)**: TIDAK ADA baris tersendiri di matrix ini karena diskon
  bukan menu sidebar terpisah — kesimpulan discovery K3 (lihat laporan gate):
  tidak ada capability approval/rejection/override diskon di codebase ini
  (`sales-orders/discount.ts` hanya evaluasi nilai per-item saat order dibuat,
  `requires_discount_review` hanya flag tampilan, tidak pernah ditindaklanjuti
  lewat aksi approve/reject/override). NOT IMPLEMENTED — tidak ada event
  dibuat, konsisten dengan instruksi "jangan membuat event palsu". Nilai
  diskon per order sudah tercakup dalam payload event `order.create`/
  `order.update` (baris Sales Order di bawah).

## Matrix

| Menu / Modul | Aktivitas Manusia | Aktivitas AI/System | Event Existing | Gap | Target Subgate | Status | Bukti Writer/Test |
|---|---|---|---|---|---|---|---|
| Dashboard (`/dashboard`) | Lihat ringkasan (read-only, per role) | — | Tidak ada (page-view sengaja tidak dicatat, lihat section H Gate 1D-A) | Page-access/navigation belum punya explicit signal + dedupe | 1D-C | missing | — |
| WhatsApp AI (`/dashboard/whatsapp`) | Interaksi/konfigurasi AI WhatsApp | Balasan otomatis AI | Tidak ditemukan writer khusus modul ini | Aktivitas AI & human belum tercatat | 1D-C | missing | — |
| Sales Order (`/dashboard/orders`, termasuk Telegram Order Entry) | Create/update/status/cancel order (Web); create/update/confirm draft order (Telegram); cancellation/dispute request+resolve | — | RPC atomik `create/update_sales_order_atomic`, `update_sales_order_status_atomic`, `cancel_sales_order_atomic`, `create/update/confirm_..._draft_..._atomic`, `create/resolve_order_cancellation_dispute` — SEMUA menulis audit_logs kanonis penuh dalam transaksi yang sama dengan mutasi | Tidak ada gap untuk transition yang tercakup K2. Discount decision: lihat catatan K3 di atas (NOT IMPLEMENTED, bukan gap Order) | 1D-B (K2, selesai) | covered | `supabase/migrations/20260822000001_order_lifecycle_audit_atomic.sql`; `apps/web/src/lib/orders/actions.ts`; `apps/web/src/lib/sales-orders/repository.ts`; test: `orders/actions.integration.test.ts`, `document-engine/payment-terms-closure.integration.test.ts`; commit `b54e8c2` |
| AI Dispatch Planner (`/dashboard/dispatch`) | Approve/adjust rencana dispatch | Saran rute/dispatch AI | Tidak ditemukan writer | Aktivitas AI & human belum tercatat | 1D-C (AI) + 1D-B (approval manusia) | missing | — |
| Laporan Sales (`/dashboard/reports`) | Input/edit laporan harian (hybrid model) | Agregasi otomatis vs `sales_orders` | `logAuditEvent` di actions | Kontrak baru belum diisi; agregasi otomatis AI belum tercatat terpisah | 1D-B (human) / 1D-C (agregasi otomatis) | partial | `apps/web/src/lib/sales-reports/actions.ts` |
| KPI Salesman (`/dashboard/kpi`) | Set konfigurasi/target KPI, kalibrasi | Kalkulasi achievement otomatis (TIDAK diaudit — deterministik, sesuai Lean-Audit rule) | RPC `initialize_sales_kpi_foundation`, `create_sales_kpi_period`, `set_sales_kpi_period_status`, `set_sales_kpi_target` — kanonis penuh | Tidak ada gap untuk configuration/period target (K1). Manual achievement override: NOT IMPLEMENTED (tidak ada capability-nya di codebase, ditegakkan struktural via trigger append-only) — sengaja tidak dibuat event. Call/visit recording (`record_sales_call` dkk, domain achievement bukan configuration/target) di luar scope K1, tetap `partial` | 1D-B (K1, selesai) | covered (configuration & period target) | `supabase/migrations/20260821000001_kpi_target_audit_canonical.sql`; test: `sales-kpi/calibration.integration.test.ts`, `sales-kpi/achievement.integration.test.ts`; commit `29f9c4c` |
| Collection (`/dashboard/collection`) | Record collection attempt/outcome, create/correct/cancel promise to pay, mark broken | — | RPC atomik `record_collection_activity`, `create_promise_to_pay`, `correct_promise_to_pay`, `cancel_promise_to_pay`, `mark_promise_broken` (Gate 2C, migration `20260828000001`, commit `dcc4ad4`) — SEMUA menulis audit_logs kanonis penuh (module/event_category/source/outcome) dalam transaksi yang sama dengan mutasi, sejak awal gate ini dibuat | Tidak ada gap untuk lima transisi di atas. **Koreksi dokumentasi 2026-08-17**: baris ini sebelumnya salah ditandai `missing` — migration `dcc4ad4` (16:32 WIB) landed SETELAH matrix ini terakhir di-update (`c6593c5`, 10:18 WIB, hari yang sama), jadi tercatat "belum ada" padahal writernya sudah lengkap sejak awal, dokumen ini saja yang tidak pernah disinkronkan ulang. Ditemukan &amp; diperbaiki saat Founder menanyakan kesiapan struktur audit (bukan kerja baru) | 1D-B | covered | `supabase/migrations/20260828000001_collection_promise_foundation.sql` (baris 511, 655, 795, 898, 1002); test: `apps/web/src/lib/finance/collection-promise-foundation.integration.test.ts` (baris 280, 298, 465, 534, 546, 646, 800-833, verifikasi eksplisit module/event_category/outcome/payload, bukan cuma presence); dikonfirmasi ada 93 baris audit `module='collection'` di DB lokal saat verifikasi |
| Risk Alert (`/dashboard/risk`) | Acknowledge/tindak lanjut alert (bila ada) | Generate risk alert (Business Guard) | Tidak ditemukan writer | Aktivitas AI & human belum tercatat; CLAUDE.md mengunci alert tidak bisa dihapus role sales — belum ada bukti audit utk enforcement ini | 1D-C (AI) + 1D-B (human ack) | missing | — |
| AI Insights (`/dashboard/ai`) | Lihat/tindak lanjut insight | Generate insight AI | Tidak ditemukan writer | Aktivitas AI belum tercatat | 1D-C | missing | — |
| Pelanggan (`/dashboard/customers`) | Create/update pelanggan, verifikasi PIC | — | `logAuditEvent` di actions; RPC PIC master/email | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/customers/actions.ts`; `supabase/migrations/20260728000001_customer_pic_master.sql`; `20260730000001_customer_pic_email.sql`; `20260728000005_fix_pic_verify_self_verify_rule.sql` |
| Produk (`/dashboard/products`) | Create/update produk | — | `logAuditEvent` di actions | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/products/actions.ts` |
| **Activity & Audit Log** (`/dashboard/owner/activity-log`) — **baru, Gate 1D-A** | Owner melihat & memfilter log (read-only, tidak ada edit/hapus) | — | N/A (reader, bukan writer) | Page-view halaman ini sendiri sengaja tidak dicatat (section H) | — | covered (fondasi reader) | `apps/web/src/app/(dashboard)/dashboard/owner/activity-log/page.tsx`; `apps/web/src/lib/audit-log/security.test.ts` |
| Automation (`/dashboard/automation`, rule-based Automation Engine) | Buat/ubah rule automation | Eksekusi rule otomatis | Tidak ditemukan writer utk perubahan rule | Aktivitas AI & human belum tercatat | 1D-C | missing | — |
| Automation Outbox / n8n (`/dashboard/automation/outbox`) | Replay job (Owner/manager) | Claim/dispatch/complete/fail job oleh n8n | RPC `INSERT audit_logs` ekstensif per transisi job | Kontrak baru belum diisi; actor system/automation belum diberi `actor_type` eksplisit | 1D-B (human replay) / 1D-C (system) | partial | `supabase/migrations/20260807000001_automation_outbox.sql`; test: `n8n-automation/outbox.integration.test.ts` |
| Pengguna (`/dashboard/users`) — termasuk Salesman, Coverage Area, Telegram Pairing (Gate 1A–1C) | Tambah/nonaktifkan salesman, atur wilayah, pairing Telegram | — | RPC `INSERT audit_logs` sangat ekstensif (Gate 1A–1C) | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/salesman/actions.ts`+`repository.ts`; `supabase/migrations/20260722000001_telegram_salesman_identity_enrollment.sql`, `20260813000001_company_coverage_area_management.sql`, `20260814000001_salesman_coverage_assignment_owner_only.sql`, `20260815000001_salesman_active_status_owner_only.sql`, `20260816000001_coverage_areas_master.sql`, `20260818000001_telegram_pairing_owner_only.sql`; test: `salesman/security.test.ts`, `coverage-area/security.test.ts`, `telegram-enrollment/security.test.ts` |
| **Delivery Verification** (dari `/dashboard/orders/[id]`, dieksekusi via Telegram driver) — **baru ditambahkan ke matrix, sebelumnya absen total** | Buat delivery + assign driver (Owner/manager); dispatch, konfirmasi penerimaan/exception/recipient (driver via Telegram) | — | RPC atomik `create_delivery_atomic`, `dispatch_delivery_atomic`, `finalize_delivery_atomic` — audit_logs kanonis penuh, termasuk bukti quantity sent/received/selisih + referensi evidence (ID saja, bukan file/foto) | Tidak ada gap untuk create/dispatch/receipt-confirmation. `delivery_events` (trail operasional pre-existing sejak 20260716000001) TETAP terpisah, tidak digabung. Transisi "arrived" (intermediate, bukan keputusan bisnis) TIDAK diaudit ke audit_logs (tetap di delivery_events saja) — sesuai keputusan scope K4. Cancel/correct delivery: NOT IMPLEMENTED (tidak ada capability-nya) | 1D-B (K4, selesai) | covered (create, dispatch, receipt confirmation) | `supabase/migrations/20260823000001_delivery_audit_atomic.sql`; test: `delivery/delivery-atomic.integration.test.ts`; commit `f2890d3` |
| Import Data (`/dashboard/imports`) | Upload/preview/commit/rollback import | — | `logAuditEvent` di actions; RPC commit/rollback fix | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/imports/actions.ts`; `apps/web/src/lib/settings/import-actions.ts`, `import-preview-actions.ts`; `supabase/migrations/20260801000002_legacy_import_commit_rollback.sql`, `20260801000004_fix_commit_row_count_parity.sql`, `20260803000001_fix_commit_invalid_status_type_cast.sql` |
| Pengaturan (`/dashboard/settings`, di luar Import) | Ubah pengaturan tenant (branding, dll.) | — | Tidak ditemukan writer khusus di luar Import | Aktivitas non-import belum tercatat | 1D-B | missing (untuk non-import) | — |
| Platform (`/dashboard/platform`, super_admin) | Kelola tenant | — | `logAuditEvent` di `platform/tenant-actions.ts` | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/platform/tenant-actions.ts` |
| *(lintas-modul, bukan menu sidebar)* Auth & Login | Login/logout | — | `logAuditEvent` di `lib/actions/auth.ts`; writer di `app/api/auth/login-audit/route.ts`, `app/(auth)/callback/route.ts` | Belum berkategori `event_category='security'` secara eksplisit | 1D-C (security activity) | partial | `apps/web/src/lib/actions/auth.ts`; `apps/web/src/app/api/auth/login-audit/route.ts` |

## Ringkasan

- Total baris: 18 (17 menu sidebar semula + Delivery Verification, baru
  ditambahkan Kelompok 1 K4 — sebelumnya absen total dari matrix ini).
- `covered`: 5 — Activity & Audit Log (fondasi reader), KPI Salesman
  (configuration & period target, K1), Sales Order (termasuk Telegram Order
  Entry, K2), Delivery Verification (create/dispatch/receipt confirmation, K4),
  **Collection** (record activity + promise lifecycle penuh, Gate 2C — status
  diperbaiki 2026-08-17, sebelumnya salah tercatat `missing`, lihat catatan di
  baris Collection). Baris K1/K2/K4/Collection `covered` UNTUK TRANSISI YANG
  DICAKUP MASING-MASING GATE SAJA — sub-domain di luar scope (achievement/call
  recording KPI, discount decision, evidence-attachment individual, delivery
  arrival/cancel) TIDAK diklaim covered, lihat kolom Gap masing-masing baris.
- `partial`: 7 (Laporan Sales, Pelanggan, Produk, Automation Outbox, Pengguna,
  Import Data, Platform) — TIDAK disentuh Kelompok 1, di luar scope K1–K4.
- `missing`: 6 (Dashboard/page-view, WhatsApp AI, AI Dispatch Planner,
  Risk Alert, AI Insights, Automation rule-based, sebagian Pengaturan
  non-import).
- Discount: TIDAK ADA baris tersendiri — K3 menyimpulkan NOT IMPLEMENTED
  (tidak ada capability approval/override diskon di codebase ini). Lihat
  catatan di atas.
- Gate 1D **belum PASS** secara keseluruhan — baris `partial`/`missing` yang
  tersisa menunggu Gate 1D-C/gate lanjutan (Kelompok 2+, aktivitas
  AI/system/automation/navigation/export/messaging/retry/security, dan modul
  non-K1–K4/Collection seperti Laporan Sales/Pelanggan/Produk/Automation
  Outbox/Pengguna/Import Data/Platform).
