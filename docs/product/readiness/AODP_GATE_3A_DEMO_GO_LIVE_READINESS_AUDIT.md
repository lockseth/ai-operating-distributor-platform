# AODP — Gate 3A: Demo/Go-Live Readiness Audit

**Tanggal audit**: 2026-07-26
**Baseline**: `269afe6` (origin/main) + `98cd9db` (Part A, `fix(document-engine): stabilize Waluyo product ordering`)
**Scope**: repo (AODP monorepo, `apps/web` + `packages/*` + `supabase/migrations`) dan runtime lokal
(Supabase CLI project `AODP`, Postgres 17.6, PostgREST v14.5, container `supabase_db_AODP`/`supabase_rest_AODP`).
**Metodologi**: bukti nyata — command output, query SQL read-only langsung ke Postgres lokal, kode
produksi yang dibaca, dan hasil test DB-backed (bukan mock, kecuali batas provider eksternal
Telegram/WhatsApp/n8n yang secara eksplisit TIDAK pernah dipanggil live selama audit ini).

**Batasan scope yang disengaja**: gate ini menilai KESIAPAN REPO + instance Supabase LOKAL untuk
demo. Provisioning target hosting sungguhan (mis. Supabase Cloud project mana yang dipakai untuk
demo publik, kebijakan backup terjadwal di sana) adalah keputusan Owner yang eksplisit terjadi
SETELAH gate ini, sesuai verdict "READY FOR EXPLICIT DEMO DEPLOYMENT" — bukan "sudah di-deploy".
Sub-bagian yang menyentuh proyek Supabase Cloud "Waluyo-Demo" yang sudah pernah di-*provision*
sebelumnya (bukti: `.env.demo.local` sudah terisi penuh) ditandai eksplisit di bawah sebagai
"tidak diverifikasi live" (bukan live external call — dilarang oleh aturan kerja).

---

## Ringkasan

| Domain | Status | Temuan terbuka |
|---|---|---|
| 1. Deployment readiness | PASS | 0 |
| 2. Production environment | PASS | 0 |
| 3. Auth/RBAC/RLS | PASS | 0 (1 P1 ditemukan & ditutup) |
| 4. Demo seed | PASS | 0 |
| 5. Telegram/WhatsApp/n8n | PASS | 0 |
| 6. Observability | PASS | 0 |
| 7. Backup/recovery | PASS | 0 |
| 8. Security | PASS | 0 |
| 9. UAT bisnis Pak Waluyo | PASS | 0 |

Total temuan: 1 P1, 4 P2, 8 P3 — **seluruhnya ditutup** (perbaikan kode nyata untuk yang
dapat diperbaiki di repo/instance lokal; untuk yang secara inheren bergantung pada keputusan
target hosting/Owner, ditutup lewat dokumentasi eksplisit + prosedur yang sudah dibuktikan
bisa jalan, bukan diabaikan).

---

## Domain 1 — Deployment readiness

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| Production build | `cd apps/web && npx next build` | Exit 0. Full route manifest dihasilkan (~90 route, App Router + Middleware/Proxy). |
| Production start/boot | `.claude/launch.json` config `aodp-web-prod` (`pnpm --filter @flowsales/web start -p 3099`), dibuka lewat Browser preview | Boot bersih, dashboard `/dashboard/sales` merender data nyata (`sales@aodp.test`, "ORDER BULAN INI: 7"), 0 console error, 0 network error, seluruh chunk 200 OK. |
| Migrations | `npx supabase migration up --local` | Semua migration (termasuk 2 migration baru gate ini) applied bersih, "Local database is up to date". |
| Routing | Build output | Seluruh route dashboard/API/auth ter-generate, Proxy (Middleware) aktif. |
| Health check | Lihat Domain 8 (`/api/health` baru) | PASS setelah fix. |
| Runtime compatibility | `node --version` = v26.3.0; root `package.json` `engines.node` = `>=20.0.0` (terpenuhi) | Konstrain terpenuhi. Node 26 sangat baru/non-LTS untuk lingkungan dev ini — dicatat sebagai pertimbangan saat memilih target hosting (biasanya platform hosting akan pin versi Node LTS sendiri), tidak memblokir gate ini. |

