# Telegram Sales Order Entry — MVP

Vertical slice: input order sales via Telegram, dari pesan masuk sampai draft
order tersimpan (belum: PO tercetak, delivery verification, invoice,
notifikasi WhatsApp owner, dashboard baru, warehouse deduction, pengiriman
barang — lihat scope di task asli).

## Status Production Readiness (per audit terakhir)

| Gate | Status |
|---|---|
| Kode lulus test/type-check/lint/build | ✅ |
| Webhook Telegram aman (secret, fail-closed, tidak percaya payload, tidak bocor internal, bypass session) | ✅ diverifikasi hidup (lihat §Audit Keamanan) |
| Webhook n8n aman (kredensial per-tenant, tidak percaya company_id dari payload, fail closed) | ✅ **diperbaiki & diverifikasi hidup** — lihat §Webhook Security Hardening. Sebelumnya memakai satu secret global + company_id dari payload (celah tenant spoofing) — sudah diganti. |
| Telegram unregistered handshake tidak menyimpan isi pesan | ✅ diperbaiki & diverifikasi hidup — lihat §Retensi Data Handshake |
| Supabase **production** untuk AODP | ❌ **belum ada** — `supabase link` belum pernah dijalankan, tidak ada project ref tersimpan di mana pun di repo ini. Satu-satunya target yang pernah dipakai adalah Supabase lokal (Docker, project_id "AODP"). |
| `TELEGRAM_BOT_TOKEN` asli dari @BotFather | ❌ belum ada — hanya nilai dev palsu (`dev-fake-token-not-real`) di `.env.local` lokal |
| `TELEGRAM_WEBHOOK_SECRET` produksi (acak, kuat) | ❌ nilai saat ini di `.env.local` (`dev-secret-for-local-testing`) hanya untuk dev, **jangan dipakai di production** |
| Kredensial `n8n_inbound_credentials` production | ❌ belum ada — tabel sudah ada (migration diterapkan lokal), tapi belum ada baris production karena belum ada project Supabase production |
| Deployment target (Vercel project) | ❔ belum diverifikasi ada/tidaknya dari sisi repo ini |
| `telegram_identities` Pak Waluyo | ❌ belum bisa didaftarkan — `chat_id` Telegram asli, `user_id` AODP, dan `company_id` Pak Waluyo semuanya belum tersedia (lihat §Registrasi Identitas) |

**Kesimpulan: deployment ke production belum bisa dilakukan.** Bagian
"Production Verification" di bawah menjelaskan langkah yang akan dijalankan
begitu item di atas tersedia — bukan hasil yang sudah terjadi. Section ini
murni tentang security hardening yang sudah lulus **lokal**; tidak ada
project production, deployment, atau registrasi webhook nyata yang dilakukan
sebagai bagian dari hardening ini.

## Arsitektur Singkat

```
Telegram → POST /api/webhooks/telegram (verifikasi secret + rate limit)
             → processTelegramUpdate()  [apps/web/src/lib/sales-orders/workflow.ts]
                 → resolveIdentity()     — TIDAK PERNAH percaya payload
                 → extractSalesOrder()   — parser deterministik + Knowledge Pack
                 → buildPricedOrder()    — discount control per item
                 → repository            — Supabase (RLS) atau in-memory (test)
                 → sender.sendMessage()  — balasan ke Telegram
```

Business logic 100% berada di `apps/web/src/lib/sales-orders/` (testable tanpa
DB via `InMemorySalesOrderRepository` + `InMemoryKnowledgeProvider`). Route
API hanya verifikasi + delegasi. Tidak ada panggilan vendor AI langsung —
ekstraksi memakai parser deterministik yang mengonsumsi kontrak
`ExtractedSalesOrder` dari `packages/ai`.

## Environment Variables

Tambahkan ke `.env.local` (lihat `.env.example`):

