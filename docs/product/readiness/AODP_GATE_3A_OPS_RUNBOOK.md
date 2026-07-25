# AODP — Ops Runbook (Gate 3A)

Runbook minimal untuk demo/pilot deployment. Ditulis untuk menutup temuan
Gate 3A domain Observability (alert/runbook) dan Backup/Recovery (prosedur
terdokumentasi). Bukan dokumen production-scale penuh — cakupannya sengaja
dibatasi ke apa yang benar-benar berlaku untuk skala demo/pilot saat ini.

## 1. Health check

- **Infra liveness** (unauthenticated, untuk load balancer/uptime monitor):
  `GET /api/health` → `{ status: "healthy"|"degraded", db_healthy: boolean, checked_at }`.
  `degraded` (HTTP 503) berarti database tidak terjangkau — cek status
  Supabase (lokal: `docker ps` container `supabase_db_*`/`supabase_rest_*`;
  hosted: dashboard Supabase Cloud project).
- **Business/automation health** (authenticated per-tenant, credential
  scope `automation.health`): `GET /api/internal/automation/health` →
  status agregat n8n polling, backlog (pending/retry/dead_letter), dan
  `provider_readiness` (telegram/whatsapp mock-vs-live).

## 2. Apa yang perlu dipantau & kapan eskalasi

| Sinyal | Ambang | Tindakan |
|---|---|---|
| `/api/health` → `degraded` / 503 | Sekali saja bisa transient; berulang >2 menit | Cek koneksi Postgres/Supabase, restart service bila perlu |
| `backlog.dead_letter` (automation health) | > 0 | Baca `last_error` pada job terkait (tabel outbox n8n-automation) — job sudah exhaust `max_attempts` (default 5, backoff eksponensial hingga 60 menit), butuh investigasi manual, TIDAK auto-retry lagi |
| `backlog.stale_processing` | > 0 selama beberapa menit | Kemungkinan worker n8n crash di tengah proses — job perlu di-reclaim manual |
| `n8n.reachable === false` | n8n heartbeat basi | AODP TIDAK bergantung pada n8n untuk dianggap "healthy" (degradasi terisolasi), tapi notifikasi Telegram/WhatsApp otomatis akan tertunda — informasikan ke Owner bila berlangsung lama |

Belum ada alerting otomatis (email/Slack/PagerDuty) tersambung ke sinyal di
atas pada fase ini — pemantauan MANUAL oleh Owner/Senior Programmer via
endpoint di atas. Menyambungkan ke sistem alerting eksternal adalah
follow-up eksplisit, bukan bagian scope Gate 3A ini.

## 3. Audit trail (bukan pengganti runbook, tapi sumber investigasi utama)

Setiap aksi sensitif (order/invoice/payment/return/cancellation/refund)
tercatat di `audit_logs` (company_id, actor, action, entity_type, entity_id,
old_data, new_data, outcome). Hanya bisa dibaca (tidak bisa
diubah/dihapus lewat RLS) oleh role **owner** yang aktif pada company yang
sama — lihat kebijakan `audit_logs_select`. Untuk investigasi insiden,
query `audit_logs` terlebih dahulu sebelum menduga root cause dari log
aplikasi (`console.error`, belum terstruktur/belum ada correlation ID pada
fase ini — lihat batasan di §5).

## 4. Backup & restore

Status saat ini: **tidak ada automated backup schedule** untuk instance
Supabase lokal (`supabase_db_AODP`, Docker) — ini instance dev/lokal,
memang tidak dirancang untuk retensi data. Untuk deployment demo/pilot
sungguhan, keputusan Owner diperlukan: pakai Supabase Cloud (otomatis
menyediakan backup terjadwal + PITR tergantung plan) atau self-hosted
dengan kebijakan backup terpisah.

Prosedur dump manual (aman, read-only, sudah diverifikasi bisa jalan):

```bash
# Dump skema penuh (aman, tidak mengubah apa pun)
docker exec supabase_db_AODP pg_dump -U postgres -d postgres --schema-only > schema-backup.sql

# Dump data + skema penuh (untuk instance lokal/dev)
docker exec supabase_db_AODP pg_dump -U postgres -d postgres > full-backup.sql
```

Restore (HANYA ke instance kosong/terpisah — JANGAN pernah menimpa instance
yang sedang dipakai tanpa konfirmasi eksplisit dan backup lebih dulu):

```bash
docker exec -i <target-db-container> psql -U postgres -d postgres < full-backup.sql
```

## 5. Migration rollback

Seluruh migration di `supabase/migrations/` bersifat **purely additive**
(CREATE TABLE / ADD COLUMN / CREATE FUNCTION) — tidak ada satu pun
`DROP TABLE`/`DROP COLUMN` ditemukan (diverifikasi lewat audit Gate 3A).
Tidak ada mekanisme "down migration" resmi (konvensi Supabase CLI). Untuk
membatalkan sebuah migration di lingkungan yang belum production:
1. Tulis migration BARU yang membalikkan efeknya secara eksplisit (bukan
   mengedit file migration lama yang sudah diterapkan).
2. Jalankan `supabase migration up --local` (atau `db push` untuk target
   remote) seperti migration biasa.

## 6. Keterbatasan yang diketahui (bukan bug, dicatat apa adanya)

- Tidak ada correlation/request ID yang mengalir lintas log — masuk akal
  untuk skala demo bervolume rendah, tapi akan jadi gap nyata begitu
  volume bertambah. Follow-up eksplisit di luar scope Gate 3A ini.
- Logging masih `console.error`/`console.log` ad-hoc, belum terstruktur
  (bukan JSON terstandar). `audit_logs` adalah sumber kebenaran untuk aksi
  bisnis sensitif; log aplikasi untuk debugging teknis saja.