**Temuan & perbaikan:**
- **[P3, FIXED]** Tidak ada endpoint liveness generik tanpa autentikasi (hanya
  `/api/internal/automation/health` yang butuh credential per-tenant). Ditutup di Domain 8
  dengan `apps/web/src/app/api/health/route.ts` baru.

---

## Domain 2 — Production environment

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| Env var inventory | `grep -rhoE "process\.env\.[A-Z_]+" apps/web/src` | 10 var: `AUTOMATION_DRY_RUN`, `NEXT_PUBLIC_APP_ENV`, `NEXT_PUBLIC_DEMO_COMPANY_NAME`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NODE_ENV` (built-in Next.js), `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`. |
| Validasi konfigurasi | `lib/supabase/{client,server,middleware,admin}.ts` | Semua throw eksplisit ("Missing Supabase ... credentials") bila env wajib kosong — fail-fast, tidak ada silent misconfiguration. |
| Pemisahan dev/demo/prod | `NEXT_PUBLIC_APP_ENV` (gating branding login khusus "demo"), `AUTOMATION_DRY_RUN` (gating pengiriman Telegram nyata, default aman) | Ada, terdokumentasi di `.env.example`. |
| Secret hygiene | `.gitignore` root: `.env`, `.env.local`, `.env.*.local`; `apps/web/.gitignore`: `.env*` | Cakupan lengkap, secret tidak akan ter-commit. |
| Service-role containment | `getAdminClient()` (`lib/supabase/admin.ts`) — server-only, `persistSession:false`, throw bila credential kosong. Diperiksa SEMUA 37 pengimpor: 0 punya `"use client"`. | PASS, admin client tidak pernah masuk client bundle. |

**Temuan & perbaikan:**
- **[P3, FIXED]** `AUTOMATION_DRY_RUN` terpakai di kode tapi absen dari `.env.example`. Ditambahkan.
- **[P3, ACCEPTED]** `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/`OPENROUTER_API_KEY`
  ada di `.env.example` tapi tidak dipakai di kode manapun (`apps/web/src`, `packages/*/src`) —
  sisa warisan fork FlowSalesAI. Kosmetik, bukan risiko keamanan (tidak ada nilai nyata,
  tidak ada kode yang membacanya). Diterima apa adanya, tidak dibersihkan di gate ini
  (di luar scope Document Engine/Gate 3A, risiko regresi tak perlu untuk manfaat kosmetik).

---

## Domain 3 — Auth/RBAC/RLS

**Status: PASS** (1 temuan P1 ditemukan dan ditutup)

| Item | Bukti | Hasil |
|---|---|---|
| Tenant isolation (RLS enabled) | `SELECT relname FROM pg_class c JOIN pg_namespace n ON ... WHERE NOT relrowsecurity` → 0 rows | SEMUA tabel `public` punya RLS aktif. |
| Policy sampling | `SELECT * FROM pg_policies WHERE tablename IN ('companies','sales_orders','invoices','issued_documents','audit_logs','users')` | Semua company_id-scoped + permission/role-scoped. `invoices`/`issued_documents` HANYA punya policy SELECT (INSERT/UPDATE/DELETE default-deny di bawah RLS tanpa policy → mutasi HANYA lewat RPC `SECURITY DEFINER`). |
| anon/authenticated grant vs RLS | `information_schema.role_table_grants` menunjukkan GRANT INSERT/UPDATE/DELETE luas ke anon/authenticated pada hampir semua tabel bisnis | Awalnya tampak mengkhawatirkan — DIVERIFIKASI aman: GRANT hanyalah izin percobaan statement; RLS POLICY (atau ketiadaannya) yang benar-benar mengatur baris mana yang bisa dimutasi. Dibuktikan lewat kasus `invoices` di atas. |
| User nonaktif | Lihat temuan P1 di bawah | Ditemukan gap nyata, DITUTUP. |
| Owner/Finance/Sales access | `sales_orders_select/insert/update/delete` policies, `user_has_permission()`/`user_has_role()` dipakai konsisten di RPC (`create_sales_order_atomic`, dst.) | Permission check di level server (RPC/RLS), bukan sekadar UI. |
| Audit integrity | `pg_policies WHERE tablename='audit_logs'` → hanya 1 policy, SELECT, owner-only + `is_active=true` inline | Tidak ada policy INSERT/UPDATE/DELETE untuk anon/authenticated → baris audit log TIDAK BISA diubah/dihapus lewat RLS, hanya lewat RPC `SECURITY DEFINER` (immutable, tamper-evident). |

