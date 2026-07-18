# n8n Workflow Templates — FlowSales AI & AODP

---

## AODP — n8n Automation & Orchestration Foundation (aktif, phase terkini)

Arsitektur BARU (terpisah dari workflow FlowSales AI lama di bawah): n8n
menarik (poll/claim) job dari **automation outbox** AODP lewat internal API
`Bearer` token, bukan menerima push webhook. Supabase tetap source of truth
-- n8n hanya orchestration/scheduling/delivery/retry, TIDAK PERNAH menghitung
Call/EC/EC Rate/achievement/target sendiri (semua angka datang dari
`lib/sales-kpi/*` via endpoint `/api/internal/automation/morning-brief` dan
`/api/internal/automation/kpi-daily-summary`).

| File | Trigger | Tujuan |
|------|---------|--------|
| `aodp-outbox-dispatcher.json` | Cron tiap 1 menit | Claim + kirim + complete/fail job PENDING/RETRY |
| `aodp-morning-brief.json` | Cron 07:00 Asia/Jakarta | Generate + kirim Morning Brief salesman (Telegram) |
| `aodp-kpi-daily-summary.json` | Cron 08:00 Asia/Jakarta | Generate KPI Daily Summary Owner (structured preview, WhatsApp dry-run) |
| `aodp-retry-handler.json` | Cron tiap 5 menit | Cek `/health`, proses retry backlog jika ada |
| `aodp-dead-letter-monitor.json` | Cron tiap 30 menit | Flag dead-letter untuk review manual (tidak auto-escalate) |
| `aodp-health-check.json` | Cron tiap 5 menit | POST `/heartbeat` (bukti reachability n8n langsung), lalu cek `/health`, flag jika status bukan `healthy` |

**Autentikasi**: SEMUA workflow di atas memakai kredensial `httpHeaderAuth`
generik bertipe `Authorization: Bearer <token>` -- pola YANG SAMA dengan
`n8n_inbound_credentials` (lihat bagian hardening di bawah), scope
`automation.*` per fungsi. Node `credentials.httpHeaderAuth.id` di setiap
file berisi placeholder literal `REPLACE_WITH_YOUR_CREDENTIAL_ID` -- **tidak
ada credential ID/secret production di file manapun**. Provisioning token
tetap lewat `n8n_inbound_credentials` (service-role only, lihat migration
`20260715000001_webhook_security_hardening.sql`), dengan `scope` diisi
subset dari: `automation.claim`, `automation.complete`, `automation.fail`,
`automation.replay`, `automation.health`, `automation.morning_brief.generate`,
`automation.kpi_summary.generate`.

Semua workflow **inactive by default** setelah import (`"active": false`) --
aktifkan manual setelah kredensial dikonfigurasi dan `AODP_APP_URL` diset di
environment n8n. Timezone workflow di-set `Asia/Jakarta` (`settings.timezone`
+ cron expression `0 7 * * *`/`0 8 * * *` WIB).

Detail arsitektur lengkap: `docs/architecture/N8N_AUTOMATION_FOUNDATION.md`.

---

## FlowSales AI — WhatsApp Templates (lama, lihat catatan hardening)

Template workflow n8n untuk mengintegrasikan FlowSales AI dengan WhatsApp.
Setiap workflow menerima trigger dari FlowSales AI, memformat pesan Bahasa Indonesia, dan mengirimkannya via WhatsApp API provider pilihan Anda.

---

## Daftar Workflow

| File | Event | Penerima WA |
|------|-------|------------|
| `flowsales-repeat-order-reminder.json` | `repeat_order_due` | Sales PIC |
| `flowsales-churn-risk-alert.json`      | `churn_risk`       | Sales + Owner/Manager |
| `flowsales-large-order-alert.json`     | `large_order`      | Owner/Manager |
| `flowsales-daily-owner-summary.json`   | `daily_summary`    | Owner |
| `flowsales-master-workflow.json`       | Semua event di atas | Sesuai event |

> **Rekomendasi:** Gunakan `flowsales-master-workflow.json` jika ingin satu webhook URL untuk semua event. Gunakan workflow individual jika ingin kontrol penuh per event.

---

## Cara Import Workflow ke n8n

