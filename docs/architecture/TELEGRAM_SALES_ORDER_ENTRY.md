# Telegram Sales Order Entry & Delivery Verification

> Enrollment identitas Salesman melalui token sekali pakai didokumentasikan
> terpisah di
> [TELEGRAM_SALESMAN_IDENTITY_ENROLLMENT.md](TELEGRAM_SALESMAN_IDENTITY_ENROLLMENT.md).

Dua tahap pertama vertical slice AODP (Constitution L16, AODP Waluyo Living
Knowledge Pack v1.0 §4):

`Sales Order → Delivery Verification → Invoice → Collection → Owner Alert`

**Tahap 1 — Sales Order Entry**: input order via Telegram, dari pesan masuk
sampai draft order tersimpan.
**Tahap 2 — Delivery Verification**: rekonsiliasi order→kirim→terima, evidence,
exception, invoice eligibility, owner alert. Lihat §Delivery Verification di
bawah.

Belum dibangun: Invoice final, Collection, notifikasi WhatsApp owner
sungguhan (provider belum ada — lihat §Delivery Verification → Owner Alert),
dashboard Collection/Business Guard, warehouse deduction, GPS provider
integration, ML fraud verdict — lihat scope resmi di
`docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`.

## Status Production Readiness (per audit terakhir — Production Bootstrap Preflight)

| Gate | Status |
|---|---|
| Kode lulus test/type-check/lint/build | ✅ |
| Webhook Telegram aman (secret, fail-closed, tidak percaya payload, tidak bocor internal, bypass session) | ✅ diverifikasi hidup |
| Webhook n8n aman (kredensial per-tenant, tidak percaya company_id dari payload, fail closed) | ✅ diperbaiki & diverifikasi hidup — lihat §Webhook Security Hardening |
| Telegram unregistered handshake tidak menyimpan isi pesan | ✅ diperbaiki & diverifikasi hidup — lihat §Retensi Data Handshake |
| Demo login bypass tidak mungkin aktif di production | ✅ diverifikasi: gate `NODE_ENV==="development"` (strict equality, fail closed untuk SEMUA nilai lain), 19 test baru menutup skenario misconfiguration, dikonfirmasi kode tetap ada & jalan di production server bundle (bukan tereliminasi) — lihat `lib/demo/config.ts` dan `lib/demo/config.test.ts` |
| Environment contract (server-only secret tidak bocor ke client, missing secret gagal jelas) | ✅ diaudit & diperkuat — 3 admin client call site (`dashboard/platform/tenants/**`) yang sebelumnya membuat client Supabase admin manual dengan `!` (non-null assertion, gagal tak jelas) diganti pakai `getAdminClient()` bersama; guard eksplisit ditambahkan ke `lib/supabase/client.ts`, `server.ts`, `middleware.ts` |
| Supabase **production** untuk AODP | ❌ **belum ada** — dicek langsung lewat `supabase projects list` (CLI sudah login): ada 6 project di akun ini (`asos`, `lockseth Project`, `DBR.ai`, `asos-b45-runtime-validation`, `flowsales-ai`, `BookFlow WA`), **tidak satu pun bernama/teridentifikasi sebagai AODP**. `flowsales-ai` adalah project asal fork — **ditolak eksplisit** sesuai instruksi, tidak akan pernah dipakai. Tidak ada `supabase link` yang dijalankan ke project mana pun sebagai bagian dari preflight ini. |
| Vercel project | ❌ **belum ada** — Vercel CLI tidak terpasang di lingkungan ini, tidak ada folder `.vercel/` di repo (tidak pernah di-link). |
| `TELEGRAM_BOT_TOKEN` asli dari @BotFather | ❌ belum ada — hanya nilai dev palsu (`dev-fake-token-not-real`) di `.env.local` lokal |
| `TELEGRAM_WEBHOOK_SECRET` produksi (acak, kuat) | ❌ nilai saat ini di `.env.local` (`dev-secret-for-local-testing`) hanya untuk dev, **jangan dipakai di production** |
| Kredensial `n8n_inbound_credentials` production | ❌ belum ada — tabel sudah ada (migration diterapkan lokal), tapi belum ada baris production karena belum ada project Supabase production |
| `telegram_identities` untuk sales/admin/supervisor internal | ❌ belum bisa didaftarkan — identitas internal (bukan Pak Waluyo, lihat §Onboarding Pilot di bawah) belum dikonfirmasi Founder, chat_id asli belum tersedia |