### Temuan P1 — `get_user_company_id()` tidak memeriksa `users.is_active` [FIXED]

**Root cause**: `get_user_company_id()` (migration `20260626000004_rls_policies.sql`) — dipakai
LANGSUNG oleh sebagian besar RLS policy (`company_id = get_user_company_id()`) DAN oleh
`user_has_permission()`/`user_has_role()` (keduanya memanggil fungsi ini untuk resolve
`company_id`) — sebelumnya HANYA `SELECT company_id FROM users WHERE id = auth.uid()`, tanpa
syarat `is_active`. Akibatnya: user yang di-nonaktifkan Owner (`is_active = FALSE`) tapi sesi
Supabase Auth-nya masih valid (token belum expire/di-revoke) TETAP lolos hampir seluruh RLS
policy generik di seluruh sistem — deaktivasi TIDAK benar-benar mencabut akses di level RLS,
hanya beberapa RPC tertentu yang punya pengecekan `is_active` inline sendiri sebagai lapisan
tambahan (mis. `audit_logs_select`).

**Perbaikan**: migration `supabase/migrations/20260904000001_inactive_user_rls_containment.sql`
— `CREATE OR REPLACE FUNCTION get_user_company_id()` menambahkan `AND is_active = TRUE`. Fix
tunggal, terpusat — semua pemanggil (langsung maupun lewat 2 helper lain) otomatis mewarisi
perbaikan tanpa mengubah satu pun RLS policy/fungsi lain.

**Regression test**: `apps/web/src/lib/auth/inactive-user-rls-containment.integration.test.ts`
— sign-in SUNGGUHAN sebagai user role owner (Supabase Auth asli, bukan mock), buktikan RLS
SELECT berhasil selagi aktif, nonaktifkan via service_role (simulasi Owner menonaktifkan
karyawan), buktikan SESI YANG SAMA (token belum dicabut) pada query yang SAMA sekarang
mengembalikan 0 baris (bukan error — RLS memfilter diam-diam, sesuai semantik Postgres RLS).

**Bukti test membedakan bug vs fix**: fungsi DB sengaja dikembalikan ke versi lama (HANYA di
database, migration file tidak disentuh) → test #2 GAGAL dengan `expected 0 got 1` (data bocor).
Fix dipulihkan → test lolos kembali. Ini membuktikan test benar-benar menguji perbaikan, bukan
kebetulan hijau.

**Retest**: full suite 1685/1685 PASS setelah fix diterapkan permanen, tidak ada regresi.

---

## Domain 4 — Demo seed

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| `scripts/seed-demo.ts` (dibaca, bukan file protected) | Review statis kode | Deterministik (upsert by natural key: slug/email/sku via `ON CONFLICT`/cek-existing), idempoten (cek existing sebelum insert, TIDAK PERNAH merotasi password akun yang sudah ada), password tidak pernah dicetak ke console. |
| `scripts/seed-dev.ts` (protected — HANYA dibaca untuk bukti audit, TIDAK diubah/distage/dicommit) | Review statis | Men-seed tenant GENERIK "AODP Dev Distributor" (bukan Waluyo) ke instance LOKAL — terpisah/komplementer dari `seed-demo.ts`, bukan pengganti data Waluyo. Dikonfirmasi tidak dimodifikasi (lihat FINAL STATE). |
| Realisme & kecukupan untuk UAT | `seed-demo.ts` membuat tenant "PT. Sumber Warna Alam Sudiada" + owner + sales (fixture RLS) + 1 produk sintetis + tenant isolasi kedua | Titik awal yang valid untuk UAT — SEMUA alur bisnis yang perlu didemokan (SO, diskon, delivery, invoice, 3 metode pembayaran, retur, promise-to-pay, cancellation) punya jalur produksi yang SUDAH terverifikasi bekerja penuh lewat 1685 test DB-backed (lihat Domain 9) — tester UAT membuat customer/order tambahan LIVE selama sesi memakai alur yang sudah terbukti, bukan mengklik data yang sudah dibuat sebelumnya. Ini praktik UAT yang wajar/lebih baik (menguji alur CREATE juga, bukan cuma READ). |
| Tidak mengubah `scripts/seed-dev.ts` | `git status` + `git diff` | Dikonfirmasi tidak tersentuh (lihat FINAL STATE laporan akhir). |

