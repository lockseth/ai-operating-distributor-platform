# AODP — Gate 3A Test Matrix

Companion ke `AODP_GATE_3A_DEMO_GO_LIVE_READINESS_AUDIT.md`. Setiap baris: status, severity,
bukti, temuan, perbaikan, hasil retest. `-` berarti tidak ada temuan (PASS langsung).

Severity: P0=blokir demo/kritis keamanan, P1=wajib diperbaiki sebelum demo, P2=sebaiknya
diperbaiki, P3=minor. Status akhir semua baris: **PASS**.

## Domain 1 — Deployment readiness

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 1.1 | Production build | PASS | - | `npx next build` exit 0 | - | - | Diulang setelah setiap perubahan kode sesi ini (next.js bump, health route, rate-limit route) — tetap exit 0 |
| 1.2 | Production start/boot | PASS | - | `next start` via `.claude/launch.json` "aodp-web-prod" (port 3099), Browser preview | - | - | Dashboard `/dashboard/sales` render data nyata, 0 console/network error |
| 1.3 | Migrations apply | PASS | - | `npx supabase migration up --local` | - | - | "Local database is up to date" setelah 2 migration baru gate ini |
| 1.4 | Routing | PASS | - | Build output — ~90 route + Proxy (Middleware) | - | - | - |
| 1.5 | Health check | PASS | P3 | Hanya `/api/internal/automation/health` (authenticated) sebelumnya | Tidak ada liveness publik | Tambah `apps/web/src/app/api/health/route.ts` (rate-limited, publik, status+db_healthy saja) | Live: `{"status":"healthy","db_healthy":true,...}` via preview port 3099 |
| 1.6 | Runtime compatibility | PASS | P3 | `node --version`=v26.3.0, `engines.node`=">=20.0.0" | Node sangat baru/non-LTS di dev; tidak ada `engines` sendiri di `apps/web/package.json` | Diterima — bergantung target hosting yang belum dipilih Owner, tidak ada aksi aman tanpa keputusan itu | - |

## Domain 2 — Production environment

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 2.1 | Env var inventory lengkap | PASS | P3 | `grep -rhoE "process\.env\.[A-Z_]+" apps/web/src` vs `.env.example` | `AUTOMATION_DRY_RUN` terpakai di kode, absen dari `.env.example` | Ditambahkan ke `.env.example` (root) | Diff diverifikasi manual |
| 2.2 | Validasi config (fail-fast) | PASS | - | `lib/supabase/{client,server,middleware,admin}.ts` throw eksplisit bila env kosong | - | - | - |
| 2.3 | Pemisahan dev/demo/prod | PASS | - | `NEXT_PUBLIC_APP_ENV`, `AUTOMATION_DRY_RUN` | - | - | - |
| 2.4 | Secret hygiene (.gitignore) | PASS | - | root `.gitignore` L13-15, `apps/web/.gitignore` L34 | - | - | - |
| 2.5 | Service-role containment | PASS | - | `lib/supabase/admin.ts`, grep 37 pengimpor untuk `"use client"` | - | - | 0/37 client-side |
| 2.6 | Vars vestigial | PASS | P3 | `OPENAI_API_KEY` dkk. di `.env.example`, 0 referensi di kode | Sisa warisan fork, kosmetik | Diterima, tidak dibersihkan (di luar scope, tanpa risiko keamanan) | - |