**Kesimpulan: deployment ke production belum bisa dilakukan.** Section C–E
di dokumen governance task (deployment, onboarding, acceptance test) **tidak
dijalankan** — preflight berhenti di readiness gate karena Supabase project,
Vercel project, dan Telegram bot token production semuanya belum tersedia.
Tidak ada dugaan/asumsi project mana pun yang dipakai sebagai pengganti.

> ⚠️ **Deployment Warning — Template n8n Lama:** Backend webhook n8n yang
> sudah di-hardening (fail closed, kredensial per-tenant) AMAN untuk
> dideploy. **TAPI** seluruh workflow n8n yang sudah di-import dari
> `n8n/*.json` (jika ada yang aktif di instance n8n mana pun) HARUS tetap
> **Inactive/disabled** sampai node HMAC-nya diganti ke skema Bearer token
> baru — kalau tidak, callback-nya akan selalu gagal `401` begitu backend
> production ini live (skema HMAC lama sudah tidak diterima). Lihat
> §Webhook Security Hardening → "Catatan Kompatibilitas — Template n8n Lama".

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

> **Driver memakai mekanisme yang sama.** `telegram_identities` tidak
> membedakan role — satu tabel melayani sales, admin, supervisor, **maupun
> driver**. Ikuti prosedur di bawah persis sama untuk mendaftarkan driver,
> cukup pastikan user AODP yang didaftarkan memiliki role `driver` (role ini
> sudah ada sejak awal, lihat seed di `20260626000002_create_users_roles_permissions.sql`).
> Tanpa driver terdaftar, tombol "Assign & Kirim Tugas" di halaman order
> (§Delivery Verification) akan menolak dengan pesan jelas — bukan mengarang
> `chat_id`.

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

> **Koreksi domain (penting):** Telegram identity di sini adalah untuk
> **sales/admin/supervisor internal** yang mengirim order — **BUKAN Pak
> Waluyo**. Pak Waluyo adalah **owner** distributor; perannya di AODP adalah
> penerima ringkasan/notifikasi WhatsApp executive (fitur terpisah, di luar
> scope dokumen ini), bukan pengguna operasional Telegram Sales Order Entry.
> Jangan mendaftarkan Pak Waluyo ke `telegram_identities` kecuali Founder
> **secara eksplisit** menyatakan beliau juga akan menjadi pengguna
> operasional Telegram. Contoh di bawah memakai placeholder umum
> "pengguna internal" — ganti dengan sales/admin/supervisor yang sesungguhnya
> ditunjuk Founder.

Langkah:

1. **Buat company & user lewat alur onboarding normal yang tersedia** (bukan
   insert manual mengarang data) — pastikan `company_id` dan `user_id` (AODP)
   untuk pengguna internal yang akan memakai Telegram (sales/admin/supervisor,
   ditentukan Founder) sudah ada di database production sebelum lanjut ke
   langkah berikut.
2. Deploy webhook ke production & daftarkan ke Telegram (`setWebhook`, lihat
   §Setup Bot Telegram) memakai `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`
   production yang sudah dikonfigurasi di Vercel.
3. Minta pengguna internal tersebut mengirim **satu pesan apa saja** (mis.
   "halo") ke bot Telegram dari HP-nya sendiri.
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
5. Cocokkan baris yang muncul dengan waktu pengguna tersebut mengirim pesan
   (langkah 3) — **`telegram_username` hanya label bantu, bukan identitas
   tepercaya** (Telegram username bisa diganti siapa pun). **Founder/admin
   wajib mengonfirmasi** baris mana yang benar-benar cocok dengan orang &
   akun internal yang dimaksud sebelum lanjut — baru pakai `telegram_chat_id`
   hasil query itu — **bukan angka buatan** — untuk registrasi:
   ```sql
   insert into public.telegram_identities (company_id, user_id, telegram_chat_id, telegram_username)
   values (
     '<company_id — dari langkah 1, BUKAN placeholder>',
     '<user_id AODP pengguna internal (sales/admin/supervisor) — dari langkah 1, BUKAN Pak Waluyo kecuali dikonfirmasi eksplisit>',
     <telegram_chat_id hasil query langkah 4, dikonfirmasi Founder di langkah 5>,
     '<telegram_username hasil query langkah 4, opsional, hanya label>'
   );
   ```