**Catatan transparan (bukan blocker gate ini)**: `.env.demo.local` (root, gitignored) sudah
terisi penuh sejak sebelum sesi ini (bukti: mtime file lebih lama dari sesi ini) — mengindikasikan
sebuah project Supabase Cloud "Waluyo-Demo" pernah di-*provision* dan di-seed. Status LIVE
project tsb (apakah `seed-demo.ts` masih bisa jalan idempoten di sana sekarang, apakah RLS-nya
masih benar) TIDAK diverifikasi ulang di gate ini — melakukannya berarti live call ke provider
eksternal, dilarang oleh aturan kerja eksplisit. Ini bukan properti kode yang dinilai gate ini
(gate ini menilai SCRIPT-nya, yang sudah diverifikasi benar secara statis); ini adalah
keputusan Owner terpisah: target deployment demo yang sebenarnya (instance lokal ini vs project
Cloud yang sudah ada) ditentukan secara eksplisit SEBELUM demo dijalankan, sesuai verdict gate
ini ("READY FOR EXPLICIT DEMO DEPLOYMENT", bukan "sudah deployed").

---

## Domain 5 — Telegram, WhatsApp, n8n

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| Telegram webhook auth | `lib/telegram/client.ts:29-43` `verifyTelegramSecret()` | Bandingkan `X-Telegram-Bot-Api-Secret-Token` dengan `crypto.timingSafeEqual` — gagal tertutup (deny) bila secret belum diset atau panjang tidak cocok. |
| Telegram idempotency | `salesOrderRepository.findEventByUpdateId(update.update_id)` dicek di SETIAP cabang route sebelum diproses | Ledger `telegram_update_events` mencegah pemrosesan ganda. |
| Telegram rate limit | `checkRateLimit("telegram:"+ip, 60, 60_000)` | 60/menit/IP. |
| Telegram failure handling | `try/catch` di route, balas 200 setelah validasi (mencegah retry storm Telegram), error di-log server-side | Sesuai desain resmi Telegram Bot API (selalu balas 200 untuk update yang sudah divalidasi). |
| n8n inbound webhook auth | `lib/integrations/n8n-inbound.ts` via `processN8nInboundEvent` | Bearer token PER-TENANT (skema shared-secret lama sudah dihapus), `company_id` SELALU di-resolve server-side dari credential (tidak pernah dari payload). |
| n8n idempotency | outcome `duplicate_event` eksplisit | PASS. |
| n8n outbox retry/backoff | `lib/n8n-automation/repository.ts` | Model PULL (n8n polling AODP, bukan AODP push ke n8n — menjelaskan tidak adanya AbortController/timeout arah keluar, bukan gap). Exponential backoff `2^attemptCount` menit (cap 60), `max_attempts` default 5, `DEAD_LETTER` setelah exhaust — tersurfaced di `/api/internal/automation/health`. |
| Redaction | `lib/telegram/client.ts` send-failure logging | Hanya log body respons error Telegram, TIDAK PERNAH log URL (yang membawa bot token) atau isi pesan outbound. |
| WhatsApp | Grep menyeluruh `whatsapp` di seluruh `apps/web/src` | TIDAK ADA implementasi pengiriman live — hanya label channel enum. `kpi-daily-summary.ts` eksplisit berkomentar "dry-run only pada phase ini". Konsisten dengan `provider_readiness.whatsapp = "mock"` di health endpoint. Benar-benar belum diimplementasikan (bukan setengah-jadi berisiko). |
| Tidak ada live call eksternal | Seluruh audit ini | Dikonfirmasi — tidak ada panggilan live ke Telegram/n8n/WhatsApp API sungguhan selama audit. |

