# Rancangan — Hasil Pengiriman Diinput Admin dari Faktur Bertanda Tangan

Status: **DISETUJUI Founder 2026-11-04** (jalur input admin + 3 lapis pagar anti-kolusi di bagian "Pagar tambahan").
Dasar: jawaban Pak Waluyo no. 1 (TRACKER, Pertanyaan untuk Pak Waluyo).
Rujukan, jangan disalin: `AODP_DELIVERY_VERIFICATION_WEB_DESIGN.md`, `AODP_PARTIAL_DELIVERY_INVOICING_DESIGN.md`.

## Alur nyata Waluyo

Delivery membawa nota + barang → toko menandatangani faktur → sore hari delivery
lapor ke Admin/Faktur berapa yang terkirim dan diterima → faktur asli bertanda
tangan dikembalikan ke faktur (toko tempo); toko tunai: copy faktur + bukti setor ke kasir.

Maka pelapor utama = **admin faktur di kantor**, bukti utama = **foto faktur bertanda tangan**.
Jalur HP pengantar (S1–S3) tetap ada sebagai pilihan, tidak diubah.

## Fakta kode (terverifikasi 2026-11-04)

- RPC `finalize_delivery_atomic` menerima delivery berstatus `planned`/`dispatched`/`arrived`
  dan butuh izin `delivery.manage` (admin/owner punya) → admin bisa finalisasi tanpa Mulai/Tiba.
- `submitDeliveryResultAction` (`lib/delivery/web-actions.ts`) hanya untuk pengantar yang ditugaskan
  (`canOperateDelivery`) dan mewajibkan status `arrived`. Itu yang tidak cocok untuk Waluyo.
- Aturan bukti per hasil (`lib/delivery/service.ts`) tetap dipakai ulang.

## Perubahan

1. **Aksi baru** `submitDeliveryResultByAdminAction` (`web-actions.ts`): izin `delivery.manage`,
   status delivery boleh `planned`/`dispatched`/`arrived`, memakai ulang seluruh logika hasil
   (validasi bukti, severity, DV-05, finalisasi atomik, sinkron status order, alert Owner).
   Logika bersama diekstrak jadi satu fungsi internal agar dua jalur tidak menyimpang.
2. **Syarat 1 — foto faktur wajib**: bukti bertipe foto (faktur bertanda tangan) wajib untuk semua
   hasil yang menagih (diterima penuh/sebagian). Tanda tangan di layar TIDAK diwajibkan pada jalur
   admin (tanda tangan ada di kertas). Nama penerima tetap wajib. Foto diunggah ke bucket
   `delivery-evidence` yang sama.
3. **Syarat 2 — jejak admin**: event `finalized` dan bukti diberi `source: "admin_input"` + id admin
   (`actor_id` sudah tercatat). Panel pengiriman menampilkan lencana **"Diinput admin"**.
   Pengiriman yang diinput admin masuk kandidat audit acak Owner (prioritas #5).
4. **Syarat 3 — tunai**: bila toko bayar tunai, panel menampilkan tautan ke alur **Klaim Pembayaran**
   yang ada (tidak membuat alur baru). Uang tunai tetap hanya sah lewat verifikasi Owner.
5. **UI**: pada panel pengiriman detail order, tombol **"Input Hasil dari Faktur"** untuk admin/owner,
   membuka formulir (hasil, jumlah per barang, penerima, alasan, unggah foto faktur).
   Pengantar yang ditugaskan tetap bisa memakai jalur HP sendiri.

## Pagar tambahan anti-kolusi admin–sales (disetujui Founder 2026-11-04)

Risiko sisa: admin dan sales memegang semua saksi (kertas). Perlu saksi dari luar lingkaran mereka.
Urutan kerja (3 → 2 → 1):

3. **Audit acak mingguan Owner** (prioritas fraud #5): sistem memilih sampel acak pengiriman
   (prioritas: diinput admin, tanpa lokasi, selisih) → Owner telepon toko → hasil dicatat.
2. **Dua mata nilai besar**: pengiriman bernilai di atas ambang yang ditetapkan Owner tidak bisa
   ditagih sebelum Owner menyetujui. Ambang dikonfigurasi Owner (nilai awal diusulkan Rp5 juta, perlu konfirmasi).
1. **Konfirmasi toko via WhatsApp** (saksi independen): setelah input, toko menerima ringkasan
   barang + nilai dan membalas YA; yang belum terkonfirmasi ditandai di dashboard Owner.
   Menunggu WhatsApp Pak Waluyo aktif + nomor toko tercatat.

## Risiko & pagar

- Admin memegang input + faktur → celah kolusi admin–sales. Pagar: foto faktur wajib & tidak bisa
  ditimpa (append-only), lencana "Diinput admin", audit acak Owner, selisih tetap memicu alert Owner.
- Tidak ada perubahan skema inti delivery; migration tidak diperlukan (kolom `metadata` bukti dan
  `payload` event sudah JSON).

## Pengujian

- Unit: aturan bukti jalur admin (foto faktur wajib, tanda tangan layar tidak wajib).
- Integration Postgres lokal: admin finalisasi dari `planned`; sales ditolak; lintas tenant ditolak;
  hasil sebagian tetap menghasilkan order `delivering` (sama temuan #7).
- Browser: detail order → Input Hasil dari Faktur → order Terkirim → Terbitkan Invoice.
- Deploy: tanpa migration, cukup `git push`.
