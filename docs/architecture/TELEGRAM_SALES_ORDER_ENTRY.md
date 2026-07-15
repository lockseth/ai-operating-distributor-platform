# Telegram Sales Order Entry — MVP

Vertical slice: input order sales via Telegram, dari pesan masuk sampai draft
order tersimpan (belum: PO tercetak, delivery verification, invoice,
notifikasi WhatsApp owner, dashboard baru, warehouse deduction, pengiriman
barang — lihat scope di task asli).

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

## Mendaftarkan Sales (Telegram Identity Mapping)

Belum ada UI (di luar scope MVP ini). Daftarkan manual via SQL — **jangan
pernah** mempercayai `company_id`/`user_id` dari payload Telegram, hanya baris
di `telegram_identities` yang menjadi sumber kebenaran identitas:

```sql
insert into public.telegram_identities (company_id, user_id, telegram_chat_id, telegram_username)
values (
  '<company_id milik sales>',
  '<user_id sales, role harus sales/admin/owner/manager>',
  <chat_id numerik dari Telegram — dapatkan lewat @userinfobot>,
  'username_telegram_opsional'
);
```

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