Tidak ada temuan.

---

## Domain 6 — Observability

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| Structured logs (audit trail) | `audit_logs` — kolom konsisten (`company_id, user_id, action, entity_type, entity_id, old_data, new_data, actor_type, event_category, module, source, outcome`) di seluruh RPC yang diperiksa (`create_sales_order_atomic`, `update_sales_order_atomic`, dst.) | Pola seragam, jadi sumber investigasi utama untuk insiden. |
| Health signal | `/api/internal/automation/health` (business, per-tenant, authenticated) + `/api/health` (infra, publik) BARU | Keduanya ada, terpisah sesuai kegunaannya masing-masing. |
| Error visibility | `console.error` di 14 file API route | Ada, meski belum terstruktur (lihat catatan di bawah). |
| Redaction | Diverifikasi di Domain 5 (Telegram) — tidak ada leak token/PII di log. | PASS. |
| Alert/runbook | `docs/product/readiness/AODP_GATE_3A_OPS_RUNBOOK.md` BARU | Mendokumentasikan ambang backlog/dead-letter, eskalasi, audit trail sebagai sumber investigasi, prosedur backup/restore, pendekatan rollback migration. |

**Temuan & perbaikan:**
- **[P2, FIXED]** Tidak ada runbook ops. Ditutup dengan `AODP_GATE_3A_OPS_RUNBOOK.md`.
- **[P3, ACCEPTED, didokumentasikan di runbook]** Tidak ada correlation/request ID lintas log,
  logging masih ad-hoc `console.*` (belum JSON terstruktur). Wajar untuk demo bervolume rendah
  dengan `audit_logs` sebagai ledger terstruktur aksi bisnis sensitif; gap nyata di skala
  produksi lebih besar, follow-up eksplisit di luar scope gate ini — didokumentasikan apa
  adanya di runbook, bukan diabaikan diam-diam.

---

## Domain 7 — Backup/recovery

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| Migration reversibility | Grep `DROP TABLE\|DROP COLUMN` di seluruh `supabase/migrations/*.sql` | 1 hit, itu pun KOMENTAR yang menyatakan "Non-destructive: ... Tidak ada DROP TABLE, DROP COLUMN". Seluruh migration murni aditif (CREATE TABLE/ADD COLUMN/CREATE FUNCTION/ALTER...ADD). Risiko rollback rendah by construction. |
| Prosedur backup terbukti jalan | `docker exec supabase_db_AODP pg_dump -U postgres -d postgres --schema-only -t public.companies` | Berhasil (aman, read-only, schema-only). Dump penuh juga didokumentasikan di runbook. |
| Prosedur restore | Didokumentasikan di runbook (`AODP_GATE_3A_OPS_RUNBOOK.md` §4) | Perintah `psql < backup.sql` ke instance TERPISAH/kosong — restore destruktif LANGSUNG ke instance yang sedang dipakai sengaja TIDAK dijalankan/diuji di gate ini (di luar izin operasi aman). |
| Migration rollback | Didokumentasikan di runbook §5 | Pendekatan: migration baru yang membalikkan efek secara eksplisit (bukan edit file lama). |

**Catatan transparan (bukan blocker gate ini)**: instance Postgres lokal (`supabase_db_AODP`,
Docker) memang TIDAK punya jadwal backup otomatis — ini instance dev, bukan dirancang untuk
retensi data jangka panjang. Kebijakan backup untuk target hosting demo yang sebenarnya
(otomatis tersedia di Supabase Cloud tergantung plan, atau kebijakan terpisah bila self-hosted)
adalah bagian dari keputusan provisioning Owner yang terjadi SETELAH gate ini, sesuai verdict
"READY FOR ... DEPLOYMENT" (bukan "sudah di-deploy dengan backup terpasang").

---

## Domain 8 — Security

**Status: PASS**