1. Buka n8n instance Anda (`http://localhost:5678` atau URL cloud)
2. Klik **Workflows** di sidebar kiri
3. Klik tombol **Import** (ikon panah di pojok kanan atas)
4. Pilih **Import from File**
5. Upload salah satu file `.json` dari folder ini
6. Workflow akan muncul dalam status **Inactive**
7. Ulangi untuk setiap workflow yang ingin digunakan

---

## Cara Set Webhook URL ke FlowSales AI

Setelah workflow di-import:

1. Buka workflow di n8n
2. Klik node **Webhook Trigger** (node pertama berwarna oranye)
3. Salin **Production URL** yang ditampilkan, contoh:
   ```
   https://n8n.yourcompany.com/webhook/flowsales-repeat-order
   ```
4. Buka FlowSales AI → **Pengaturan** → **Automation**
5. Pilih automation rule yang sesuai
6. Tambahkan action `call_n8n` dengan webhook URL tersebut
7. Atau update langsung di tabel `n8n_webhooks` via Supabase dashboard:
   ```sql
   UPDATE public.n8n_webhooks
   SET webhook_url = 'https://n8n.yourcompany.com/webhook/flowsales-repeat-order'
   WHERE event_type = 'repeat_order_due'
     AND company_id = '11111111-0000-0000-0000-000000000001';
   ```

---

## Cara Isi WhatsApp API Credential

Workflow ini menggunakan **HTTP Request node** untuk mengirim pesan via WhatsApp API.  
Provider yang umum digunakan: **Fonnte**, **Wablas**, **WA Gateway**, **Twilio**, atau API WhatsApp Business resmi Meta.

### Langkah Setup Credential di n8n:

1. Buka n8n → **Settings** → **Credentials**
2. Klik **Add Credential**
3. Pilih tipe **Header Auth**
4. Beri nama: `WhatsApp API Key`
5. Isi field:
   - **Name**: `Authorization` (atau sesuai provider, misal `apikey`)
   - **Value**: `Bearer <TOKEN_API_ANDA>` (atau format sesuai provider)
6. Klik **Save**
7. Buka setiap workflow dan ganti URL di node **Kirim WhatsApp**:
   ```
   https://api.whatsapp-provider.example.com/v1/messages
   ```
   dengan endpoint aktual dari provider Anda.

### Contoh URL per Provider:

| Provider | Base URL | Format Token |
|----------|----------|-------------|
| Fonnte   | `https://api.fonnte.com/send` | Header: `Authorization: TOKEN` |
| Wablas   | `https://solo.wablas.com/api/send-message` | Header: `Authorization: TOKEN` |
| Twilio   | `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` | Basic Auth (SID:Token) |
| Meta Business | `https://graph.facebook.com/v17.0/{PHONE_NUMBER_ID}/messages` | Bearer Token |

> **Penting:** Format body JSON untuk setiap provider berbeda. Sesuaikan node **Kirim WhatsApp** dengan format yang diperlukan provider Anda.

---

## ⚠️ Autentikasi Callback Sudah Berubah (Webhook Security Hardening)

**Skema HMAC global di bawah ini SUDAH TIDAK DITERIMA** oleh
`POST /api/webhooks/n8n` sejak security hardening (2026-07-15). Endpoint
sekarang mensyaratkan kredensial per-tenant lewat header
`Authorization: Bearer <token>`, bukan header `x-flowsales-signature`.
Workflow di file `.json` folder ini **belum diperbarui** ke skema baru — node
"Hitung HMAC-SHA256" dan callback-nya perlu diganti sebelum workflow mana pun
di folder ini bisa dipakai lagi. Detail mekanisme baru & cara provisioning
kredensial ada di
`docs/architecture/TELEGRAM_SALES_ORDER_ENTRY.md` bagian
"Webhook Security Hardening — Kredensial Inbound n8n". Bagian di bawah ini
dibiarkan apa adanya sebagai catatan sejarah skema lama.

## Cara Isi N8N_WEBHOOK_SECRET (skema lama, tidak dipakai lagi)

Secret ini digunakan untuk menghitung HMAC-SHA256 saat callback ke FlowSales AI (`POST /api/webhooks/n8n`). Harus sama persis dengan nilai `N8N_WEBHOOK_SECRET` di environment variable aplikasi FlowSales AI.

### Langkah Setup di n8n:

