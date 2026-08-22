# n8n Automation & Orchestration Foundation

Status: fondasi phase pertama (Morning Brief, KPI Daily Summary, outbox
dispatcher, retry/dead-letter, health monitoring). Lihat `n8n/README.md`
untuk daftar workflow JSON.

## Batas Arsitektur (locked)

- **Supabase = source of truth.** Business rules (Call/EC/EC Rate/target/
  achievement) tetap seluruhnya di `lib/sales-kpi/*` dan RPC Postgres terkait
  -- **tidak diduplikasi maupun dihitung ulang** di modul automation ini
  maupun di n8n.
- **n8n hanya orchestration**: scheduling (cron), claim job, delivery,
  retry, escalation. n8n tidak pernah menetapkan/mengubah target, tidak
  pernah menulis langsung ke `sales_orders`/`sales_calls`/`sales_kpi_*`.
- **Telegram webhook existing (`api/webhooks/telegram`) tidak disentuh.**
  Modul ini hanya memakai ULANG `TelegramSender` (`lib/telegram/client.ts`)
  untuk arah OUTBOUND (kirim) -- jalur INBOUND (salesman mengetik command)
  tetap 100% lewat `lib/sales-orders/workflow.ts` seperti sebelumnya.
- **Jika n8n mati, transaksi inti AODP tetap jalan** -- outbox hanya
  antrian notifikasi, tidak ada bagian dari alur Sales Order Entry yang
  bergantung pada n8n hidup.

## Schema (migration `20260807000001_automation_outbox.sql`)

- `automation_outbox` -- antrian job. Status: `PENDING -> PROCESSING ->
  SENT` (happy path), atau `PROCESSING -> RETRY -> PROCESSING -> ...` (retry
  loop dengan backoff eksponensial, cap 60 menit), atau `PROCESSING ->
  DEAD_LETTER` (attempt_count habis) / `PROCESSING -> FAILED` (error
  non-retryable). `UNIQUE(company_id, idempotency_key)` -- job yang sama
  dua kali generate hanya menghasilkan satu baris.
- RPC `claim_automation_jobs` -- `FOR UPDATE SKIP LOCKED`, atomik,
  concurrency-safe. Stale `PROCESSING` (locked_at > 10 menit) otomatis
  eligible di-reclaim di WHERE clause yang sama (tidak perlu cron terpisah).
- RPC `complete_automation_job` / `fail_automation_job` / `replay_automation_job`
  / `enqueue_automation_job` -- semua `SECURITY DEFINER`, memverifikasi
  scope credential (`check_automation_credential_scope`) sebelum mutasi apa
  pun. Setiap transisi status menulis baris `audit_logs`.
- Autentikasi memakai ULANG `n8n_inbound_credentials` (migration
  `20260715000001`) -- Bearer token, SHA-256 hash lookup, `company_id`
  SELALU dari credential (tidak pernah dari body request). Scope baru:
  `automation.claim`, `automation.complete`, `automation.fail`,
  `automation.replay`, `automation.health`,
  `automation.morning_brief.generate`, `automation.kpi_summary.generate`,
  `automation.sales_report_afternoon.generate` (Gate P4.11, migration
  `20261013000001`).

## Internal API (`/api/internal/automation/*`)

| Route | Fungsi |
|---|---|
| `POST /claim` | Claim hingga N job (default dipakai internal `/dispatch`) |
| `POST /complete` | Tandai SENT (idempotent) |
| `POST /fail` | RETRY/DEAD_LETTER/FAILED sesuai `retryable` |
| `POST /replay` | Controlled replay (credential atau, lewat server action dashboard, actor manusia) |
| `GET /health` | Snapshot backlog/dead-letter/n8n-polling, tanpa secret |
| `POST /morning-brief` | Generate job Morning Brief per salesman aktif+Telegram valid |
| `POST /kpi-daily-summary` | Generate job KPI Daily Summary Owner -- projection pagi (WhatsApp dry-run) |
| `POST /sales-report-afternoon` | Generate job Laporan Sales Sore Owner -- hasil kerja hari itu: EC-to-transaksi, Omzet, Tagihan (WhatsApp dry-run) |
| `POST /dispatch` | Claim + kirim (via `TelegramSender`) + complete/fail dalam satu panggilan atomik per job |

Semua endpoint menolak request tanpa `Authorization: Bearer` valid (401)
sebelum operasi apa pun -- tidak ada jalur anonymous.

## Presenter (tidak menghitung, hanya merangkai)

- `lib/n8n-automation/morning-brief.ts` -- `buildMorningBrief()`, input
  `SalesKpiAchievementProjection`/`SalesKpiCalibrationBaseline` yang SUDAH
  dihitung `lib/sales-kpi/*`. Jika tidak ada periode ACTIVE: pesan eksplisit
  "target belum tersedia", tidak pernah mengarang angka 0.
- `lib/n8n-automation/kpi-daily-summary.ts` -- `buildKpiDailySummary()`,
  agregat seluruh salesman untuk satu laporan Owner.

## Business timezone

`lib/n8n-automation/timezone.ts` -- `businessDateJakarta()`/
`jakartaHourMinute()` memakai `Intl.DateTimeFormat` dengan
`timeZone: "Asia/Jakarta"` (bukan offset manual). Dipakai untuk idempotency
key Morning Brief (`morning_brief:{salespersonId}:{businessDate}`) dan cron
schedule workflow n8n. Modul lain (mis. `lib/sales-kpi/service.ts`) masih
memakai kalender UTC -- keputusan/limitation terpisah, tidak diubah di sini.

## Dry-run / keamanan pengiriman

`AUTOMATION_DRY_RUN` (default: tidak diset = dry-run) mengontrol channel
Telegram di `/dispatch` -- hanya `AUTOMATION_DRY_RUN=false` eksplisit yang
mengizinkan `HttpTelegramSender` (kirim nyata). Channel `whatsapp`
(KPI Daily Summary) SELALU dry-run terlepas dari env ini -- WhatsApp
production sengaja tidak diimplementasikan phase ini.