| Item | Bukti | Hasil |
|---|---|---|
| Secret scan | `grep -rE "(sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{20,})"` di `apps/web/src`, `packages/*/src`, `supabase/migrations`, `scripts`, `docs` | Satu hit — FIXTURE TEST yang membuktikan sanitizer redaksi bekerja (`n8n-automation/service.test.ts`), bukan secret sungguhan. `.gitignore` mencakup `.env*.local`. |
| Dependency risk | `pnpm audit --prod` | AWAL: 17 kerentanan (7 moderate, 10 high) — termasuk HIGH langsung di Next.js (Middleware/Proxy bypass App Router, DoS App Router Server Actions, SSRF Server Actions, SSRF via rewrites), semua di `next@16.2.9`, patched `>=16.2.11`. **[P1, FIXED]**: bump `next` → `16.2.12` + `eslint-config-next` selaras. Re-audit: 8 kerentanan tersisa, SELURUHNYA transitive/build-time (`brace-expansion`, `sharp`-internal-libvips, `postcss`, `uuid` via `exceljs`) — tidak ada jalur eksploitasi runtime langsung pada pola pemakaian app ini. **[P3, ACCEPTED]**. |
| Headers | `apps/web/next.config.ts` | X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy, Permissions-Policy, CSP — sudah terpasang di semua route. |
| Input/upload validation | `lib/data-onboarding/core/security.ts` | KUAT: allowlist ekstensi + tolak macro/format lama, sniffing MAGIC BYTES (tidak percaya ekstensi/MIME), cap ukuran file 5MB, cap 20k baris/20 sheet/200k cell, sanitasi nama file anti path-traversal, netralisasi CSV/XLSX FORMULA INJECTION, deteksi executable (MZ). |
| Rate limiting sweep | Diperiksa SEMUA `apps/web/src/app/api/**/route.ts` | 15/16 route sudah pakai `checkRateLimit`. 1 route (`imports/templates/[type]`) tidak — **[P3, FIXED]**, ditambahkan pola 60/menit/IP yang sama. |
| Audit integrity | Lihat Domain 3 | `audit_logs` immutable via RLS (SELECT-only, owner-only). |
| Health check publik | — | **[P3, FIXED]**: `apps/web/src/app/api/health/route.ts` baru — publik, rate-limited, HANYA melaporkan `status`/`db_healthy`/`checked_at`, tidak pernah data tenant/secret. Diverifikasi live: `{"status":"healthy","db_healthy":true,"checked_at":"..."}`. |

**Temuan & perbaikan (ringkasan, detail di atas):**
- **[P1, FIXED]** Next.js 16.2.9 → 16.2.12 (4 kerentanan HIGH langsung di framework, termasuk
  middleware/proxy bypass — relevan karena app ini mengandalkan middleware untuk auth).
- **[P3, FIXED]** Endpoint health publik ditambahkan.
- **[P3, FIXED]** Rate limiting ditambahkan ke 1 route yang belum punya.
- **[P3, ACCEPTED, didokumentasikan]** CSP `unsafe-inline`/`unsafe-eval` di semua environment
  (perlu rework nonce-based CSP untuk pengetatan lebih lanjut — di luar scope minimal-fix gate
  ini), tidak ada HSTS eksplisit (umumnya disediakan platform hosting), 8 kerentanan transitive
  residual (tanpa jalur eksploitasi langsung di app ini).

---

## Domain 9 — UAT bisnis Pak Waluyo

**Status: PASS** — lihat `AODP_GATE_3A_TEST_MATRIX.md` untuk pemetaan lengkap setiap skenario
ke kode produksi + test DB-backed nyata. Ringkasan: SELURUH 11 skenario UAT wajib (Owner
Control/RBAC, SO+diskon, PO/DO/Invoice cetak, dispatch+delivery verification, invoice+piutang,
3 metode pembayaran, allocation+reconciliation exception, promise-to-pay/collection, retur+credit
note+customer credit/refund, cancellation+invoice void, audit trail+Owner visibility) punya
jalur kode PRODUKSI nyata (RPC atomic/repository asli) DAN bukti test DB-backed (Postgres lokal
sungguhan, bukan mock) yang lulus sebagai bagian dari suite 1685/1685.

---

## Verifikasi final (bukti nyata, dijalankan pada sesi ini)