| Variable | Keterangan |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token dari [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | String rahasia buatan sendiri (`openssl rand -hex 32`). Wajib diisi — tanpa ini webhook menolak semua request. |

Webhook n8n (`/api/webhooks/n8n`) **tidak lagi memakai environment variable**
untuk autentikasi — sejak hardening ini, autentikasinya per-tenant lewat
tabel `n8n_inbound_credentials` (lihat §Webhook Security Hardening di bawah).
`N8N_WEBHOOK_SECRET` yang lama (HMAC global) sudah tidak dipakai kode; boleh
tetap ada di `.env` lama tanpa efek, tapi tidak perlu diisi untuk deployment baru.

## Webhook Security Hardening — Kredensial Inbound n8n

**Root cause yang diperbaiki:** webhook n8n sebelumnya mengautentikasi SEMUA
pemanggil dengan satu HMAC secret **global** (`N8N_WEBHOOK_SECRET`), lalu
mempercayai field `company_id` di body JSON untuk menentukan tenant mana yang
ditulis. Ini memisahkan autentikasi ("apakah pemanggil tahu secret") dari
otorisasi tenant ("tenant siapa yang boleh ditulis") — siapa pun yang tahu
secret global (satu nilai yang sama untuk seluruh integrasi n8n, di semua
tenant) bisa menulis `automation_logs` ke `company_id` mana pun hanya dengan
mengubah field itu di body request. Ini disebut **tenant spoofing**.

**Desain baru:** setiap integrasi n8n punya kredensial sendiri, terikat ke
satu `company_id`, dikirim sebagai Bearer token:

```
Authorization: Bearer <token mentah>
```

Server men-hash token itu (SHA-256) dan mencari baris `n8n_inbound_credentials`
dengan `credential_hash` yang cocok DAN `status = 'active'`. `company_id`
untuk request tersebut **selalu** hasil resolve dari kredensial ini — bukan
dari body payload. Jika payload tetap membawa field `company_id` dan nilainya
berbeda dari kredensial, request ditolak (`403 tenant mismatch`) — bukan
ditimpa diam-diam atau diabaikan tanpa jejak.

Sifat kredensial (tabel `n8n_inbound_credentials`, lihat migration
`20260715000001_webhook_security_hardening.sql`):

| Kolom | Fungsi |
|---|---|
| `credential_hash` | SHA-256 hex dari token mentah. **Token mentah tidak pernah disimpan** di database, log, response, atau audit trail mana pun. |
| `scope` | Array `event_type` yang diizinkan kredensial ini. **Kosong = tidak ada event yang diizinkan** (fail closed) — bukan "semua diizinkan". Admin wajib mengisi eksplisit sesuai kebutuhan workflow n8n yang bersangkutan. |
| `status` | `active` / `revoked`. Kredensial revoked ditolak persis seperti kredensial salah (401) — pesan error tidak membedakan keduanya, supaya tidak membocorkan info ke penyerang. |
| `rotated_at` / `revoked_at` | Jejak audit kapan kredensial dirotasi/dicabut. |

Idempotency: setiap event dari n8n wajib membawa `event_id` unik (mis. n8n
execution id) di body. Kombinasi `(credential_id, event_id)` unique di tabel
`n8n_inbound_events` — event yang sama yang dikirim ulang (retry n8n) tidak
membuat `automation_logs` ganda, direspons `{"received": true, "duplicate": true}`.

### Menyediakan Kredensial (manual, tidak ada UI — sesuai scope MVP)

**Tidak pernah membuat kredensial production lewat migration/seed** — hanya
lewat prosedur manual ini, dijalankan admin dengan akses service role:

```bash
# 1. Generate token acak (di terminal admin, JANGAN di n8n dulu)
openssl rand -hex 32
# contoh: <TOKEN_MENTAH>

# 2. Hitung SHA-256 hash-nya (Node.js, tidak perlu ekstensi DB)
node -e "console.log(require('crypto').createHash('sha256').update('<TOKEN_MENTAH>').digest('hex'))"
# -> <HASH>
```

```sql
-- 3. Simpan HANYA hash-nya. scope wajib diisi (kosong = fail closed).
insert into public.n8n_inbound_credentials (company_id, credential_hash, label, scope)
values (
  '<company_id tenant yang berhak>',
  '<HASH dari langkah 2>',
  'n8n — <nama integrasi>',
  ARRAY['<event_type yang dibutuhkan, mis. repeat_order_due>']
);
```

```
# 4. <TOKEN_MENTAH> (bukan hash) yang dimasukkan ke n8n:
#    n8n → Settings → Credentials → Header Auth
#    Name: Authorization
#    Value: Bearer <TOKEN_MENTAH>
```

Mencabut kredensial (mis. integrasi n8n lama dinonaktifkan / diduga bocor):

```sql
update public.n8n_inbound_credentials
set status = 'revoked', revoked_at = now()
where id = '<credential_id>';
```

Rotasi (buat token baru untuk kredensial yang sama secara logis — dalam
praktiknya: revoke yang lama, buat baris baru dengan hash token baru, catat
`rotated_at` pada baris lama untuk jejak audit):

```sql
update public.n8n_inbound_credentials
set status = 'revoked', revoked_at = now(), rotated_at = now()
where id = '<credential_id_lama>';
-- lalu insert baris baru seperti langkah 3 di atas dengan token baru
```

### Payload yang Diharapkan dari n8n

```json
{
  "event_id": "exec-12345",
  "event_type": "repeat_order_due",
  "data": { "...": "..." }
}
```

`company_id` **boleh diikutsertakan** (mis. untuk audit/debug di sisi n8n)
tapi tidak pernah dipakai sebagai sumber kebenaran — hanya dicocokkan; beda
dari kredensial → `403`.

### Peta Response n8n

| Response | Kondisi |
|---|---|
| `401 {"error":"Unauthorized"}` | Header `Authorization` tidak ada, format bukan `Bearer <token>`, token salah, atau kredensial revoked |
| `400 {"error":"Invalid request body"}` | Body bukan JSON valid, atau `event_id`/`event_type` kosong/tidak ada |
| `403 ...tenant mismatch` | Payload membawa `company_id` yang berbeda dari kredensial |
| `403 ...event type not permitted` | `event_type` tidak ada di `scope` kredensial |
| `200 {"received":true,"duplicate":true}` | `(credential_id, event_id)` sudah pernah diproses sebelumnya |
| `200 {"received":true,"event_type":"...","timestamp":"..."}` | Diterima & `automation_logs` tercatat dengan `company_id` hasil resolve kredensial |

### Catatan Kompatibilitas — Template n8n Lama

Template workflow di `n8n/*.json` (warisan FlowSalesAI) masih menghitung
HMAC-SHA256 dengan `N8N_WEBHOOK_SECRET` global untuk callback ke
`/api/webhooks/n8n` (lihat `n8n/README.md`). **Skema itu sudah tidak
diterima** oleh route setelah hardening ini — callback akan mendapat `401`.
Template JSON tersebut **belum diperbarui** ke skema Bearer token baru di
sesi ini (mengubah node HMAC di dalam file `.json` n8n dianggap refactor di
luar scope hardening backend) — lihat "Risiko Tersisa" di laporan audit.
Sebelum mengaktifkan ulang workflow n8n manapun yang memanggil endpoint ini,
node "Hitung HMAC-SHA256" dan header callback-nya harus diganti mengirim
`Authorization: Bearer <token>` + body `{event_id, event_type, data}`.

## Setup Bot Telegram (satu kali)

```bash
# Daftarkan webhook ke Telegram, sertakan secret_token yang sama dengan TELEGRAM_WEBHOOK_SECRET
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<domain-anda>/api/webhooks/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Untuk testing lokal tanpa domain publik, gunakan `ngrok`/`cloudflared` tunnel
ke `localhost:3000`, atau simulasikan update langsung via curl (lihat bawah)
tanpa mendaftarkan webhook sungguhan ke Telegram sama sekali.

## Konfigurasi Environment Variable di Vercel

Nilai secret **tidak pernah** ditulis di dokumen ini atau di git. Langkah
konfigurasi (dilakukan Founder/admin langsung di Vercel dashboard, atau via
`vercel env add` di terminal masing-masing — tidak lewat commit):

1. Buka Vercel project AODP → **Settings → Environment Variables**.
2. Tambahkan `TELEGRAM_BOT_TOKEN`, scope **Production** (dan **Preview** bila
   ingin test di preview deployment) — isi dengan token asli dari
   [@BotFather](https://t.me/BotFather), didapat via chat `/newbot` atau
   `/mybots` → pilih bot → API Token.
3. Tambahkan `TELEGRAM_WEBHOOK_SECRET`, scope **Production** — isi dengan
   string acak kuat yang **dibuat khusus untuk production**, jangan pakai
   nilai dev (`dev-secret-for-local-testing`). Buat via:
   ```bash
   openssl rand -hex 32
   ```
   Simpan nilai ini juga di password manager Founder — dibutuhkan lagi saat
   `setWebhook` (langkah berikutnya, §Setup Bot Telegram) supaya `secret_token`
   yang didaftarkan ke Telegram sama persis dengan yang ada di Vercel.
4. Pastikan variabel Supabase (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
   `DATABASE_URL`) di scope Production **mengarah ke project Supabase AODP**,
   bukan project FlowSalesAI lama — cek di Supabase dashboard bahwa project
   ref yang dipakai sesuai project yang sudah di-`supabase link` untuk AODP.
5. Redeploy setelah menambah/mengubah env var (Vercel tidak auto-reload env
   ke deployment yang sudah berjalan).
6. Verifikasi tanpa membuka nilai secret: `curl -I https://<domain>/api/webhooks/telegram`
   harus mengembalikan `405` (GET tidak diizinkan) atau perilaku serupa,
   **bukan** redirect ke `/login` — itu tanda middleware bypass & route sudah
   aktif di production.

## Mendaftarkan Sales (Telegram Identity Mapping)

Belum ada UI (di luar scope MVP ini). Daftarkan manual via SQL — **jangan
pernah** mempercayai `company_id`/`user_id` dari payload Telegram, hanya baris
di `telegram_identities` yang menjadi sumber kebenaran identitas.

**Jangan mengarang `telegram_chat_id`.** ID ini unik per user Telegram dan
harus didapat dari update Telegram yang sungguhan — bukan ditebak/dikira-kira.
Prosedur aman berikut memakai teknik "update pertama yang belum terdaftar",
memanfaatkan fakta bahwa webhook Telegram AODP sudah mencatat setiap update
dari chat_id yang belum dikenal ke tabel `telegram_update_events` dengan
`processing_status = 'rejected_unregistered'`. Pengirim tetap dapat balasan
("Nomor Anda belum terdaftar untuk menggunakan layanan ini. Silakan hubungi
admin/owner distributor Anda.") — pesan generik, **tidak membocorkan detail
internal apa pun** (bukan diam total, tapi juga tidak ada informasi sensitif
yang keluar).

> **Hardening:** sejak migration `20260715000001_webhook_security_hardening.sql`,
> baris `rejected_unregistered` **tidak lagi menyimpan `raw_payload`** (isi
> pesan asli) — kolom itu sengaja `NULL` untuk baris ini. Yang disimpan hanya
> metadata minimum: `telegram_chat_id`, `telegram_user_id`, `telegram_username`,
> `rejection_reason`. Ini mencegah isi pesan sensitif dari pengirim yang belum
> terverifikasi (mis. salah kirim data pelanggan/harga) ikut tersimpan hanya
> untuk keperluan menemukan chat_id. Lihat §Retensi Data Handshake di bawah.

Langkah:

1. **Pastikan `company_id` dan `user_id` (AODP) untuk Pak Waluyo sudah ada**
   di database production — ini keputusan Founder/onboarding, bukan sesuatu
   yang bisa diturunkan dari Telegram. Jika belum ada baris `companies`/`users`
   untuk distributor Pak Waluyo, itu harus dibuat lebih dulu lewat alur
   onboarding normal (di luar scope dokumen ini).
2. Deploy webhook ke production & daftarkan ke Telegram (`setWebhook`, lihat
   §Setup Bot Telegram) memakai `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`
   production yang sudah dikonfigurasi di Vercel.
3. Minta Pak Waluyo mengirim **satu pesan apa saja** (mis. "halo") ke bot
   Telegram tersebut dari HP-nya sendiri.
4. Admin (yang punya akses `SUPABASE_SERVICE_ROLE_KEY` atau SQL editor
   Supabase dashboard — **wajib**, karena RLS membatasi baris `company_id
   IS NULL` dari akses biasa) menjalankan query berikut untuk mengambil
   `chat_id` asli dari update yang baru saja masuk:
   ```sql
   select telegram_chat_id, telegram_user_id, telegram_username, created_at
   from public.telegram_update_events
   where processing_status = 'rejected_unregistered'
   order by created_at desc
   limit 5;
   ```
5. Cocokkan baris yang muncul dengan waktu Pak Waluyo mengirim pesan (langkah
   3) — **`telegram_username` hanya label bantu, bukan identitas tepercaya**
   (Telegram username bisa diganti siapa pun) — lalu pakai `telegram_chat_id`
   hasil query itu — **bukan angka buatan** — untuk registrasi:
   ```sql
   insert into public.telegram_identities (company_id, user_id, telegram_chat_id, telegram_username)
   values (
     '<company_id Pak Waluyo — dari langkah 1, BUKAN placeholder>',
     '<user_id AODP Pak Waluyo, role sales/admin/owner/manager — dari langkah 1>',
     <telegram_chat_id hasil query langkah 4>,
     '<telegram_username hasil query langkah 4, opsional, hanya label>'
   );
   ```
6. Minta Pak Waluyo mengirim pesan order lagi — sekarang harus mendapat
   balasan draft, bukan diam.

Prosedur ini **tidak pernah butuh admin menanyakan Telegram user ID secara
manual ke sales** (rawan salah ketik) — sumbernya selalu payload asli yang
sudah tercatat sistem.

### Retensi Data Handshake Telegram Tidak Terdaftar

Baris `telegram_update_events` dengan `processing_status = 'rejected_unregistered'`
menyimpan metadata identifikasi (chat_id, user_id, username) tanpa batas waktu
otomatis saat ini — **tidak ada job pembersihan terjadwal** yang dibangun
sebagai bagian dari hardening ini (menambah cron/scheduled job dianggap fitur
baru, di luar scope perbaikan keamanan webhook).

Kebijakan retensi yang direkomendasikan (manual, dijalankan admin sesuai
kebutuhan — bukan otomatis):

- Simpan baris `rejected_unregistered` **maksimal 90 hari**. Tujuannya murni
  operasional (identity discovery untuk sales baru yang belum registrasi),
  bukan analitik jangka panjang.
- Baris yang sudah dipakai untuk registrasi (`chat_id` sudah masuk ke
  `telegram_identities`) tidak perlu disimpan lebih lama — chat_id sudah
  tercatat permanen di tabel identitas.
- Pembersihan manual (dijalankan admin lewat SQL editor bila diperlukan,
  **bukan destructive di luar tabel ini**):
  ```sql
  delete from public.telegram_update_events
  where processing_status = 'rejected_unregistered'
    and created_at < now() - interval '90 days';
  ```

RLS pada `telegram_update_events` (`tue_select`, lihat migration
`20260709000001_telegram_sales_order_intake.sql`) mensyaratkan
`company_id = get_user_company_id()`. Karena baris `rejected_unregistered`
selalu punya `company_id = NULL`, baris ini **tidak pernah terlihat lewat
dashboard tenant mana pun** — hanya service role atau akses admin langsung ke
database yang bisa membacanya. Ini memenuhi syarat "hanya dapat dibaca oleh
service role/authorized admin" tanpa perlu policy tambahan.

## Mengisi Knowledge Pack (opsional, MVP tetap jalan tanpa ini)

Tanpa baris Knowledge Pack, order tetap bisa diekstrak — hanya lebih banyak
field yang masuk `missingFields`/`requiresReview` dan produk/customer tidak
ter-match ke master (`product_name_raw`/`customer_name_raw` dipakai sebagai
fallback). Contoh mengisi alias produk & kebijakan diskon:

```sql
insert into public.knowledge_product_aliases (company_id, alias_text, product_id)
values ('<company_id>', 'mw putih', '<product_id Cat Mawar Putih>');

insert into public.knowledge_discount_policies (company_id, scope, max_percentage)
values ('<company_id>', 'global', 15); -- diskon >15% akan ditandai discount_exception
```

## Cara Uji Webhook (curl)

Semua contoh di bawah memakai `TELEGRAM_WEBHOOK_SECRET=dev-secret` dan
`chat_id=1001` yang sudah didaftarkan ke sebuah company/sales.

**1. Order lengkap:**
```bash
curl -X POST http://localhost:3000/api/webhooks/telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: dev-secret" \
  -d '{
    "update_id": 100001,
    "message": {
      "message_id": 1,
      "chat": { "id": 1001 },
      "from": { "id": 5555, "username": "andri" },
      "text": "Order Toko Sinar Jaya:\nCat Mawar Putih 20 dus harga 450 ribu diskon 5%\nThinner Super 10 dus harga 175 ribu potongan 100 ribu\nKirim Jumat pagi, jangan lewat jam 10."
    }
  }'
```

**2. Konfirmasi (update_id baru, teks "KONFIRMASI"):**
```bash
curl -X POST http://localhost:3000/api/webhooks/telegram \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: dev-secret" \
  -d '{"update_id": 100002, "message": {"message_id": 2, "chat": {"id": 1001}, "text": "KONFIRMASI"}}'
```

**3. Koreksi (UBAH lalu kirim teks baru sebagai update_id terpisah):**
```bash
curl ... -d '{"update_id": 100003, "message": {"message_id": 3, "chat": {"id": 1001}, "text": "UBAH"}}'
curl ... -d '{"update_id": 100004, "message": {"message_id": 4, "chat": {"id": 1001}, "text": "Order Toko Sinar Jaya:\nCat Mawar Putih 20 dus harga 450 ribu"}}'
```

**4. Voice note (hanya field `voice`, tanpa `text`):**
```bash
curl ... -d '{"update_id": 100005, "message": {"message_id": 5, "chat": {"id": 1001}, "voice": {"file_id": "abc123", "duration": 4}}}'
```

**5. User tidak terdaftar** — pakai `chat_id` yang belum ada di `telegram_identities`.

**6. Duplicate update_id** — kirim ulang request #1 dengan `update_id` yang sama persis; response tetap 200 tapi tidak ada draft/pesan baru.

Response selalu `{"ok": true, "outcome": "<...>"}` dengan `outcome` yang bisa
dicocokkan ke tabel di bawah untuk memverifikasi hasil tanpa perlu membuka
database.

## Peta `outcome` Response

| outcome | Arti |
|---|---|
| `draft_created` | Order baru berhasil diekstrak & disimpan sebagai draft |
| `corrected_draft_updated` | Draft yang sama diperbarui setelah UBAH + koreksi |
| `confirmed` | Status berubah ke `confirmed` (`alreadyConfirmed` di body internal jika diulang) |
| `awaiting_correction` | Sales membalas UBAH, menunggu teks koreksi |
| `not_order` | Pesan tidak dikenali sebagai order |
| `unregistered` | Chat ID belum terdaftar di `telegram_identities` |
| `voice_pending` | Voice note diterima, transkripsi belum tersedia |
| `duplicate_update` | `update_id` sudah pernah diproses — tidak ada efek samping |
| `no_pending_order` | KONFIRMASI/UBAH dikirim tanpa draft yang menunggu (atau order sudah confirmed) |

## Menjalankan Test

```bash
pnpm --filter @flowsales/web test
```

13 skenario di `apps/web/src/lib/sales-orders/workflow.test.ts`, seluruhnya
memakai `InMemorySalesOrderRepository` + `InMemoryKnowledgeProvider` — tidak
butuh Supabase/Telegram hidup.

## Living Knowledge Platform — Catatan Arsitektur

- `KnowledgeProvider` (interface di `knowledge-provider.ts`) adalah satu-satunya
  titik akses ke Published Knowledge (alias produk/customer/satuan, discount
  policy). Implementasi Supabase membaca `knowledge_*` tables; fallback
  in-memory dipakai bila tabel kosong — order tetap diproses, hanya lebih
  konservatif (banyak `requiresReview`).
- Koreksi sales via UBAH disimpan sebagai `knowledge_candidates` (status
  `pending`) — **tidak pernah otomatis menjadi Published Knowledge**. Approval
  UI belum dibangun (di luar scope); untuk menyetujui kandidat secara manual:
  ```sql
  update public.knowledge_candidates set status = 'approved', reviewed_by = '<user_id>', reviewed_at = now()
  where id = '<candidate_id>';
  insert into public.knowledge_product_aliases (company_id, alias_text, product_id)
  select company_id, raw_text, (suggested_value->>'productId')::uuid
  from public.knowledge_candidates where id = '<candidate_id>';
  ```
- `sales_orders.knowledge_version` menyimpan snapshot teraudit (`v{jumlah}-{timestamp terbaru}`)
  dari Knowledge Pack yang dipakai saat ekstraksi — bukan FK ke tabel
  versioning terpisah (di luar scope MVP), tapi bisa diganti tanpa mengubah
  pemanggil (`computeKnowledgeVersion` di `knowledge-provider.ts`).

## Known Limitations (jujur, bukan disembunyikan)

- Diff koreksi UBAH dipasangkan **per-index** antara item lama & baru (asumsi
  urutan item tidak berubah) — heuristik MVP, bukan diff semantik penuh.
- `deliveryNote` disimpan sebagai teks mentah hasil capture (mis. "Jumat pagi,
  jangan lewat jam 10."), bukan diparafrase ke bentuk lain.
- Belum ada UI admin untuk approve `knowledge_candidates` atau mendaftarkan
  `telegram_identities` — keduanya manual via SQL untuk saat ini (lihat
  arsitektur interface di atas — bukan jalan buntu, tinggal ditambah dashboard).