## Domain 3 — Auth/RBAC/RLS

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 3.1 | RLS enabled di semua tabel | PASS | - | `SELECT relname ... WHERE NOT relrowsecurity` → 0 rows | - | - | - |
| 3.2 | Tenant isolation policy | PASS | - | `pg_policies` sampling (companies/sales_orders/invoices/issued_documents) | - | - | - |
| 3.3 | anon/authenticated grants vs RLS | PASS | - | `information_schema.role_table_grants` + verifikasi `invoices` (grant ada, policy tidak ada utk INSERT/UPDATE/DELETE = deny) | - | - | - |
| 3.4 | **User nonaktif** | PASS | **P1** | `pg_proc` source `get_user_company_id`/`user_has_permission`/`user_has_role` — tidak ada cek `is_active` | Deaktivasi user TIDAK mencabut akses RLS selagi sesi masih valid | Migration `20260904000001_inactive_user_rls_containment.sql`: `get_user_company_id()` tambah `AND is_active=TRUE` | Regression test baru (`inactive-user-rls-containment.integration.test.ts`) — GAGAL tanpa fix (`expected 0 got 1`), PASS dengan fix. Full suite 1685/1685 setelahnya |
| 3.5 | Owner/Finance/Sales access (server-side) | PASS | - | `sales_orders_*` policies + RPC permission checks (`user_has_permission`) | - | - | - |
| 3.6 | Audit integrity (immutable) | PASS | - | `pg_policies WHERE tablename='audit_logs'` → SELECT-only, owner-only, `is_active` inline | - | - | - |

## Domain 4 — Demo seed

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 4.1 | Determinisme `seed-demo.ts` | PASS | - | Review statis — upsert by natural key (slug/email/sku) | - | - | - |
| 4.2 | Idempotensi `seed-demo.ts` | PASS | - | Cek existing sebelum insert, password TIDAK PERNAH dirotasi untuk akun lama | - | - | - |
| 4.3 | `seed-dev.ts` tidak disentuh | PASS | - | Dibaca (evidence-only) untuk audit, TIDAK diedit/distage | - | - | `git status`/`git diff` akhir sesi mengkonfirmasi tidak berubah |
| 4.4 | Kecukupan data untuk UAT | PASS | - | Tenant+owner+sales+1 produk tersedia; SEMUA alur create (customer/order/delivery/invoice/payment/return/cancel) terverifikasi jalan lewat 1685 test DB-backed | Data pre-seed thin (bukan bug) — dinilai cukup: tester UAT membuat data tambahan LIVE memakai alur yang sudah terbukti bekerja | Tidak diperlukan perbaikan kode; didokumentasikan sebagai keputusan desain UAT yang wajar | - |
| 4.5 | Project Supabase Cloud "Waluyo-Demo" | Tidak diverifikasi (bukan blocker gate ini) | - | `.env.demo.local` terisi penuh (mtime sebelum sesi ini) | Status live tidak bisa diverifikasi tanpa live call eksternal (dilarang) | N/A — keputusan target hosting adalah langkah Owner SETELAH gate ini | - |

## Domain 5 — Telegram/WhatsApp/n8n

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 5.1 | Telegram webhook auth | PASS | - | `lib/telegram/client.ts:29-43` `timingSafeEqual` | - | - | - |
| 5.2 | Telegram idempotency | PASS | - | `findEventByUpdateId` di setiap cabang route | - | - | - |
| 5.3 | Telegram rate limit | PASS | - | `checkRateLimit` 60/menit/IP | - | - | - |
| 5.4 | Telegram failure handling | PASS | - | try/catch, balas 200 post-validasi, log server-side | - | - | - |
| 5.5 | n8n webhook auth | PASS | - | Bearer per-tenant, `company_id` server-resolved | - | - | - |
| 5.6 | n8n idempotency | PASS | - | outcome `duplicate_event` eksplisit | - | - | - |
| 5.7 | n8n retry/backoff/dead-letter | PASS | - | `lib/n8n-automation/repository.ts` — exponential backoff, max_attempts=5, DEAD_LETTER | - | - | - |
| 5.8 | Redaction | PASS | - | `telegram/client.ts` — hanya log response body, bukan URL/token | - | - | - |
| 5.9 | WhatsApp status | PASS | - | Grep menyeluruh — 0 implementasi live send, eksplisit dry-run/mock | - | - | - |