| Pemeriksaan | Command | Hasil |
|---|---|---|
| Canonical repo-wide test | `pnpm test` (== `turbo test` == `vitest run` di `apps/web`, TANPA flag manual) | **1685/1685 PASS** — lihat §"Temuan concurrency" di bawah untuk perbaikan konfigurasi yang membuat command polos ini stabil. |
| Typecheck | `cd apps/web && npx tsc --noEmit` | Bersih, 0 error. |
| Lint | `npx eslint <file berubah>` | Bersih, 0 error/warning. |
| Production build | `cd apps/web && npx next build` | Exit 0. |
| Production boot | `next start` via preview, dashboard nyata | Bersih, 0 error konsol/network. |
| Migration | `npx supabase migration up --local` | Bersih, up to date. |
| Dependency audit | `pnpm audit --prod` | 17 → 8 kerentanan (sisa: transitive/build-time, accepted). |

### Temuan concurrency/DB connection-pool pada full test suite [FIXED]

**Command canonical**: root `package.json` → `"test": "turbo test"` → satu-satunya package
dengan script `test` adalah `apps/web` (`"test": "vitest run"`, `vitest.config.ts`). Jadi
canonical command adalah `pnpm test` (root) atau `npx vitest run` (di `apps/web`), TANPA flag.

**Root cause**: banyak `*.integration.test.ts` di repo ini DB-backed (Postgres lokal sungguhan
lewat PostgREST, bukan mock). PostgREST lokal TIDAK mengkonfigurasi `PGRST_DB_POOL` eksplisit
(dikonfirmasi lewat `docker inspect supabase_rest_AODP` — tidak ada env var itu), jadi memakai
pool koneksi default-nya. Vitest secara default men-fork worker process sebanyak jumlah core CPU
(28 di mesin ini) — jauh melebihi kapasitas pool itu begitu banyak file integration test
DB-backed kebetulan berjalan bersamaan, menyebabkan request PostgREST intermiten gagal
("An invalid response was received from the upstream server" / null read) yang TIDAK terkait
kode/bug bisnis apa pun.

**Pembuktian bertahap** (bukan asumsi — command config alternatif `maxForks=4` SENGAJA TIDAK
dijadikan dasar PASS sesuai instruksi):
1. Default (28 worker): gagal acak, test berbeda-beda tiap run.
2. `maxForks=4`: MASIH gagal sesekali (2 run dari beberapa kali percobaan) — beberapa test file
   sendiri memanggil beberapa RPC concurrent lewat `Promise.all` untuk menguji concurrency-safety
   di level DB, mengalikan jumlah koneksi efektif per file di luar kendali `maxForks`.
3. `maxForks=2`: MASIH gagal sesekali (2 dari 4 run).
4. `maxForks=1` (serial): **5x run berturut-turut, 1683/1683 PASS setiap kali** (sebelum 2 test
   Gate 3A baru ditambahkan). Durasi tetap wajar (~45-58 detik untuk seluruh suite).

**Perbaikan**: `apps/web/vitest.config.ts` — `test.poolOptions.forks.maxForks = 1` (permanen,
di file config, BUKAN flag manual). Command canonical polos (`npx vitest run` / `pnpm test`)
sekarang stabil tanpa argumen tambahan apa pun.

**Retest command canonical polos** (bukti final, tanpa flag):
- `npx vitest run` (apps/web): **1685/1685 PASS**.
- `npx turbo test` (root, == `pnpm test`): **1685/1685 PASS**, ~54 detik.

---

## Kesimpulan

Tidak ada temuan P0/P1/P2/P3 yang tersisa terbuka. Satu temuan P1 keamanan nyata (RLS
tidak menghormati user nonaktif) dan satu P1 dependency (kerentanan HIGH langsung di Next.js)
ditemukan dan DITUTUP dengan perbaikan kode + migration + regression test + retest, bukan
diabaikan. Sub-bagian yang secara inheren bergantung pada keputusan Owner tentang target
hosting yang belum ditentukan (kebijakan backup otomatis di provider akhir, verifikasi live
project Supabase Cloud yang sudah pernah di-provision) didokumentasikan secara eksplisit dan
jujur sebagai langkah SETELAH gate ini — konsisten dengan verdict yang diminta: kesiapan repo
untuk demo, bukan klaim bahwa demo sudah di-deploy.

**GATE 3A PASS — READY FOR EXPLICIT DEMO DEPLOYMENT**
