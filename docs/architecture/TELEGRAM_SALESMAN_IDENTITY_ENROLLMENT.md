# Telegram Salesman Identity Enrollment

## Tujuan

Menghubungkan satu akun internal dengan role **Salesman** ke satu chat pribadi
Telegram tanpa mempercayai `company_id`, `user_id`, username, atau teks bebas
dari payload Telegram.

Enrollment ini melengkapi handshake `rejected_unregistered` yang sudah ada.
Chat tak dikenal tetap tidak dapat membuat order sampai berhasil mengklaim
token enrollment resmi.

## Alur operasional

1. Owner, Manager, atau Admin membuka **Dashboard → Pengguna**.
2. Pada baris user dengan role Salesman, pilih **Buat tautan Telegram**.
3. Sistem menampilkan command sekali pakai dan, bila
   `TELEGRAM_BOT_USERNAME` tersedia, deep-link Telegram.
4. Admin mengirim tautan tersebut kepada Salesman yang dimaksud.
5. Salesman membuka tautan melalui chat pribadi dengan bot.
6. Bot mengklaim token secara atomik dan membuat `telegram_identities`.
7. Bot memberi konfirmasi; pesan berikutnya dari chat itu baru dapat masuk ke
   workflow Sales Order atau Delivery Verification.

Token berlaku **30 menit**, hanya dapat digunakan sekali, dan token baru
otomatis mencabut token pending sebelumnya milik Salesman yang sama.
Retry dari chat dan akun Telegram yang persis sama bersifat idempotent untuk
memulihkan kegagalan jaringan setelah klaim; akun lain tetap ditolak.

## Kontrak keamanan

- Token mentah dibuat dengan 192-bit CSPRNG dan hanya dikembalikan sekali ke
  browser admin.
- Database hanya menyimpan `SHA-256(token)` pada
  `telegram_enrollment_tokens.token_hash`.
- Klaim hanya menerima chat Telegram bertipe `private` dan mewajibkan
  `chat.id === from.id`.
- Tenant dan internal user selalu berasal dari token server-side.
- Target wajib user aktif, berada di tenant penerbit, dan mempunyai role
  `sales`.
- Satu chat Telegram tidak dapat dihubungkan ke dua user.
- Satu internal user tidak dapat mempunyai dua identity aktif.
- Routine issue, claim, dan revoke tidak dapat dipanggil `PUBLIC`, `anon`, atau
  `authenticated`; hanya `service_role`.
- Command enrollment tidak pernah disimpan dalam `telegram_update_events`.
  Event ledger hanya menyimpan metadata minimum.
- Putus koneksi menghapus conversation state aktif agar enrollment baru tidak
  melanjutkan order/delivery lama.
- Sesi Demo tidak dapat menerbitkan atau mencabut enrollment.

## Database

Migration:

`supabase/migrations/20260722000001_telegram_salesman_identity_enrollment.sql`

Objek baru:

- `telegram_enrollment_tokens`
- `issue_telegram_salesman_enrollment(...)`
- `claim_telegram_salesman_identity(...)`
- `revoke_telegram_salesman_identity(...)`
- unique partial index `uq_telegram_identity_active_user`

Migration sengaja fail-closed bila menemukan user lama yang sudah mempunyai
lebih dari satu `telegram_identities` aktif. Data tersebut harus direview
manual; migration tidak menghapus atau memilih identity secara diam-diam.

## Konfigurasi

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_BOT_USERNAME=AODP_WaluyoBot
```

`TELEGRAM_BOT_USERNAME` bukan secret. Bila tidak diisi, admin masih dapat
menyalin command `/start enroll_<token>` secara manual.

## Verifikasi

```bash
pnpm test
pnpm type-check
pnpm lint
pnpm build
```

Untuk database lokal:

```bash
supabase db reset
```

Lalu verifikasi bahwa role `anon` dan `authenticated` tidak dapat menjalankan
ketiga routine enrollment, sedangkan webhook dengan service role dapat
mengklaim token yang valid tepat satu kali.