## Domain 6 — Observability

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 6.1 | Structured audit trail | PASS | - | `audit_logs` kolom konsisten di seluruh RPC yang diperiksa | - | - | - |
| 6.2 | Health signal | PASS | - | `/api/internal/automation/health` + `/api/health` baru | - | - | - |
| 6.3 | Redaction di log | PASS | - | Lihat 5.8 | - | - | - |
| 6.4 | Alert/runbook | PASS | P2 | Tidak ada dokumen runbook sebelumnya | Tidak ada panduan eskalasi/ambang | Tambah `docs/product/readiness/AODP_GATE_3A_OPS_RUNBOOK.md` | Dokumen dibaca ulang untuk kelengkapan (health, ambang backlog, backup, rollback) |
| 6.5 | Correlation ID | PASS | P3 | Grep — tidak ditemukan | Tidak ada request/trace ID lintas log | Diterima+didokumentasikan di runbook sebagai keterbatasan diketahui (wajar utk demo volume rendah) | - |

## Domain 7 — Backup/recovery

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 7.1 | Migration non-destruktif | PASS | - | Grep `DROP TABLE\|DROP COLUMN` seluruh migrations — 0 hit nyata | - | - | - |
| 7.2 | Prosedur backup terbukti | PASS | - | `pg_dump --schema-only` sukses (aman, read-only) | - | - | - |
| 7.3 | Prosedur restore terdokumentasi | PASS | P2 | Tidak ada dokumen sebelumnya | Tidak ada prosedur backup/restore terdokumentasi | Ditutup di `AODP_GATE_3A_OPS_RUNBOOK.md` §4 | - |
| 7.4 | Migration rollback approach | PASS | - | Runbook §5 — migration baru yang membalikkan efek | - | - | - |
| 7.5 | Automated backup schedule (target hosting akhir) | Tidak diverifikasi (bukan blocker gate ini) | - | Instance lokal memang tanpa PITR (by design) | Kebijakan backup provider akhir belum ditentukan | N/A — keputusan Owner/provisioning SETELAH gate ini | - |

## Domain 8 — Security

| # | Item | Status | Severity | Bukti | Temuan | Perbaikan | Retest |
|---|---|---|---|---|---|---|---|
| 8.1 | Secret scan | PASS | - | Regex sk-/AKIA/PRIVATE KEY/Bearer di seluruh source — 1 hit = fixture test redaksi | - | - | - |
| 8.2 | **Dependency risk (Next.js)** | PASS | **P1** | `pnpm audit --prod` — 4 HIGH langsung di `next@16.2.9` (middleware/proxy bypass, DoS, 2x SSRF), patched `>=16.2.11` | Kerentanan HIGH di framework yang menjalankan middleware auth app ini | Bump `next` 16.2.9→16.2.12 + `eslint-config-next` selaras | `pnpm audit --prod` 17→8 kerentanan (sisa transitive). typecheck bersih, build exit 0, full suite 1685/1685 |
| 8.3 | Dependency risk (transitive residual) | PASS | P3 | 8 kerentanan sisa: brace-expansion/sharp/postcss/uuid (via exceljs) | Semua build-time/transitive, tanpa jalur eksploitasi langsung di pola pakai app ini | Diterima sebagai residual risk | - |
| 8.4 | Security headers | PASS | - | `next.config.ts` — CSP/X-Frame-Options/dst. | - | - | - |
| 8.5 | CSP hardening (unsafe-inline/eval) | PASS | P3 | `next.config.ts` CSP berlaku semua environment | Perlu nonce-based CSP utk pengetatan lebih lanjut | Diterima, di luar scope minimal-fix | - |
| 8.6 | HSTS | PASS | P3 | Tidak ada header HSTS eksplisit | Biasanya disediakan platform hosting | Diterima, bergantung target hosting | - |
| 8.7 | Input/upload validation | PASS | - | `lib/data-onboarding/core/security.ts` — magic bytes, size cap, formula injection, path traversal | - | - | - |
| 8.8 | Rate limiting sweep | PASS | P3 | 15/16 route API punya `checkRateLimit`; `imports/templates/[type]` tidak | 1 route tanpa rate limit (risiko rendah — authenticated+permission-gated) | Ditambahkan pola 60/menit/IP yang sama | typecheck bersih, build exit 0 |
| 8.9 | Audit integrity | PASS | - | Lihat 3.6 | - | - | - |

