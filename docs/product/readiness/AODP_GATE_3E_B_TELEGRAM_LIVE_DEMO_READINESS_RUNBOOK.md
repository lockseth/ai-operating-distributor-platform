# Gate 3E-B — Telegram Sales Order Live Demo Readiness Runbook

> Runbook operator singkat. Untuk arsitektur lengkap alur Telegram Sales
> Order, lihat [`docs/architecture/TELEGRAM_SALES_ORDER_ENTRY.md`](../../architecture/TELEGRAM_SALES_ORDER_ENTRY.md).
> Untuk audit/gap Gate 3E-B (root cause, file yang diubah, bukti test), lihat
> laporan hasil gate di riwayat sesi — tidak diduplikasi di sini.

Dataset & akun demo: **permanen dari Gate 3E-A** (tenant "PT. Sumber Warna
Alam Sudiada", `scripts/seed-gate-3e-a-dataset.ts`). Runbook ini **tidak**
membuat toko/produk/akun baru — hanya menambah alias Knowledge Pack yang
menunjuk ke data yang sudah ada (`scripts/seed-gate-3e-b-knowledge-aliases.ts`)
dan menjalankan alur order yang sudah dikeraskan (migration
`20260908000001_gate_3e_b_order_intake_validation.sql`).

## 1. Env/Config yang Diperlukan (tanpa nilai secret)

Di Vercel project AODP demo, scope Production/Preview sesuai target deploy:

| Variable | Sumber | Catatan |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather | Token bot demo — **bukan** `dev-fake-token-not-real` dari `.env.local` |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` | Harus sama persis dengan `secret_token` yang didaftarkan via `setWebhook` |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `DATABASE_URL` | Supabase project **AODP-Waluyo-Demo** | Wajib project demo AODP, bukan `flowsales-ai` (project asal fork — dilarang eksplisit) |

Lokal (operator, untuk menjalankan script seed): `.env.demo.local` di root
repo — sudah berisi `NEXT_PUBLIC_SUPABASE_DEMO_URL` /
`SUPABASE_DEMO_SERVICE_ROLE_KEY`. Nilai tidak direproduksi di sini.

## 2. Langkah Operator Wajib (belum dijalankan di sesi Gate 3E-B ini)

Gate 3E-B ini **hanya mengubah kode & menulis migration/script** — tidak
menyentuh Supabase demo hosted maupun webhook Telegram (lihat batasan gate).
Sebelum Gate 3E-C (supervised live test), operator wajib menjalankan:

1. **Terapkan migration** `supabase/migrations/20260908000001_gate_3e_b_order_intake_validation.sql`
   ke project Supabase AODP-Waluyo-Demo (`supabase db push` atau lewat SQL
   editor dashboard). Additive — `CREATE OR REPLACE` pada 2 fungsi yang sudah
   ada, tidak ada perubahan tabel.
2. **Jalankan seed alias Knowledge Pack**:
   ```bash
   pnpm tsx scripts/seed-gate-3e-b-knowledge-aliases.ts
   ```
   Idempotent — aman dijalankan ulang. Tanpa langkah ini, toko/produk yang
   diketik sales di Telegram **tidak akan** ter-tautkan ke `customers`/
   `products` asli (selalu fallback teks bebas) — demo tidak akan
   menunjukkan "toko/produk tervalidasi" sesuai tujuan gate.
3. **Deploy** kode branch ini ke environment demo (di luar scope sesi ini —
   ikuti prosedur deploy AODP yang berlaku).
4. **Daftarkan webhook** (`setWebhook`, lihat
   [TELEGRAM_SALES_ORDER_ENTRY.md § Setup Bot Telegram](../../architecture/TELEGRAM_SALES_ORDER_ENTRY.md#setup-bot-telegram-satu-kali)) —
   **tidak dilakukan di Gate 3E-B ini** (BATASAN gate: jangan mengaktifkan
   webhook nyata).

## 3. Format Pesan Telegram Demo yang Pasti

Setelah alias di langkah 2 tersedia, dua contoh order yang **pasti**
ter-match ke toko/produk asli (bukan fallback teks bebas):

**Sales 1** (toko miliknya: Toko Bangunan Berkah Jaya, Toko Sumber Makmur,
Warung Material Mitra Sejahtera):
```
Order Toko Berkah Jaya:
Cat Tembok 5kg 5 pail harga 185 ribu
Kirim besok pagi.
```

**Sales 2** (toko miliknya: Toko Cahaya Abadi Bangunan, Toko Anugerah Baru):
```
Order Toko Cahaya Abadi:
Thinner 3 botol harga 32 ribu
Kirim Senin siang.
```

Format bebas mengikuti pola `<nama produk> <qty> <satuan> harga <harga>`
(boleh tambah `diskon <n>%` / `potongan <nominal>` per baris item, dan baris
`kirim ...` untuk catatan pengiriman) — lihat grammar lengkap di
`apps/web/src/lib/sales-orders/extraction.ts`.

## 4. Langkah Pairing — Sales 1 & Sales 2

Pairing **owner-only**, satu Telegram chat = satu sales, tidak bisa saling
menyamar (ditegakkan di level database — `chat_in_use` / `user_already_linked`).

1. Login dashboard sebagai **Owner** (`owner.demo@waluyo.aodp.test`).
2. Buka `/dashboard/users`, cari baris Sales 1 (`sales.demo@waluyo.aodp.test`).
3. Klik aksi "Hubungkan Telegram" → sistem menerbitkan command sekali-pakai
   (TTL terbatas, lihat `TELEGRAM_ENROLLMENT_TTL_MINUTES`).
4. Dari HP Sales 1, buka chat **privat** dengan bot, kirim command/deep link
   yang ditampilkan (format `/start enroll_<token>`).
5. Bot membalas "Telegram berhasil terhubung ke akun Salesman ...".
6. **Ulangi langkah 2–5 untuk Sales 2** (`sales2.demo@waluyo.aodp.test`),
   dari HP/akun Telegram yang **berbeda**. Mencoba memakai chat yang sama
   untuk kedua sales, atau memakai token Sales 1 dari akun Telegram Sales 2,
   akan ditolak (`chat_in_use`/`user_already_linked`) — ini perilaku benar,
   bukan bug.
7. Verifikasi di `/dashboard/users`: kedua sales menunjukkan status Telegram
   "Terhubung", masing-masing dengan `telegram_chat_id` berbeda.

Reset (jika perlu pairing ulang): aksi "Putuskan Telegram" pada baris sales
yang bersangkutan (owner-only), lalu ulangi langkah 3–5.

## 5. Langkah Verifikasi Order di AODP

1. Sales (yang sudah dipasangkan) mengirim pesan order dengan format §3 ke bot.
2. Catat balasan bot (lihat §6 — harus memuat nomor order).
3. Login dashboard sebagai Owner/Admin, buka `/dashboard/orders`.
4. Order baru harus muncul dengan status **draft**, nama toko sesuai yang
   dikirim, `customer` **ter-link** (bukan hanya teks bebas — klik detail
   order untuk konfirmasi ada `customer_id`, bukan hanya `customer_name_raw`).
5. Buka detail order (`/dashboard/orders/[id]`) — item, harga, total harus
   sesuai pesan yang dikirim.
6. (Opsional, demo lanjutan) Sales membalas **KONFIRMASI** → status order
   berubah ke `confirmed`, balasan bot menyebut nomor order + total.

## 6. Expected Response (Bot → Sales)

Balasan sukses (setelah order diterima & draft tersimpan):

```
Draft Order SO-XXXXXX-NNNN — Toko Berkah Jaya

1. Cat Tembok 5kg
   5 pail × Rp185.000
   Total: Rp925.000

Estimasi total: Rp925.000
Pengiriman: besok pagi.

Balas KONFIRMASI jika sudah benar atau UBAH untuk melakukan koreksi.
```

Selalu memuat: **nomor order**, **nama toko**, **ringkasan tiap item**,
**total**, dan baris peringatan review (`⚠️ Order ini butuh review diskon...`)
bila `requiresDiscountReview = true` (mis. ada diskon tanpa kebijakan yang
cocok).

Balasan gagal (order **tidak** tersimpan) — semua diawali frasa "Order tidak
disimpan":

| Situasi | Balasan singkat |
|---|---|
| Toko tidak aktif/bukan tenant ini | "Toko yang dikenali dari pesan ini tidak aktif atau bukan bagian dari tenant Anda..." |
| Produk tidak aktif/bukan tenant ini | "Salah satu produk pada pesan ini tidak aktif atau tidak terdaftar untuk tenant Anda..." |
| Quantity ≤ 0 | "Jumlah (quantity) pada salah satu item tidak valid — harus lebih dari 0..." |
| Chat belum dipasangkan | "Nomor Anda belum terdaftar untuk menggunakan layanan ini..." |
| Pesan tidak dikenali sebagai order | "Maaf, pesan ini belum bisa dikenali sebagai order..." |

## 7. Rollback / Cleanup

- **Order hasil rehearsal/demo yang tidak diinginkan**: order tetap berstatus
  `draft` (tidak pernah otomatis `confirmed`) — aman dibiarkan sebagai bagian
  dataset demo, atau hapus manual lewat SQL editor Supabase bila ingin bersih:
  ```sql
  delete from public.sales_order_items where order_id = '<order_id>';
  delete from public.sales_orders where id = '<order_id>' and company_id = '<company_id demo>';
  ```
  (Selalu sertakan `company_id` pada `WHERE` — jangan pernah delete lintas tenant.)
- **Pairing salah/perlu diulang**: gunakan "Putuskan Telegram" (§4 Reset) —
  aman, idempotent, tidak menghapus riwayat order yang sudah dibuat.
- **Alias Knowledge Pack salah/perlu diubah**: edit langsung baris
  `knowledge_product_aliases`/`knowledge_customer_aliases` terkait, atau
  jalankan ulang `scripts/seed-gate-3e-b-knowledge-aliases.ts` setelah
  mengubah daftar alias di script (idempotent, upsert per `alias_text`).
- **Migration**: `CREATE OR REPLACE` murni — tidak ada langkah rollback
  destruktif yang diperlukan; me-revert berarti menjalankan definisi fungsi
  versi sebelumnya dari `20260822000001_order_lifecycle_audit_atomic.sql`
  bila benar-benar diperlukan (tidak direkomendasikan — menghilangkan validasi
  yang baru ditambahkan).

## 8. Checklist Sebelum Gate 3E-C (Supervised Live Test)

- [ ] Migration `20260908000001_gate_3e_b_order_intake_validation.sql` diterapkan ke Supabase demo.
- [ ] `scripts/seed-gate-3e-b-knowledge-aliases.ts` sudah dijalankan sukses (lihat log alias).
- [ ] Kode branch Gate 3E-B sudah dideploy ke environment demo.
- [ ] `TELEGRAM_BOT_TOKEN` & `TELEGRAM_WEBHOOK_SECRET` production/demo terisi di Vercel (bukan nilai dev).
- [ ] Webhook Telegram sudah didaftarkan (`setWebhook`) ke domain demo yang sudah live.
- [ ] Sales 1 **dan** Sales 2 sudah dipasangkan terpisah, terverifikasi di `/dashboard/users`.
- [ ] Rehearsal 1 order per sales sudah dicoba (dry run operator, sebelum sesi bersama Founder/Pak Waluyo) dan hasilnya sesuai §5–§6.
- [ ] Order hasil rehearsal sudah dibersihkan atau disepakati untuk dibiarkan (§7).
