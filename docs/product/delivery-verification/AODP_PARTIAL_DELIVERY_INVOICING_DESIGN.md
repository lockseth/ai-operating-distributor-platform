# Rancangan — Pengiriman Sebagian, Kirim Ulang, dan Retur

Status: **DISETUJUI Founder 2026-10-30** (3 keputusan di bawah menjadi final: admin/owner saja yang boleh menutup; KPI Revenue dikurangi nilai yang tidak ditagih; irisan 1 = K2+K4, irisan 2 = K3). Belum ada kode.
Menutup temuan UAT #7 (TRACKER): pengiriman sebagian tidak bisa ditagih.
Rujukan: `AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md`, `AODP_ORDER_TO_CASH_WORKFLOW.md`.

## Fakta kode saat ini (terverifikasi 2026-10-30)

1. `sync_sales_order_delivery_status`: order jadi `delivered` HANYA bila total diterima
   (lintas semua percobaan kirim) ≥ dipesan untuk SETIAP barang. Selain itu tetap `delivering`.
2. `issue_invoice_atomic` menolak bila: order bukan `delivered`; ada barang yang
   `received ≠ quantity`; lebih dari satu delivery yang berkontribusi; ada barang dengan
   received = 0 (`INCOMPLETE_ORDER_LINE_COVERAGE`).
3. Diskon barang di invoice = diskon penuh barang, TIDAK dihitung proporsional bila
   jumlah diterima sebagian.
4. `createDeliveryAction` memakai idempotency `order:<id>` → hanya SATU delivery per order
   dari web; belum ada jalur "kirim ulang sisa" (percobaan #2).
5. Retur SETELAH invoice sudah ada dan teruji (Ajukan Retur → verifikasi Owner → credit note).

Akibat: toko menolak 4 dari 10 dus → 6 dus tidak bisa ditagih, dan kirim ulang tidak bisa dibuat.

## Daftar kasus yang harus tertangani

| # | Kasus | Hasil yang benar |
|---|---|---|
| K1 | Diterima penuh | Order Terkirim → invoice penuh *(sudah jalan)* |
| K2 | Diterima sebagian, **sisa tidak jadi dikirim** (dibawa pulang) | Admin/Owner **Tutup Pengiriman Sebagian** → order Terkirim → invoice hanya barang diterima, diskon proporsional |
| K3 | Diterima sebagian, **sisa dikirim ulang** | Admin/Owner **Kirim Ulang Sisa** (percobaan #2) → bila lengkap order Terkirim otomatis → **satu invoice** gabungan semua percobaan |
| K4 | Satu barang diterima 0, barang lain diterima | Sama K2; barang 0 tidak masuk invoice |
| K5 | Semua ditolak / toko tutup / gagal | Tidak ada tagihan; Owner pilih **Kirim Ulang** atau **Batalkan order** (alur batal yang ada) |
| K6 | Barang sudah diterima + invoice terbit, lalu **dikembalikan** | Alur Retur → credit note yang ada *(sudah jalan)* |
| K7 | Barang diterima, dikembalikan **sebelum invoice** | Dicatat sebagai bukan-diterima di hasil pengiriman; masuk K2/K3 |

## Perubahan yang diusulkan

1. **Tutup Pengiriman Sebagian** — RPC baru `short_close_order_atomic` (aktor admin/owner, `delivery.manage`;
   alasan wajib): hanya bila order `delivering`, semua percobaan sudah selesai (tidak ada yang berjalan),
   dan ada barang diterima > 0. Mengubah status → `delivered`, mencatat penutup, waktu, alasan
   (kolom di `sales_orders` + `audit_logs`). Tidak mengubah jumlah pesanan asli.
2. **`issue_invoice_atomic` (migration baru, fungsi terkunci diubah hati-hati)**:
   - jumlah per barang = **SUM diterima lintas semua percobaan**, bukan satu delivery;
   - boleh `received < quantity` hanya bila order ditutup-sebagian ATAU seluruh percobaan lengkap;
   - barang received = 0 tidak jadi baris invoice;
   - diskon barang **proporsional** (`discount × received / quantity`);
   - `delivery_id` invoice = percobaan terakhir yang berkontribusi; semua tes invoice lama tetap lulus.
3. **Kirim Ulang Sisa** — aksi admin/owner membuat percobaan ke-N untuk barang yang masih outstanding
   (jumlah = sisa yang belum diterima). Idempotency per percobaan.
4. **UI detail order** — panel pengiriman menampilkan "Diterima 6 dari 10 • Rp204.000 dari Rp340.000"
   dan dua tombol untuk admin/owner: *Tutup & Tagih yang Diterima* / *Kirim Ulang Sisa* (+ dialog alasan).
5. **KPI Revenue** — lihat keputusan #2 di bawah.

## Keputusan Founder yang dibutuhkan

1. **Siapa boleh menutup pengiriman sebagian?** Saran: admin dan owner saja (bukan sales — sales
   yang mengantar bisa menutup untuk menutupi selisih). Menunggu juga jawaban Pak Waluyo no. 2.
2. **KPI Revenue sales.** Omzet dikreditkan saat konfirmasi dengan nilai PENUH. Pengiriman sebagian
   membuat sales tetap dikredit untuk barang yang ditolak toko. Saran: kurangi omzet sebesar nilai
   yang tidak ditagih saat penutupan (event penyesuaian; perlu perubahan kecil pada skema KPI
   governed yang terkunci). Alternatif: terima batasan ini dulu (sama dengan batasan retur/credit
   note yang sudah dicatat), diperbaiki di gate terpisah.
3. **Cakupan sekarang:** K2+K4 dulu (tutup & tagih sebagian), lalu K3 (kirim ulang + invoice gabungan)?
   Saran: ya, dua irisan berurutan.

## Pengujian

- Unit: perhitungan diskon proporsional, penggabungan per barang, aturan boleh/tidak menutup.
- Integration terhadap Postgres lokal: K1–K7 satu per satu (termasuk tolak: sales menutup, tutup saat
  masih ada pengiriman berjalan, invoice dua kali, lintas tenant).
- Verifikasi browser: detail order admin → tutup → invoice tercetak dengan jumlah & total benar.
- Deploy: migration `db push` dulu, lalu `git push`; seluruh suite invoice/finance lama wajib hijau.