6. Minta pengguna tersebut mengirim pesan order lagi — sekarang harus
   mendapat balasan draft, bukan diam.

Prosedur ini **tidak pernah butuh admin menanyakan Telegram user ID secara
manual ke sales** (rawan salah ketik) — sumbernya selalu payload asli yang
sudah tercatat sistem, dan **tidak pernah mengarang** nama/email/role/chat_id/
company_id/user_id.

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

## Delivery Verification

Tahap 2 vertical slice — implementasi MVP per
`docs/product/delivery-verification/AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`
dan `docs/knowledge/packs/waluyo/AODP_WALUYO_LIVING_KNOWLEDGE_PACK_v1.0.md` §4–§9.
Business logic 100% di `apps/web/src/lib/delivery/` (`types.ts`, `repository.ts`,
`service.ts`, `confirmation.ts`, `workflow.ts`) — terpisah dari transport
Telegram, testable via `InMemoryDeliveryRepository` (lihat `workflow.test.ts`,
32 skenario — termasuk gap-closure fix untuk owner alert coverage & aggregate
lifecycle, lihat §Owner Alert dan §Aggregate Lifecycle di bawah).

### Arsitektur & Dispatch

Delivery memakai **bot Telegram yang sama** dan **ledger idempotency yang
sama** (`telegram_update_events`) dengan Sales Order Entry — Telegram hanya
mengizinkan satu webhook URL per bot, jadi tidak mungkin (dan tidak perlu)
membuat webhook terpisah. Routing internal:

```
processTelegramUpdate() [lib/sales-orders/workflow.ts]
  → resolveIdentity()                — sama seperti Sales Order
  → cek delivery_conversation_state   — bila awaiting != 'none', didahulukan
      → processDeliveryConversation() [lib/delivery/workflow.ts]
  → (jika tidak) lanjut ke logika Sales Order seperti biasa
```

Satu identity Telegram bisa menjadi driver, sales, atau keduanya — dibedakan
lewat `delivery_conversation_state` (terpisah dari `telegram_conversation_state`
milik Sales Order) yang menentukan pesan masuk berikutnya diproses sebagai
apa.

### Membuat Delivery (assign driver)

Belum ada trigger otomatis dari konfirmasi order — **sengaja manual**, dipicu
owner/manager/admin lewat tombol "Assign & Kirim Tugas" di halaman detail
order (`/dashboard/orders/[id]`, muncul saat status order `confirmed` dan
belum ada delivery). Server action `createDeliveryAction`
(`lib/delivery/actions.ts`):

- Tenant **selalu** dari sesi (`getAuthUser()`), tidak pernah dari input form.
- Driver **wajib** sudah terdaftar di `telegram_identities` — tidak pernah
  mengarang `chat_id` (sama prinsipnya dengan §Mendaftarkan Sales di atas;
  driver didaftarkan lewat prosedur yang sama, cukup ganti role user ke `driver`).
- Idempotent lewat `deliveries.idempotency_key = 'order:<sales_order_id>'` —
  memanggil action dua kali untuk order yang sama tidak membuat delivery ganda.
- Mengirim pesan tugas awal ke driver via Telegram, lalu men-set
  `delivery_conversation_state.awaiting = 'start_confirmation'`.

### Alur Telegram Driver (happy path)

1. Driver menerima pesan tugas, balas **`MULAI KIRIM`** → status `dispatched`
   (MVP: seluruh `ordered_quantity` otomatis jadi `dispatched_quantity` —
   tidak ada langkah picking/warehouse terpisah, sesuai exclusion Implementation
   Gate §3 "Full warehouse/WMS optimization").