1. Buka n8n → **Settings** → **Variables** (n8n versi >= 0.217)
2. Klik **Add Variable**
3. Isi:
   - **Key**: `N8N_WEBHOOK_SECRET`
   - **Value**: nilai secret yang sama dengan di `.env` FlowSales AI
4. Klik **Save**

### Cara Generate Secret yang Aman:

```bash
# Di terminal Linux/Mac:
openssl rand -hex 32

# Atau via Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Contoh output: `a3f8c2d1e9b4f7a0c5d2e8b1f4a7c0d3e6b9f2a5c8d1e4b7a0f3c6d9e2b5f8a1`

> **Perhatian:** Secret harus minimal 32 karakter. Jangan gunakan nilai default seperti `GANTI_DENGAN_SECRET_ANDA` di production.

### Cara Set di FlowSales AI (Vercel / .env):

```bash
# .env.local atau Vercel Environment Variables
N8N_WEBHOOK_SECRET=a3f8c2d1e9b4f7a0c5d2e8b1f4a7c0d3e6b9f2a5c8d1e4b7a0f3c6d9e2b5f8a1
```

---

## Struktur Payload dari FlowSales AI

FlowSales AI mengirim payload berikut saat memanggil webhook n8n:

### Event: `repeat_order_due`
```json
{
  "event": "repeat_order_due",
  "rule_id": "uuid-rule",
  "rule_name": "Reminder Repeat Order",
  "company_id": "11111111-0000-0000-0000-000000000001",
  "trigger_data": {
    "customer_id": "uuid-customer",
    "customer_name": "Toko Makmur Jaya",
    "customer_phone": "08123456789",
    "customer_area": "Jakarta Selatan",
    "sales_id": "uuid-sales",
    "sales_name": "Eko Prasetyo",
    "sales_phone": "08129876543",
    "days_ahead": 3,
    "last_order_date": "2026-06-01",
    "predicted_order_date": "2026-06-30"
  },
  "timestamp": "2026-06-27T10:00:00.000Z"
}
```

### Event: `churn_risk`
```json
{
  "event": "churn_risk",
  "rule_id": "uuid-rule",
  "rule_name": "Eskalasi Churn Risk ke Owner",
  "company_id": "11111111-0000-0000-0000-000000000001",
  "trigger_data": {
    "customer_id": "uuid-customer",
    "customer_name": "CV Berkah Sejahtera",
    "customer_phone": "08112345678",
    "customer_area": "Bandung",
    "last_order_amount": 2500000,
    "days_inactive": 46,
    "sales_name": "Fitri Handayani",
    "sales_phone": "08129876544",
    "owner_phone": "08129876540",
    "manager_phone": "08129876541"
  },
  "timestamp": "2026-06-27T09:00:00.000Z"
}
```

### Event: `large_order`
```json
{
  "event": "large_order",
  "rule_id": "uuid-rule",
  "rule_name": "Notifikasi Order Besar",
  "company_id": "11111111-0000-0000-0000-000000000001",
  "trigger_data": {
    "order_id": "uuid-order",
    "order_number": "SO-2026-001234",
    "order_date": "2026-06-27T08:30:00.000Z",
    "order_amount": 7500000,
    "item_count": 12,
    "customer_name": "PT Nusantara Trading",
    "customer_phone": "08212345678",
    "sales_name": "Eko Prasetyo",
    "owner_phone": "08129876540",
    "manager_phone": "08129876541"
  },
  "timestamp": "2026-06-27T08:30:00.000Z"
}
```

### Event: `daily_summary`
```json
{
  "event": "daily_summary",
  "rule_id": "uuid-rule",
  "rule_name": "Laporan Harian ke Owner",
  "company_id": "11111111-0000-0000-0000-000000000001",
  "trigger_data": {
    "report_date": "2026-06-27",
    "total_orders_today": 8,
    "total_revenue_today": 45000000,
    "active_customers": 142,
    "dormant_customers": 17,
    "churn_risk_count": 5,
    "ai_summary": "Performa hari ini di atas rata-rata mingguan. 3 pelanggan area Jakarta Barat menunjukkan sinyal repeat order dalam 5 hari ke depan.",
    "owner_phone": "08129876540"
  },
  "timestamp": "2026-06-27T08:00:00.000Z"
}
```

### Payload Callback dari n8n ke FlowSales AI (`POST /api/webhooks/n8n`)

n8n mengirimkan callback ini beserta header `x-flowsales-signature: sha256=<hmac>`:
```json
{
  "event": "webhook_processed",
  "source": "n8n",
  "rule_id": "uuid-rule",
  "rule_name": "Reminder Repeat Order",
  "status": "success",
  "processed_at": "2026-06-27T10:00:05.000Z"
}
```

---

## Langkah Testing

### 1. Test via n8n UI (Test Webhook)

1. Buka workflow di n8n
2. Klik node **Webhook Trigger**
3. Klik **Listen for Test Event**
4. Jalankan curl berikut dari terminal (ganti URL dengan **Test URL** yang ditampilkan):

```bash
# Test repeat_order_due
curl -X POST "https://n8n.yourcompany.com/webhook-test/flowsales-repeat-order" \
  -H "Content-Type: application/json" \
  -d '{
    "event": "repeat_order_due",
    "rule_id": "test-rule-001",
    "rule_name": "Reminder Repeat Order",
    "company_id": "11111111-0000-0000-0000-000000000001",
    "trigger_data": {
      "customer_name": "Toko Test",
      "customer_phone": "08123456789",
      "sales_name": "Sales Test",
      "sales_phone": "08129876543",
      "days_ahead": 3,
      "last_order_date": "2026-06-01",
      "predicted_order_date": "2026-06-30"
    },
    "timestamp": "2026-06-27T10:00:00.000Z"
  }'
