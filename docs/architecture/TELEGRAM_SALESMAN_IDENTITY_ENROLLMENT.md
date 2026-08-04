# Telegram Salesman Identity Enrollment

## Tujuan

Menghubungkan satu akun internal dengan role **Salesman** ke satu chat pribadi
Telegram tanpa mempercayai `company_id`, `user_id`, username, atau teks bebas
dari payload Telegram.

Enrollment ini melengkapi handshake `rejected_unregistered` yang sudah ada.
Chat tak dikenal tetap tidak dapat membuat order sampai berhasil mengklaim
token enrollment resmi.

## Kebijakan non-biometrik (keputusan Waluyo, design partner)

Enrollment Salesman AODP Waluyo **tidak pernah** meminta atau memproses KTP,
selfie, foto identitas, face matching, face embedding, atau liveness check.
Identitas Salesman dibuktikan murni melalui kepemilikan chat Telegram pribadi
(one-time pairing token), bukan biometrik. Order tetap dapat masuk lewat
WhatsApp/telepon tanpa kehadiran fisik Salesman. Foto pada Delivery
Verification (modul terpisah) hanya untuk bukti barang/toko tutup/penolakan/
retur/selisih — bukan selfie wajah, dan tidak terhubung ke enrollment ini.
Fokus intelligence AODP Waluyo: omzet, PO, AR, EC, dan call — bukan biometric
review. Keputusan ini spesifik untuk implementasi Waluyo; modul ini tidak
pernah memiliki dependency kode/skema biometrik sama sekali (lihat gate
Non-Biometric Salesman Enrollment — impact audit tidak menemukan kode/skema/
dokumentasi biometrik di repository manapun).

## Alur operasional

0. Owner, Manager, atau Admin membuka **Dashboard → Pengguna → Tambah
   Salesman**, mengisi nama/email/no. telepon/password sementara. Sistem
   membuat akun (Supabase Auth + profil `public.users` + role `sales`) pada
   tenant milik admin yang login — `company_id` selalu dari sesi server,
   tidak pernah dari input form. Salesman baru muncul berstatus **Belum
   Terhubung**.
1. Owner, Manager, atau Admin membuka **Dashboard → Pengguna**.
2. Pada baris Salesman, pilih **Buat tautan Telegram** (atau **Terbitkan
   ulang tautan** jika status Pairing Kedaluwarsa/Diputuskan).
3. Sistem menampilkan command sekali pakai dan, bila
   `TELEGRAM_BOT_USERNAME` tersedia, deep-link Telegram. Status berubah
   **Pairing Code Aktif**.
4. Admin mengirim tautan tersebut kepada Salesman yang dimaksud.
5. Salesman membuka tautan melalui chat pribadi dengan bot.
6. Bot mengklaim token secara atomik dan membuat `telegram_identities`.
   Status berubah **Terhubung**.
7. Bot memberi konfirmasi; pesan berikutnya dari chat itu baru dapat masuk ke
   workflow Sales Order atau Delivery Verification.

## Status Salesman ↔ Telegram

Direpresentasikan dari data yang sudah ada (`telegram_identities.is_active`,
`telegram_enrollment_tokens.claimed_at/revoked_at/expires_at`) — tidak ada
kolom/enum status baru. Resolusi murni: `apps/web/src/lib/salesman/status.ts`.

| Status               | Kondisi                                                          |
|-----------------------|-------------------------------------------------------------------|
| Belum Terhubung       | Tidak ada identity aktif, tidak ada token pending, tidak pernah terhubung |
| Pairing Code Aktif    | Token diterbitkan, belum diklaim/dicabut, belum kedaluwarsa       |
| Terhubung             | Ada `telegram_identities` aktif                                   |
| Pairing Kedaluwarsa   | Token pending sudah melewati `expires_at`                         |
| Diputuskan/Dicabut    | Tidak ada identity aktif, tapi pernah ada identity yang di-revoke |

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
  `sales`, `admin`, atau `owner` (digeneralisasi Gate 3E-D1-R1 — sebelumnya
  hanya `sales`). Generalisasi ini HANYA membuat pairing-nya mungkin;
  workflow Sales Order/Delivery/Dispute/Menu Telegram tetap capability
  `sales.order.telegram` yang HANYA diizinkan untuk role `sales` — dicek
  ulang secara terpisah di `apps/web/src/lib/telegram-enrollment/capability.ts`
  dan `SalesOrderTelegramRepository.hasSalesOrderCapability`, fail-closed.
  UI Dashboard → Pengguna masih hanya menampilkan tombol pairing untuk baris
  role `sales`; pairing Owner/Admin (untuk `password.reset.self`, belum
  diimplementasikan) menyusul di gate terpisah.