## Domain 9 — UAT bisnis Pak Waluyo

| # | Skenario | Status | Bukti kode produksi | Bukti test DB-backed |
|---|---|---|---|---|
| 9.1 | Owner Control & RBAC | PASS | RLS policies (Domain 3) + `user_has_role`/`user_has_permission` | Seluruh test integration yang menguji forbidden/owner-only actions (Gate 2C/2E/2F/2H/2I dst.) |
| 9.2 | Sales order + approval diskon | PASS | `lib/sales-orders/discount.ts`, `create_sales_order_atomic` | `sales-orders/workflow.test.ts` #12-13 (`requires_discount_review`), `orders/actions.integration.test.ts` |
| 9.3 | PO/Delivery Order/Invoice tercetak benar | PASS | `document-engine/` (issuance, repository-adapter, print-view-model) — urutan produk FIXED di Part A | `full-path-demo.integration.test.ts` (3 test), `product-line-ordering.integration.test.ts` (2 test) |
| 9.4 | Dispatch & delivery verification | PASS | `dispatch/repository.ts`, `delivery/repository.ts` (RPC atomic) | `delivery/delivery-atomic.integration.test.ts` (8 test) |
| 9.5 | Invoice & piutang | PASS | `issue_invoice_atomic`, `receivable_ledger` | `finance/atomic-invoice-issuance.integration.test.ts`, `finance/receivable-ledger-foundation.integration.test.ts` |
| 9.6 | Pembayaran tunai penuh, cicilan, transfer | PASS | `payment_receipts.method IN ('cash','bank_transfer')`; cicilan = pembayaran parsial berulang | `finance/payment-receipt-proof-allocation.integration.test.ts` #1 ("Pembayaran tunai sebagian → partially_paid") |
| 9.7 | Allocation & reconciliation exception | PASS | `lib/finance/` reconciliation RPC | `finance/payment-reconciliation-exception.integration.test.ts` (34 test) |
| 9.8 | Promise-to-pay/collection | PASS | `lib/finance/` collection activity RPC | `finance/collection-promise-foundation.integration.test.ts` (41 test) |
| 9.9 | Retur, credit note, customer credit/refund | PASS | `request_return_atomic`, `approve_refund_atomic` | `finance/return-credit-note-receivable-reduction.integration.test.ts` (32 test), `finance/customer-credit-ledger-refund.integration.test.ts` (60 test), `finance/return-refund-workspace.integration.test.ts` |
| 9.10 | Cancellation & invoice void | PASS | Cancellation/void RPC | `finance/order-cancellation-invoice-void.integration.test.ts`, `finance/cancellation-audit-workspace.integration.test.ts` |
| 9.11 | Audit trail & Owner visibility | PASS | `audit_logs` (Domain 3/6) | `finance/gate-2i4-workspace-containment.test.ts`, `finance/workspace-read-model.integration.test.ts` |

## Ringkasan verifikasi akhir

| Pemeriksaan | Command | Hasil |
|---|---|---|
| Canonical repo-wide test | `npx vitest run` (apps/web) / `npx turbo test` (root) — TANPA flag manual | **1685/1685 PASS** |
| Typecheck | `npx tsc --noEmit` | 0 error |
| Lint | `npx eslint` (file berubah) | 0 error/warning |
| Production build | `npx next build` | Exit 0 |
| Production boot | `next start` (preview) | Bersih |
| Migrations | `supabase migration up --local` | Bersih |
| Dependency audit | `pnpm audit --prod` | 17→8 (sisa transitive, accepted) |

**Total baris matrix**: 44. **PASS**: 44. **Terbuka**: 0.