2. Tiba di toko, balas salah satu: **`DITERIMA PENUH`**, **`DITERIMA SEBAGIAN`**,
   **`DITOLAK`**, **`TOKO TUTUP`**, atau **`GAGAL`** → status `arrived`.
3. Untuk `DITERIMA SEBAGIAN`/`DITOLAK`: bot menanyakan jumlah diterima per
   item satu per satu (angka polos, bukan tombol — konsisten dengan pola
   KONFIRMASI/UBAH Sales Order). Sisa (dispatched − diterima) otomatis masuk
   `unresolvedQuantity` (untuk partial) atau `rejectedQuantity` (untuk
   rejected) — MVP tidak punya langkah terpisah untuk memilah retur vs rusak,
   lihat §Known Limitations.
4. Bot meminta **reason code** (daftar 11 kode dari Implementation Gate §5,
   `OTHER_REQUIRES_NOTE` wajib disertai catatan). `TOKO TUTUP` melewati
   langkah ini (reason otomatis `STORE_CLOSED`).
5. Bot meminta **evidence** sesuai outcome (lihat tabel di bawah) — mengirim
   foto (evidence foto lalu tanda tangan, dalam urutan itu), share location
   Telegram (hanya wajib untuk `TOKO TUTUP`), atau nama penerima sebagai
   teks. **Tidak pernah diloloskan tanpa bukti asli** — bot terus meminta
   ulang sampai lengkap, tidak pernah mengarang lokasi/tanda tangan yang
   belum dikirim driver.
6. Bot menampilkan **ringkasan rekonsiliasi** (dikirim vs diterima, selisih,
   nilai invoice eligible).
7. Driver balas **`KONFIRMASI KIRIM`** → transaksional: quantities disimpan,
   exception (bila ada) dicatat, recipient dicatat, delivery masuk status
   final, owner alert dibuat bila relevan. **Idempotent** — `KONFIRMASI KIRIM`
   berulang pada delivery yang sudah final tidak mengubah apa pun (dibalas
   "sudah final sebelumnya", mirror pola `confirmOrder()` di Sales Order).

### Evidence Minimum per Outcome

| Outcome | Status Final | Evidence Wajib | Reason Wajib |
|---|---|---|---|
| `DITERIMA PENUH` | `verified` | foto + tanda tangan + nama penerima | tidak |
| `DITERIMA SEBAGIAN` | `partially_received` | foto + tanda tangan + nama penerima | ya |
| `DITOLAK` | `rejected` | foto | ya |
| `TOKO TUTUP` | `store_closed` | foto + **lokasi** (DV-03, wajib khusus outcome ini) | tidak (otomatis `STORE_CLOSED`) |
| `GAGAL` | `failed` | tidak ada yang wajib | ya |

Sumber aturan: `AODP_WALUYO_LIVING_KNOWLEDGE_PACK_v1.0.md` §5 (DV-01–DV-04).
Kombinasi lain (mis. bobot evidence tambahan) belum dikalibrasi — lihat Pack §10.

### Invoice Eligibility Contract

`computeInvoiceEligibility()` (`lib/delivery/service.ts`) — **query murni,
bukan invoice** — dikonsumsi tahap Invoice berikutnya:

```ts
interface InvoiceEligibility {
  deliveryId: string; salesOrderId: string; status: DeliveryStatus; isFinal: boolean;
  items: { salesOrderItemId, deliveryItemId, productName, eligibleQuantity, unitPrice, eligibleValue }[];
  totalEligibleValue: number; totalOrderedValue: number; varianceValue: number;
}
```

