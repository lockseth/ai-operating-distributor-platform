# AODP Delivery Verification — Implementation Gate

## 1. Decision

Delivery Verification adalah langkah berikutnya dari vertical slice AODP setelah Telegram Sales Order Entry.

Urutan yang tidak boleh dipecah:

`Sales Order → Delivery Verification → Invoice → Collection → Owner Alert`

## 2. Outcome

Owner dapat mengetahui untuk setiap order:

- apa yang dipesan;
- apa yang dibawa/dikirim;
- apa yang benar-benar diterima;
- apa yang ditolak atau dibawa kembali;
- apa yang sah untuk ditagihkan;
- siapa yang melakukan dan menerima;
- bukti apa yang tersedia;
- apakah terdapat penyimpangan yang memerlukan tindakan.

## 3. MVP scope

### Included

- Membentuk delivery dari confirmed sales order.
- Assignment driver/delivery person.
- Recording dispatched quantity.
- Arrival and recipient verification.
- Full, partial, rejected, store-closed, and failed outcomes.
- Evidence: photo, time, GPS/location, recipient, signature, optional voice note.
- Per-item reconciliation.
- Immutable exception/audit trail.
- Invoice eligibility based on verified received quantity.
- Telegram operational messages.
- WhatsApp owner alert untuk material variance.

### Excluded from this workflow

- Full warehouse/WMS optimization.
- Machine-learning fraud verdict.
- Universal GPS tracking provider integration.
- Route optimization engine.
- Collection dashboard yang berdiri sendiri.
- Autonomous punishment/blocking of sales or driver.

## 4. Required domain records

Nama tabel final mengikuti convention repo, tetapi domain minimum harus mencakup:

| Record | Purpose |
|---|---|
| Delivery | Header, sales order reference, assignee, status, timestamps |
| Delivery item | Ordered, dispatched, received, rejected, returned quantities |
| Delivery exception | Reason code, severity, resolution state |
| Delivery evidence | Type, storage reference, captured time/location, actor |
| Recipient verification | Name/PIC, contact/identity note, signature |
| Delivery event/audit | Append-only state transitions |
| Invoice eligibility | Verified quantities/value available to invoicing |

Constraints:

- semua record tenant-scoped;
- idempotency untuk submission Telegram/API;
- actor dan timestamp wajib;
- evidence tidak dapat dihapus oleh sales;
- quantity tidak boleh negatif;
- `received + rejected/returned/unresolved` harus dapat direkonsiliasi terhadap dispatched quantity;
- invoice eligible quantity tidak boleh melebihi verified received quantity.

## 5. Reason codes v1

- `STORE_CLOSED`
- `CUSTOMER_PARTIAL_ACCEPTANCE`
- `CUSTOMER_REJECTED`
- `ITEM_DAMAGED`
- `ITEM_MISMATCH`
- `QUANTITY_MISMATCH`
- `PRICE_OR_DISCOUNT_DISPUTE`
- `RECIPIENT_NOT_AUTHORIZED`
- `ADDRESS_NOT_FOUND`
- `VEHICLE_OR_DRIVER_ISSUE`
- `OTHER_REQUIRES_NOTE`

Reason `OTHER_REQUIRES_NOTE` wajib memiliki catatan.

## 6. Telegram operational flow

1. Sistem mengirim tugas delivery berisi toko, alamat, item, jumlah, dan referensi order.
2. Driver memilih `MULAI KIRIM`.
3. Saat tiba, driver memilih hasil: `DITERIMA PENUH`, `DITERIMA SEBAGIAN`, `DITOLAK`, atau `TOKO TUTUP`.
4. Bot meminta jumlah per item bila tidak diterima penuh.
5. Bot meminta reason dan evidence sesuai outcome.
6. Bot menampilkan ringkasan rekonsiliasi.
7. Driver mengonfirmasi.
8. Sistem menyimpan event idempotent dan menghitung invoice eligibility.
9. Variance material menghasilkan alert sesuai policy.

## 7. Owner alert contract

WhatsApp owner alert minimum:

```text
⚠️ DELIVERY EXCEPTION
Toko: {customer_name}
Order: {order_reference}
Status: {partial/rejected/store_closed}
Nilai order: {ordered_value}
Nilai diterima: {accepted_value}
Selisih: {variance_value}
Alasan: {reason}
Bukti: {evidence_summary}
Petugas: {actor}
Rekomendasi: {next_action}
```

Nilai materiality/threshold adalah tenant knowledge configuration. Sebelum threshold dikalibrasi, exception tetap tampil di dashboard/audit; alert langsung dapat dibatasi pada variance apa pun yang mengubah invoice atau memerlukan keputusan owner.

## 8. Acceptance scenarios

### Scenario A — Full delivery

- Semua item diterima.
- Recipient dan evidence lengkap.
- Delivery menjadi `verified`.
- Seluruh verified received quantity eligible untuk invoice.

### Scenario B — Partial delivery

- Sebagian barang diterima.
- Reason, quantity per item, recipient, dan evidence tersimpan.
- Sisa barang memiliki disposition.
- Invoice hanya memakai barang diterima.
- Exception tercatat dan owner alert mengikuti policy.

### Scenario C — Store closed

- Foto, waktu, dan lokasi tersimpan.
- Tidak ada invoice baru.
- Reschedule task dibuat.
- Outcome tidak dapat diubah tanpa audit event.

### Scenario D — Rejected delivery

- Alasan dan evidence wajib.
- Barang ditolak tidak invoice-eligible.
- Penolakan berulang dapat dikonsumsi Customer Health.

### Scenario E — Recipient/PIC changed

- Identitas/keterangan penerima baru direkam.
- Relationship event dibuat.
- Sistem meminta verifikasi tambahan tanpa otomatis menuduh fraud.

### Scenario F — Duplicate submission

- Retry webhook/callback dengan idempotency key yang sama tidak membuat delivery event atau invoice eligibility ganda.

### Scenario G — Unauthorized manipulation

- Sales/driver tidak dapat menghapus evidence, exception, atau audit event.
- Akses lintas tenant ditolak.

## 9. Definition of Done

Workflow dinyatakan selesai hanya bila:

- migration dan RLS tersedia;
- service/domain logic terpisah dari Telegram transport;
- full/partial/rejected/store-closed scenarios lulus test;
- idempotency dan cross-tenant isolation lulus test;
- evidence authorization lulus test;
- invoice eligibility selalu berasal dari verified received quantity;
- Telegram happy path dan exception path dapat didemokan;
- owner alert payload dapat dibentuk tanpa membocorkan data tenant lain;
- documentation, onboarding requirement, and demo script diperbarui;
- tidak ada placeholder yang diklaim sebagai live feature.

## 10. Stop conditions

Implementation harus dihentikan dan diperbaiki bila:

- invoice dibuat dari ordered/dispatched quantity tanpa verified receipt;
- exception dapat ditutup tanpa reason/evidence yang diwajibkan;
- sales/driver dapat menghapus alert atau audit history;
- tenant identity dipercaya dari request body tanpa server-side resolution;
- workflow membutuhkan threshold yang belum diketahui lalu developer mengarang angka tetap;
- sistem menyebut seseorang fraud hanya berdasarkan satu anomaly.

