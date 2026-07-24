# Activity & Audit Log — Coverage Matrix

Status: **Gate 1D-A** (fondasi). Dokumen ini adalah inventaris gap, BUKAN klaim
selesai. Gate 1D secara keseluruhan baru PASS setelah seluruh baris di bawah
berstatus `covered`.

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
- **PENTING**: karena kontrak kanonis baru (kolom tambahan migration
  `20260819000001`) belum diisi oleh writer manapun yang sudah ada sebelum
  Gate 1D-A (retrofit writer adalah scope 1D-B/1D-C, bukan gate ini), **tidak
  ada modul bisnis yang berstatus `covered` pada Gate 1D-A** — ini
  konsisten dengan section G Gate 1D-A ("boleh selesai dengan partial/missing").
  Satu-satunya baris `covered` adalah halaman Activity & Audit Log itu sendiri
  (fondasi reader, bukan klaim retrofit data bisnis).

## Matrix

| Menu / Modul | Aktivitas Manusia | Aktivitas AI/System | Event Existing | Gap | Target Subgate | Status | Bukti Writer/Test |
|---|---|---|---|---|---|---|---|
| Dashboard (`/dashboard`) | Lihat ringkasan (read-only, per role) | — | Tidak ada (page-view sengaja tidak dicatat, lihat section H Gate 1D-A) | Page-access/navigation belum punya explicit signal + dedupe | 1D-C | missing | — |
| WhatsApp AI (`/dashboard/whatsapp`) | Interaksi/konfigurasi AI WhatsApp | Balasan otomatis AI | Tidak ditemukan writer khusus modul ini | Aktivitas AI & human belum tercatat | 1D-C | missing | — |
| Sales Order (`/dashboard/orders`) | Create/update/cancel/dispute order | — | `logAuditEvent` di actions; RPC dispute/cancel | Kontrak baru (`actor_type`/`event_category`/`module`) belum diisi | 1D-B | partial | `apps/web/src/lib/orders/actions.ts`; `supabase/migrations/20260725000001_order_cancellation_dispute.sql`; `20260726000001_fix_order_dispute_return_type_cast.sql` |
| AI Dispatch Planner (`/dashboard/dispatch`) | Approve/adjust rencana dispatch | Saran rute/dispatch AI | Tidak ditemukan writer | Aktivitas AI & human belum tercatat | 1D-C (AI) + 1D-B (approval manusia) | missing | — |
| Laporan Sales (`/dashboard/reports`) | Input/edit laporan harian (hybrid model) | Agregasi otomatis vs `sales_orders` | `logAuditEvent` di actions | Kontrak baru belum diisi; agregasi otomatis AI belum tercatat terpisah | 1D-B (human) / 1D-C (agregasi otomatis) | partial | `apps/web/src/lib/sales-reports/actions.ts` |
| KPI Salesman (`/dashboard/kpi`) | Set target KPI, kalibrasi | Kalkulasi achievement otomatis | RPC `INSERT audit_logs` ekstensif | Kontrak baru belum diisi | 1D-B | partial | `supabase/migrations/20260804000001_configurable_sales_kpi_foundation.sql`; `20260805000001_sales_kpi_achievement_integration.sql`; `20260806000001_sales_kpi_target_calibration.sql`; test: `sales-kpi/calibration.integration.test.ts`, `sales-kpi/achievement.integration.test.ts` |
| Collection (`/dashboard/collection`) | Pencatatan pembayaran/collection | — | Tidak ditemukan writer | Aktivitas belum tercatat | 1D-B | missing | — |
| Risk Alert (`/dashboard/risk`) | Acknowledge/tindak lanjut alert (bila ada) | Generate risk alert (Business Guard) | Tidak ditemukan writer | Aktivitas AI & human belum tercatat; CLAUDE.md mengunci alert tidak bisa dihapus role sales — belum ada bukti audit utk enforcement ini | 1D-C (AI) + 1D-B (human ack) | missing | — |
| AI Insights (`/dashboard/ai`) | Lihat/tindak lanjut insight | Generate insight AI | Tidak ditemukan writer | Aktivitas AI belum tercatat | 1D-C | missing | — |
| Pelanggan (`/dashboard/customers`) | Create/update pelanggan, verifikasi PIC | — | `logAuditEvent` di actions; RPC PIC master/email | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/customers/actions.ts`; `supabase/migrations/20260728000001_customer_pic_master.sql`; `20260730000001_customer_pic_email.sql`; `20260728000005_fix_pic_verify_self_verify_rule.sql` |
| Produk (`/dashboard/products`) | Create/update produk | — | `logAuditEvent` di actions | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/products/actions.ts` |
| **Activity & Audit Log** (`/dashboard/owner/activity-log`) — **baru, Gate 1D-A** | Owner melihat & memfilter log (read-only, tidak ada edit/hapus) | — | N/A (reader, bukan writer) | Page-view halaman ini sendiri sengaja tidak dicatat (section H) | — | covered (fondasi reader) | `apps/web/src/app/(dashboard)/dashboard/owner/activity-log/page.tsx`; `apps/web/src/lib/audit-log/security.test.ts` |
| Automation (`/dashboard/automation`, rule-based Automation Engine) | Buat/ubah rule automation | Eksekusi rule otomatis | Tidak ditemukan writer utk perubahan rule | Aktivitas AI & human belum tercatat | 1D-C | missing | — |
| Automation Outbox / n8n (`/dashboard/automation/outbox`) | Replay job (Owner/manager) | Claim/dispatch/complete/fail job oleh n8n | RPC `INSERT audit_logs` ekstensif per transisi job | Kontrak baru belum diisi; actor system/automation belum diberi `actor_type` eksplisit | 1D-B (human replay) / 1D-C (system) | partial | `supabase/migrations/20260807000001_automation_outbox.sql`; test: `n8n-automation/outbox.integration.test.ts` |
| Pengguna (`/dashboard/users`) — termasuk Salesman, Coverage Area, Telegram Pairing (Gate 1A–1C) | Tambah/nonaktifkan salesman, atur wilayah, pairing Telegram | — | RPC `INSERT audit_logs` sangat ekstensif (Gate 1A–1C) | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/salesman/actions.ts`+`repository.ts`; `supabase/migrations/20260722000001_telegram_salesman_identity_enrollment.sql`, `20260813000001_company_coverage_area_management.sql`, `20260814000001_salesman_coverage_assignment_owner_only.sql`, `20260815000001_salesman_active_status_owner_only.sql`, `20260816000001_coverage_areas_master.sql`, `20260818000001_telegram_pairing_owner_only.sql`; test: `salesman/security.test.ts`, `coverage-area/security.test.ts`, `telegram-enrollment/security.test.ts` |
| Import Data (`/dashboard/imports`) | Upload/preview/commit/rollback import | — | `logAuditEvent` di actions; RPC commit/rollback fix | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/imports/actions.ts`; `apps/web/src/lib/settings/import-actions.ts`, `import-preview-actions.ts`; `supabase/migrations/20260801000002_legacy_import_commit_rollback.sql`, `20260801000004_fix_commit_row_count_parity.sql`, `20260803000001_fix_commit_invalid_status_type_cast.sql` |
| Pengaturan (`/dashboard/settings`, di luar Import) | Ubah pengaturan tenant (branding, dll.) | — | Tidak ditemukan writer khusus di luar Import | Aktivitas non-import belum tercatat | 1D-B | missing (untuk non-import) | — |
| Platform (`/dashboard/platform`, super_admin) | Kelola tenant | — | `logAuditEvent` di `platform/tenant-actions.ts` | Kontrak baru belum diisi | 1D-B | partial | `apps/web/src/lib/platform/tenant-actions.ts` |
| *(lintas-modul, bukan menu sidebar)* Auth & Login | Login/logout | — | `logAuditEvent` di `lib/actions/auth.ts`; writer di `app/api/auth/login-audit/route.ts`, `app/(auth)/callback/route.ts` | Belum berkategori `event_category='security'` secara eksplisit | 1D-C (security activity) | partial | `apps/web/src/lib/actions/auth.ts`; `apps/web/src/app/api/auth/login-audit/route.ts` |

## Ringkasan

- Total baris menu sidebar: 17 (Dashboard + 8 Modul + 2 Master Data + 6 Sistem,
  termasuk Activity & Audit Log baru).
- `covered`: 1 (Activity & Audit Log — fondasi reader, bukan retrofit data bisnis).
- `partial`: 9 (Sales Order, Laporan Sales, KPI Salesman, Pelanggan, Produk,
  Automation Outbox, Pengguna, Import Data, Platform).
- `missing`: 7 (Dashboard/page-view, WhatsApp AI, AI Dispatch Planner,
  Collection, Risk Alert, AI Insights, Automation rule-based, sebagian
  Pengaturan non-import).
- Gate 1D **belum PASS** secara keseluruhan — sesuai desain, retrofit
  `partial → covered` dan `missing → covered` berjalan bertahap di Gate 1D-B
  (aktivitas manusia/Owner/Salesman) dan Gate 1D-C (AI, system, automation,
  navigation, export, messaging, retry, security).
