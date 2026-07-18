# Order Cancellation & Dispute

> Channel input tetap Telegram — dokumentasi channel lengkap ada di
> [TELEGRAM_SALES_ORDER_ENTRY.md](TELEGRAM_SALES_ORDER_ENTRY.md). Dokumen ini
> khusus membahas alur pembatalan/sengketa order, bukan channel order itu
> sendiri.

## Dua Kejadian Bisnis (Tidak Pernah Menghapus Order)

1. **CUSTOMER_CANCELLED** — PIC mengakui pernah memesan, lalu membatalkan.
2. **CUSTOMER_DENIES_ORDER** — PIC menyatakan tidak pernah memesan.

Order **tidak pernah** dihapus (hard delete) pada kedua kejadian ini. Setiap
perubahan wajib memiliki `status`, `reason`, `actor`, `timestamp`, dan audit
trail — tersimpan di `order_cancellation_disputes`
(migration `20260725000001_order_cancellation_dispute.sql`).

## AUTO_CANCEL_SAFE Policy

`CUSTOMER_CANCELLED` pada order yang **belum masuk dispatch plan**
(`order_stage_at_request = NOT_DISPATCHED`) diklasifikasikan
`AUTO_CANCEL_SAFE` oleh rule engine (`classifyRequest()`,
`apps/web/src/lib/order-disputes/service.ts` — dicerminkan di
`create_order_cancellation_dispute()`) dan **auto-cancel** tanpa menunggu
Human Review. Ini adalah satu-satunya jalur auto-resolve di seluruh modul.

Auto-cancel **tetap**:

- **Menghasilkan audit** — baris `audit_logs`
  (`action = 'order.cancellation_dispute_requested'`, `new_data` memuat
  `auto_cancelled: true`) selalu dibuat, sama seperti jalur yang butuh
  review manual. Tidak ada shortcut yang melewati audit trail.
- **Masuk cancellation history** — baris `order_cancellation_disputes`
  (`status = APPROVED`, `resolution = CANCEL_APPROVED`) tetap tersimpan
  permanen dan dapat di-query per order/per customer/per Salesman, sama
  seperti request yang direview manusia.
- **Dapat dihitung untuk cancellation rate** — karena setiap auto-cancel
  meninggalkan baris permanen dengan `sales_order_id`, `requested_by`,
  `requested_at`, agregasi pola pembatalan (mis. "berapa persen order
  Salesman X dibatalkan sebelum dispatch bulan ini") dapat dihitung murni
  dari query terhadap tabel ini. **Tidak ada agregasi/skor semacam ini yang
  diimplementasikan pada gate manapun sejauh ini** — statement ini hanya
  menegaskan bahwa data mentahnya sudah tersedia dan konsisten, bukan bahwa
  fitur cancellation-rate sudah dibangun.

Auto-cancel **tidak pernah**:

- **Menghapus Gross PO** — `sales_orders` tetap ada (`status = 'cancelled'`),
  nilai order asli (`final_amount`, item, quantity) tetap utuh dan bisa
  ditelusuri. "Gross PO" (order yang pernah masuk, terlepas hasil akhirnya)
  tidak pernah berkurang oleh pembatalan.
- **Menghasilkan Net PO/omzet/achievement** — order yang berstatus
  `cancelled` tidak dihitung sebagai pencapaian penjualan yang valid pada
  modul manapun. Sistem ini **belum mengimplementasikan KPI Foundation sama
  sekali** (tidak ada modul skor/achievement Salesman di codebase) — batasan
  ini karena itu otomatis terpenuhi secara struktural, bukan hasil filter
  eksplisit yang perlu dijaga terpisah.

`CUSTOMER_DENIES_ORDER` **tidak pernah** auto-resolve, apa pun tahap
order-nya (lihat tabel klasifikasi di bawah) — selalu `HOLD_AND_ALERT`,
`status = ON_HOLD`, wajib Human Review oleh admin/owner/manager yang bukan
pelapor sendiri. Ini mencegah tuduhan "tidak pernah pesan" langsung
menjatuhkan konsekuensi apa pun ke order/Salesman tanpa verifikasi manusia.

## Tabel Klasifikasi (`classifyRequest`)

| `request_type` | `order_stage_at_request` | `ai_classification` | Auto-resolve? |
|---|---|---|---|
| CUSTOMER_CANCELLED | NOT_DISPATCHED | AUTO_CANCEL_SAFE | Ya — `APPROVED` |
| CUSTOMER_CANCELLED | IN_DISPATCH_PLAN_NOT_DEPARTED | NEEDS_REVIEW | Tidak — `REQUESTED` |
| CUSTOMER_CANCELLED | DEPARTED_IN_TRANSIT / RECEIVED_PARTIAL / RECEIVED_FULL / DEPARTED_TERMINAL_OTHER | HOLD_AND_ALERT | Tidak — `ON_HOLD` |
| CUSTOMER_DENIES_ORDER | *(stage apa pun)* | HOLD_AND_ALERT | **Tidak pernah** — `ON_HOLD` |

AI (rule engine deterministik, bukan LLM) hanya menentukan
`AUTO_CANCEL_SAFE` / `NEEDS_REVIEW` / `HOLD_AND_ALERT` — tidak pernah
menghukum atau menonaktifkan Salesman secara otomatis.

## Append-Only untuk Fakta Permintaan

Kolom fakta (`request_type`, `reason_code`, `notes`, `reported_pic_*`,
`contact_source`, `order_stage_at_request`, `requested_by`, `requested_at`,
`idempotency_key`, `created_at`) **tidak pernah berubah** setelah insert —
ditegakkan trigger `trg_ocd_append_only` (`BEFORE UPDATE`, menolak dengan
exception bila kolom tersebut coba diubah). Resolusi (`status`, `resolution`,
`resolution_notes`, `actual_pic_name_snapshot`, `reviewed_by`, `reviewed_at`)
tetap **boleh** di-`UPDATE` in-place — ini bukan pelanggaran append-only,
karena append-only di sini berlaku untuk *fakta permintaan* (apa yang
dilaporkan), bukan *hasil review* (keputusan yang menyusul kemudian).
Resolusi tidak pernah menyisipkan baris kedua; satu request = satu baris
sepanjang siklus hidupnya.

`resolve_order_cancellation_dispute()` mengubah `status` dari
`REQUESTED`/`ON_HOLD` menjadi `APPROVED`/`REJECTED`/`RESOLVED` (atau tetap
`ON_HOLD` untuk `KEPT_ON_HOLD`) lewat `UPDATE` yang **hanya** menyentuh
kolom hasil review — trigger memverifikasi ini di level DB pada setiap
`UPDATE`, independen dari layer aplikasi. Satu baris aktif per order
ditegakkan `UNIQUE INDEX uq_ocd_one_active_per_order ... WHERE status IN
('REQUESTED','ON_HOLD')` — dua dispute yang saling bertentangan untuk order
yang sama tidak dapat pernah coexist secara aktif, dibuktikan level DB
(bukan hanya app-level check) lewat live UAT.

**Bug ditemukan & diperbaiki (2026-07)**: `create_order_cancellation_dispute`
(branch `already_exists`) dan `resolve_order_cancellation_dispute` (branch
`already_resolved`) sempat mengembalikan kolom `VARCHAR` dari `%ROWTYPE`
tanpa cast eksplisit ke `TEXT`, menyebabkan Postgres error "structure of
query does not match function result type" — retry idempotent (baik retry
create dengan `idempotency_key` sama, maupun retry resolve pada request yang
sudah selesai) gagal alih-alih mengembalikan hasil idempotent. Diperbaiki di
`20260726000001_fix_order_dispute_return_type_cast.sql` (cast eksplisit
`::TEXT`, tanpa mengubah signature/kontrak fungsi). Dibuktikan live: retry
create → `already_exists` dengan `request_id` identik, retry resolve →
`already_resolved` dengan `currentStatus` yang benar, keduanya tanpa baris
atau audit log duplikat.