```

5. Lihat hasilnya di panel kanan n8n
6. Verifikasi setiap node berwarna hijau (sukses)

### 2. Test via FlowSales AI

1. Login sebagai owner/manager
2. Buka **Pengaturan** → **Automation**
3. Buka rule yang sesuai
4. Klik **Jalankan Manual** (jika tersedia)
5. Cek n8n **Executions** untuk melihat log eksekusi

### 3. Verifikasi Callback

1. Cek log di FlowSales AI (Supabase → `automation_logs`)
2. Status harus `success` jika callback diterima dengan benar
3. Jika `failed`, periksa HMAC secret — harus sama di kedua sisi

### 4. Checklist Sebelum Aktifkan Workflow

- [ ] URL WhatsApp provider sudah diganti dari placeholder
- [ ] Credential `WhatsApp API Key` sudah dibuat di n8n
- [ ] Variable `N8N_WEBHOOK_SECRET` sudah diisi di n8n Settings
- [ ] Variable `FLOWSALES_APP_URL` sudah diisi (contoh: `https://app.flowsales.id`)
- [ ] Webhook URL sudah diregistrasi di tabel `n8n_webhooks` FlowSales AI
- [ ] Test manual berhasil (workflow berwarna hijau semua)
- [ ] Aktifkan workflow: toggle **Active** di kanan atas

---

## Troubleshooting

| Error | Kemungkinan Penyebab | Solusi |
|-------|---------------------|--------|
| `401 Unauthorized` di Kirim WhatsApp | Token WhatsApp salah | Cek credential di n8n Settings |
| `403 Forbidden` di Callback ke FlowSales | HMAC tidak cocok | Samakan `N8N_WEBHOOK_SECRET` di n8n dan `.env` FlowSales |
| `400 Bad Request` di Callback | Body tidak valid | Pastikan `bodyContentType: raw` dan `Content-Type: application/json` |
| Pesan WA tidak terkirim | `whatsapp_to` kosong | Pastikan field `sales_phone` / `owner_phone` ada di `trigger_data` |
| Workflow tidak trigger | URL webhook salah | Gunakan **Production URL** (bukan Test URL) di production |

---

## Arsitektur Integrasi

```
FlowSales AI (Automation Engine)
         │
         │  POST /webhook/<path>
         │  Body: { event, trigger_data, rule_id, ... }
         ▼
     n8n Webhook
         │
         ├── Validasi Field Wajib (IF node)
         │
         ├── Format Pesan WhatsApp (Set node)
         │
         ├── Kirim WhatsApp (HTTP Request → Provider)
         │
         ├── Hitung HMAC-SHA256 (Code node)
         │
         └── Callback ke FlowSales (HTTP Request)
                  │
                  │  POST /api/webhooks/n8n
                  │  Header: x-flowsales-signature: sha256=<hmac>
                  ▼
          FlowSales AI (update automation_logs)
```