- Satu chat Telegram tidak dapat dihubungkan ke dua user.
- Satu internal user tidak dapat mempunyai dua identity aktif.
- Routine issue, claim, dan revoke tidak dapat dipanggil `PUBLIC`, `anon`, atau
  `authenticated`; hanya `service_role`.
- Command enrollment tidak pernah disimpan dalam `telegram_update_events`.
  Event ledger hanya menyimpan metadata minimum.
- Putus koneksi menghapus conversation state aktif agar enrollment baru tidak
  melanjutkan order/delivery lama.
- Sesi Demo tidak dapat menerbitkan atau mencabut enrollment.
- Sesi Demo tidak dapat menambahkan Salesman baru.
- Admin Tambah Salesman: `company_id` dan `actor_id` selalu dari sesi
  server (`getAuthUser()`), tidak pernah dari body request. Role yang
  dibuat selalu `sales` (dicari via lookup role, bukan parameter bebas).
  Kegagalan parsial (mis. insert profil gagal setelah auth user dibuat)
  memicu rollback — auth user dihapus (cascade menghapus profil), tidak
  pernah meninggalkan akun yatim. Lihat
  `apps/web/src/lib/salesman/workflow.ts`.

## Coverage Area (Wilayah Kerja Salesman)

Coverage area adalah atribut operasional Salesman yang terpisah dari
enrollment identity di atas — keduanya sama-sama "properti Salesman" tapi
tidak saling bergantung (Salesman dapat terhubung Telegram tanpa area, atau
punya area tanpa Telegram).

- **Sumber daftar wilayah**: `companies.settings.coverage_areas` (JSONB array
  of string) — daftar wilayah valid ditentukan **per tenant**, bukan
  hardcode nama wilayah/kota apa pun di core platform. Field ini sudah
  dipakai sebelumnya oleh gate Demo Environment untuk keperluan yang sama.
- **Multi-area**: satu Salesman dapat memiliki lebih dari satu wilayah kerja
  sekaligus — direpresentasikan sebagai relasi many-to-many
  (`public.salesman_coverage_areas`, satu baris per pasangan
  Salesman×wilayah), bukan kolom `users.area` tunggal.
- **Tenant-scoped**: setiap baris `salesman_coverage_areas` terikat
  `company_id`; RPC `assign_salesman_coverage_areas(p_company_id, p_user_id,
  p_areas, p_actor_id)` memvalidasi actor DAN target berada di tenant yang
  sama sebelum menyentuh baris apa pun, dan setiap wilayah yang diajukan
  harus menjadi anggota `companies.settings.coverage_areas` milik tenant
  tersebut (fail-closed — wilayah di luar daftar tenant ditolak seluruhnya,
  tidak ada assignment parsial).
- **Bukan KPI/target**: coverage area murni menyatakan "wilayah mana yang
  boleh/biasa ditangani Salesman ini" untuk keperluan operasional (mis.
  konteks AI Dispatch Planner). Field ini **tidak** menghasilkan skor,
  target, atau achievement — KPI Foundation belum diimplementasikan di
  platform ini sama sekali (lihat batasan berulang di gate-gate lain).
- **Diperbarui admin berwenang**: hanya role `owner`/`manager`/`admin`/
  `super_admin` aktif pada tenant yang sama yang dapat memanggil RPC
  assignment (diverifikasi di dalam RPC, bukan hanya di layer UI). Assignment
  bersifat "replace penuh" dalam satu pemanggilan (hapus set lama, insert set
  baru) sehingga panggilan berulang dengan wilayah yang sama otomatis
  idempotent, dan tercatat ke `audit_logs`
  (`action = 'salesman.coverage_area_updated'`, `old_data`/`new_data` berisi
  daftar wilayah sebelum/sesudah).

## Database

Migration:

`supabase/migrations/20260722000001_telegram_salesman_identity_enrollment.sql`

Objek baru:

- `telegram_enrollment_tokens`
- `issue_telegram_salesman_enrollment(...)`
- `claim_telegram_salesman_identity(...)`
- `revoke_telegram_salesman_identity(...)`
- unique partial index `uq_telegram_identity_active_user`

Coverage area (migration terpisah):

`supabase/migrations/20260724000001_salesman_coverage_areas.sql`

Objek baru:

- `salesman_coverage_areas`
- `assign_salesman_coverage_areas(...)`

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