## Owner Alert

Dipicu (`requiresOwnerAlertForDispute()`) untuk: `CUSTOMER_DENIES_ORDER`;
pembatalan setelah dispatch (`order_stage_at_request ≠ NOT_DISPATCHED`);
order bernilai besar (`companies.settings.high_value_order_threshold`, tanpa
hardcode nominal); pola dispute berulang (≥2 dalam 30 hari untuk customer
yang sama); perubahan PIC bersamaan dispute. Memakai mekanisme
`owner_alerts` outbox existing (channel selalu `whatsapp`, `status: pending`
sampai provider nyata terpasang) — tidak ada provider WhatsApp baru dibangun.

## Integrasi Dispatch & Delivery (Mekanisme Existing, Bukan Baru)

- **Dispatch**: order pada tahap `IN_DISPATCH_PLAN_NOT_DEPARTED` yang
  dibatalkan/disengketakan otomatis di-*hold* lewat
  `overrideDispatchPlan(..., {action: "hold"})` — fungsi yang sudah ada dari
  gate AI Dispatch Planner, bukan mekanisme baru. Riwayat plan (
  `dispatch_plan_events`) tetap utuh.
- **Delivery**: order yang sudah berangkat/diterima sebagian/penuh mendapat
  `delivery_exceptions` (`insertException()`, mekanisme existing dari gate
  Delivery Verification) — **tidak pernah** mengubah `received_quantity`
  yang sudah terverifikasi. Invoice eligibility
  (`computeInvoiceEligibility()`) tetap dihitung murni dari
  `received_quantity`, tidak terpengaruh oleh status dispute/resolution.

## Human Review

Reviewer wajib role `owner`/`manager`/`admin`/`super_admin` aktif di tenant
yang sama, dan **tidak boleh** menjadi pelapor request itu sendiri — ditolak
dua lapis: `CHECK` constraint DB (`reviewed_by IS DISTINCT FROM
requested_by`) **dan** guard eksplisit di RPC
(`self_review_forbidden`, dicek sebelum status-check apa pun, sehingga
berlaku bahkan pada request yang statusnya sudah final).

UI: section "Pembatalan & Sengketa Order" pada halaman detail order
(`apps/web/src/app/(dashboard)/dashboard/orders/[id]/page.tsx`, purely
additive — tidak mengubah section order_source yang sudah ada), dengan lima
aksi: Approve cancellation, Reject cancellation, Confirm not ordered,
Confirm ordered by another PIC, Keep on hold
(`apps/web/src/components/order-disputes/dispute-review-panel.tsx`).

## Referensi Kode

- `supabase/migrations/20260725000001_order_cancellation_dispute.sql`,
  `20260725000002_order_dispute_conversation_state.sql`,
  `20260726000001_fix_order_dispute_return_type_cast.sql`
- `apps/web/src/lib/order-disputes/` (`types.ts`, `service.ts`,
  `repository.ts`, `conversation.ts`, `confirmation.ts`, `workflow.ts`,
  `actions.ts`)
- `apps/web/src/components/order-disputes/dispute-review-panel.tsx`