`eligibleQuantity` **selalu** dari `received_quantity` — tidak pernah
`ordered_quantity`/`dispatched_quantity` (Implementation Gate §9, diverifikasi
test #8/#9 dan live smoke test terhadap Supabase asli).

### Owner Alert (Outbox WhatsApp) — Policy Berbasis Dampak Bisnis

> **Update (gap-closure fix, 2026-07-16):** versi awal hanya membuat alert
> untuk outcome `partially_received`/`rejected` secara hardcode. Ini **tidak
> memenuhi** Living Knowledge Pack v1.0 §4.5 (owner harus melihat *seluruh*
> penyimpangan yang butuh keputusannya, bukan subset yang di-hardcode).
> Diganti dengan `requiresOwnerAlert()` (`lib/delivery/service.ts`) —
> kebijakan terpusat berbasis dampak bisnis, bukan daftar outcome tertutup.

`requiresOwnerAlert(finalStatus, invoiceEligibility, exceptions)` membuat
pending alert jika **salah satu** benar:

1. Invoice eligibility bervariansi dari nilai order (`varianceValue !== 0`);
2. Outcome termasuk kelas yang inheren butuh perhatian owner: `store_closed`,
   `rejected`, `failed`, `partially_received` — barang tidak sampai sesuai
   rencana, terlepas dari nilai variance-nya (`store_closed`/`failed` selalu
   punya `acceptedValue = 0`, jadi kriteria #1 pun sudah pasti kena — kriteria
   #2 adalah jaring pengaman eksplisit, bukan duplikasi tanpa tujuan);
3. Ada exception dengan severity `medium`/`high`.

**Satu-satunya pengecualian:** delivery `verified` (full, tanpa variance)
**tidak pernah** menghasilkan alert — itulah jalur "semua beres" (Pack v1.0
§4.5: *"Prioritas, bukan volume"*, test #15).

| Outcome | Alert? | Payload menjelaskan |
|---|---|---|
| `verified` (full, tanpa variance) | **Tidak pernah** | — |
| `partially_received` | Selalu (variance ≠ 0) | Selisih nilai, minta verifikasi sebelum invoice |
| `rejected` | Selalu | Alasan penolakan, severity `high` bila 0% diterima |
| `store_closed` | **Selalu (baru)** | `acceptedValue = 0`, rekomendasi jadwal ulang + cek jam operasional |
| `failed` | **Selalu (baru)** | Reason code + evidence yang tersedia (atau "tidak ada" bila memang tidak dikirim — tidak dikarang) |

Tabel `owner_alerts` — **belum ada provider WhatsApp aktif**, jadi alert
**selalu tersimpan `status = 'pending'`** dan **tidak pernah** ditandai
`'sent'` oleh kode saat ini. Idempotent: hanya dibuat sekali per finalize
sungguhan (retry `KONFIRMASI KIRIM` pada delivery yang sudah final tidak
pernah membuat alert kedua — dijaga oleh guard `alreadyFinalized` yang sama
dengan §Aggregate Lifecycle di bawah). Tenant-scoped lewat `identity.companyId`
server-side, tidak pernah dari teks bebas driver (test #16, #17) — ditegakkan
juga oleh RLS `owner_alerts_select`.

Mengirim alert pending secara nyata (integrasi provider WhatsApp) **di luar
scope MVP ini** — begitu provider tersedia, proses terpisah bisa membaca
`owner_alerts WHERE status = 'pending'`, mengirim, lalu `UPDATE ... SET status
= 'sent', sent_at = now()`.

### Aggregate Lifecycle — `deliveries.status` vs `sales_orders.status`

> **Baru (gap-closure fix, 2026-07-16).**

Dua status yang **berbeda level dan tidak boleh disamakan**:

- **`deliveries.status`** — status **satu delivery attempt** (planned →
  dispatched → arrived → verified/partially_received/rejected/store_closed/failed).
  Satu `sales_order` bisa punya lebih dari satu delivery attempt (re-delivery
  setelah `store_closed`/`failed`) — lihat `attempt_number`.
- **`sales_orders.status`** — lifecycle **agregat** order (`confirmed` →
  `delivering` → `delivered`, enum yang sudah ada sejak migration 003 lewat
  `updateOrderStatusAction`/`StatusUpdater` manual). Menjawab pertanyaan
  "apakah SELURUH barang pesanan ini sudah benar-benar sampai", lintas semua
  attempt.

Disinkronkan otomatis lewat fungsi Postgres atomic
`sync_sales_order_delivery_status(sales_order_id)`
(`supabase/migrations/20260717000001_delivery_order_lifecycle_sync.sql`),
dipanggil dari `lib/delivery/workflow.ts` di dua titik:

1. **Setelah `MULAI KIRIM` (dispatch pertama)** — bila order masih `confirmed`,
   pindah ke `delivering`. No-op idempoten bila sudah `delivering` (attempt
   kedua dst. tidak mengulang transisi ini).
2. **Setelah `KONFIRMASI KIRIM` (finalize)**, hanya pada finalize sungguhan
   (bukan retry) — menghitung ulang **agregat** `SUM(delivery_items.received_quantity)`
   lintas **seluruh** delivery attempt milik order, per `sales_order_item`.
   Bila **setiap** item sudah tertutup penuh → `delivered` (+ `delivered_at`).
   Bila belum → tetap `delivering`.

Sifat penting:

- **Idempoten** — dihitung ulang dari sumber kebenaran (SUM langsung dari
  `delivery_items`) setiap kali dipanggil, bukan increment/counter yang bisa
  drift. Memanggil berkali-kali (retry) menghasilkan keputusan yang sama.
- **Atomic** — fungsi memakai `SELECT ... FOR UPDATE` mengunci baris order
  selama komputasi, sehingga dua delivery attempt yang finalize hampir
  bersamaan untuk order yang sama tidak saling menimpa keputusan status
  (diserialisasi oleh lock, bukan race).
- **Tidak double count** — setiap `delivery_items` row hanya dimutasi oleh
  attempt pemiliknya sendiri; agregat murni menjumlahkan apa yang benar-benar
  tercatat verified. Attempt yang gagal/ditolak/toko tutup otomatis
  berkontribusi 0 untuk item yang tidak diterima — tidak perlu pengecualian khusus.
  Sejak fix invariant kuantitas (lihat subbagian di bawah), attempt baru
  memakai OUTSTANDING sebagai `ordered_quantity`-nya sendiri, bukan quantity
  asli order — batasan yang sebelumnya tercatat di sini sudah tidak berlaku.
- **Tidak ada enum baru** — tetap `confirmed`/`delivering`/`delivered` yang
  sudah ada. `store_closed`/`failed`/`rejected` (di level delivery attempt)
  membuat order tetap `delivering` — tidak pernah mundur, tidak pernah
  dipaksa `delivered`.
- **Koeksistensi dengan `StatusUpdater` manual** — tombol update status
  manual di halaman order (`updateOrderStatusAction`, pre-existing) **tetap
  berfungsi apa adanya** dan independen dari sinkronisasi otomatis ini; owner/
  manager tetap bisa override manual kapan pun (prinsip Constitution "AI
  merekomendasikan, owner memutuskan"). Sinkronisasi otomatis hanya berjalan
  dari alur Delivery Verification Telegram, tidak pernah dari UI manual.

### Invariant Kuantitas Agregat — Anti Over-Delivery

> **Fix (audit invariant, 2026-07-16).** Diaudit dan **dibuktikan live** bahwa
> sebelum fix ini, SUM `received_quantity` lintas beberapa delivery attempt
> untuk satu `sales_order_item` **bisa melebihi** `ordered_quantity` tanpa
> ditolak sama sekali (attempt A menerima 60/100, attempt B bisa menerima 50
> lagi → 110/100 diterima, order bahkan ditandai `delivered`). CHECK
> constraint yang ada hanya per-baris (`received_quantity + ... <=
> dispatched_quantity`), tidak lintas baris/attempt.

Ditutup dengan fungsi Postgres atomic
`finalize_delivery_item_quantities(delivery_id, item_outcomes)`
(`supabase/migrations/20260718000001_delivery_quantity_invariant.sql`) —
**satu-satunya jalur** menulis quantity final delivery, menggantikan
`updateItemOutcome()` sekuensial yang lama:

1. Mengunci (`FOR UPDATE`) seluruh `sales_order_items` yang terlibat, dalam
   urutan id konsisten (mencegah deadlock antar finalize bersamaan).
2. Untuk tiap item: `outstanding = ordered_quantity - SUM(received_quantity
   dari delivery attempt LAIN)`. Baris milik attempt itu sendiri dikecualikan
   dari perhitungan "attempt lain" — retry tetap idempotent.
3. Bila `received_quantity` yang diajukan `>` outstanding →
   **`RAISE EXCEPTION QUANTITY_EXCEEDS_OUTSTANDING`** (ditolak, transaksi
   fungsi batal seluruhnya — **tidak ada silent clamp**, tidak ada penulisan
   sebagian).
4. Bila lolos untuk SEMUA item dalam satu delivery, baru ditulis.

Lapisan tambahan (defense in depth, bukan pengganti):

- **Validasi dini** di `handleItemQuantity` (`lib/delivery/workflow.ts`) —
  `getOutstandingQuantity()` dicek sebelum driver menyelesaikan seluruh alur
  evidence, supaya penolakan (bila ada) terasa cepat. Otoritas tetap di
  fungsi atomic saat `KONFIRMASI KIRIM`.
- **Delivery attempt baru default ke outstanding** — `getConfirmedOrder()`
  sekarang mengembalikan `quantity` = OUTSTANDING (bukan `sales_order_items.quantity`
  mentah) per item, sehingga `dispatched_quantity` attempt baru otomatis
  terbatas ke sisa yang benar-benar belum diterima.
- **Invoice eligibility agregat** — `computeAggregateInvoiceEligibility()`
  (`lib/delivery/service.ts`) + `getAggregateInvoiceEligibilityData()`
  (repository) menjumlahkan `received_quantity` lintas seluruh attempt milik
  satu order, di-cap ke `ordered_quantity` — bila suatu saat SUM historis
  ternyata melebihi (seharusnya mustahil sejak fix ini), `dataIntegrityWarning`
  diset `true` secara eksplisit, **bukan** disembunyikan lewat clamp diam-diam.

**Dibuktikan live terhadap Supabase lokal sungguhan** (bukan hanya in-memory):
order=100, attempt A commit 60 (diterima), attempt B mencoba 50 → **ditolak
`HTTP 400 QUANTITY_EXCEEDS_OUTSTANDING`** dengan `received_quantity` B tetap
0 (tidak ada penulisan sebagian); attempt B dengan tepat 40 → **diterima**,
total 60+40=100, `sync_sales_order_delivery_status` menandai order `delivered`.

### Reason Code (v1, dari Implementation Gate §5)

`STORE_CLOSED` · `CUSTOMER_PARTIAL_ACCEPTANCE` · `CUSTOMER_REJECTED` ·
`ITEM_DAMAGED` · `ITEM_MISMATCH` · `QUANTITY_MISMATCH` ·
`PRICE_OR_DISCOUNT_DISPUTE` · `RECIPIENT_NOT_AUTHORIZED` ·
`ADDRESS_NOT_FOUND` · `VEHICLE_OR_DRIVER_ISSUE` · `OTHER_REQUIRES_NOTE`
(wajib catatan).

### UI — Order Detail Page

`/dashboard/orders/[id]` menampilkan (hanya bila delivery ada):
status, rekonsiliasi per item (dipesan/dikirim/diterima/selisih), invoice
eligible value, exception + severity, recipient, ringkasan evidence (ikon
per tipe), timeline `delivery_events`, dan badge status owner alert
(pending/sent/gagal). Tidak ada dashboard baru — menumpang di halaman order
yang sudah ada, sesuai instruksi scope.

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

Bila update didelegasikan ke alur Delivery Verification, `outcome` di respons
adalah outcome delivery-nya langsung (bukan `"delivery"` literal — route
me-*flatten*-kannya, lihat `app/api/webhooks/telegram/route.ts`):

| outcome (delivery) | Arti |
|---|---|
| `dispatched` | `MULAI KIRIM` diterima, status → `dispatched` |
| `outcome_recorded` | Outcome (DITERIMA PENUH/SEBAGIAN/DITOLAK/TOKO TUTUP/GAGAL) tercatat |
| `quantity_recorded` | Jumlah satu item tercatat, lanjut item berikutnya atau ke reason |
| `reason_recorded` / `reason_note_recorded` | Reason code / catatan tercatat |
| `evidence_recorded` | Satu bukti tercatat — bisa masih kurang (evidence lain diminta lagi) atau sudah lengkap (lanjut ke preview) |
| `finalized` | `KONFIRMASI KIRIM` diproses; `alreadyFinalized: true` bila diulang pada delivery yang sudah final |
| `invalid_input` | Input tidak sesuai yang diharapkan di state saat ini (angka di luar rentang, keyword salah, dst.) |
| `no_pending_delivery` | Tidak ada delivery yang sedang menunggu untuk identity ini |

## Menjalankan Test

```bash
pnpm --filter @flowsales/web test
```

- 13 skenario di `apps/web/src/lib/sales-orders/workflow.test.ts` (Sales Order Entry).
- 32 skenario di `apps/web/src/lib/delivery/workflow.test.ts` (Delivery
  Verification — full/partial/store_closed/rejected/changed-recipient/
  missing-evidence/duplicate/invoice-eligibility/tenant-isolation/owner-alert
  policy berbasis dampak bisnis/aggregate order lifecycle/multi-attempt).

Seluruhnya memakai in-memory fakes (`InMemorySalesOrderRepository`,
`InMemoryKnowledgeProvider`, `InMemoryDeliveryRepository`) — tidak butuh
Supabase/Telegram hidup. Selain itu, alur Delivery Verification juga sudah
diverifikasi hidup end-to-end terhadap Supabase lokal sungguhan (full delivery,
partial delivery, duplicate KONFIRMASI KIRIM, dan — sejak gap-closure fix —
`store_closed` yang menghasilkan owner alert live + transisi
`confirmed → delivering → delivered` live lewat fungsi Postgres
`sync_sales_order_delivery_status`) — bukan hanya in-memory.

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

**Delivery Verification:**

- MVP mengasumsikan seluruh `ordered_quantity` dikirim sekaligus (dispatch
  otomatis saat `MULAI KIRIM`) — tidak ada langkah picking/partial-dispatch
  dari gudang (sesuai exclusion Implementation Gate §3).
- Sisa kuantitas yang tidak diterima otomatis diklasifikasi `unresolved`
  (partial) atau `rejected` (rejected) — belum ada langkah terpisah bagi
  driver memilah retur vs rusak vs belum jelas; kolom `returned_quantity`
  ada di schema tapi belum diisi lewat alur Telegram saat ini.
- Deteksi foto vs tanda tangan murni berdasar **urutan kirim** (foto pertama
  = bukti barang, foto kedua = tanda tangan) — Telegram tidak membedakan tipe
  media ini secara native. Driver yang mengirim dalam urutan salah akan
  tercatat dengan label yang tertukar.
- `evidenceSummary` pada owner alert berupa daftar tipe evidence (mis.
  "photo, signature"), belum menyertakan thumbnail/link — pihak yang
  menindaklanjuti perlu membuka data delivery langsung untuk melihat bukti.
- Severity exception (`low`/`medium`/`high`) dihitung dari aturan kualitatif
  (outcome + apakah ada penerimaan sama sekali), **bukan** dari ambang nilai
  nominal — materiality threshold belum dikalibrasi (Pack v1.0 §10).
- `owner_alerts` tidak pernah otomatis terkirim — tidak ada provider WhatsApp
  aktif di MVP ini, alert tetap `pending` sampai proses pengiriman terpisah
  dibangun.
- Pembuatan delivery dari order confirmed **manual** (tombol di halaman
  order), bukan otomatis — mengikuti instruksi scope "jangan membuka
  dashboard/module baru yang luas".
- Re-delivery attempt (attempt ke-2 dst. untuk order yang sama) men-*snapshot*
  `ordered_quantity` dari `sales_order_items` **asli** (bukan sisa
  outstanding) — agregasi lifecycle (§Aggregate Lifecycle) tetap benar karena
  berbasis SUM `received_quantity`, tapi tampilan "dipesan" pada attempt
  kedua bisa terlihat sama dengan attempt pertama, bukan sisa yang
  sebenarnya perlu dikirim ulang.
- `sync_sales_order_delivery_status` adalah **satu-satunya fungsi Postgres
  (RPC)** di codebase ini — seluruh modul lain memakai REST/PostgREST
  langsung tanpa stored procedure. Dipilih khusus untuk langkah ini karena
  butuh jaminan atomic (row lock + agregat) yang tidak bisa didapat dari
  beberapa panggilan REST berurutan — bukan pola baru yang dipakai di tempat
  lain, sengaja dibatasi ke satu titik yang benar-benar butuh.
