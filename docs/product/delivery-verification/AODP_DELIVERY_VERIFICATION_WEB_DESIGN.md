# Rancangan — Verifikasi Pengiriman Versi Web (tanpa Telegram)

Status: **USULAN, menunggu persetujuan Founder** (2026-10-30). Belum ada kode.
Rujukan aturan bisnis & DoD yang sudah ada (jangan disalin ulang):
`AODP_DELIVERY_VERIFICATION_IMPLEMENTATION_GATE.md`.

## Masalah

Keputusan Founder 2026-10-30: sistem memakai **web + WhatsApp, tanpa Telegram**.
Padahal saat ini verifikasi pengiriman (diterima/ditolak + bukti) dan syarat
penugasan pengantar (`telegram_identities`) hanya ada lewat Telegram. Tanpa
jalur lain, order tidak pernah berstatus Terkirim dan invoice tidak bisa
terbit. Ini inti kasus kerugian Rp550 juta (PO ≠ pengiriman ≠ penerimaan).

## Prinsip: pakai ulang, jangan bangun ulang

Yang SUDAH ada dan teruji (tidak diubah):
- Primitif `SupabaseDeliveryRepository`: `createDelivery`, `dispatchDeliveryAtomic`,
  `recordArrival`, `insertEvidence`, `insertRecipient`, `confirmDeliveryReceiptAtomic`
  (RPC `finalize_delivery_atomic`).
- Aturan bukti per hasil di `lib/delivery/service.ts` (diterima penuh = foto +
  tanda tangan + nama penerima; sebagian = + alasan; ditolak = foto + alasan;
  toko tutup = foto + lokasi; gagal = alasan).
- Panel hasil di detail order, sinkron status order, eligibility invoice, alert Owner.

Yang BARU hanya lapisan web di atasnya: server action + halaman HP + penyimpanan file bukti.

## Alur pengguna

1. **Admin/Owner** buka detail order `Dikonfirmasi` → "Assign pengantar" (pilih sales
   atau driver). Syarat Telegram DIHAPUS. Delivery terbentuk, status `planned`.
2. **Pengantar** buka menu baru **Pengiriman** (HP) → daftar "Tugas Saya".
3. Buka satu tugas → **Mulai Antar** (`dispatched`) → **Sudah Tiba** (`arrived`, lokasi
   dicatat otomatis).
4. Pilih hasil: **Diterima penuh / Diterima sebagian / Ditolak / Toko tutup / Gagal**.
5. Untuk sebagian: isi jumlah diterima/ditolak per barang + alasan. Selalu: foto
   (kamera HP), nama penerima, tanda tangan toko (kanvas sentuh) sesuai aturan service.
6. **Selesai** → `finalize_delivery_atomic`; order jadi **Terkirim** bila semua barang
   diterima (aturan agregat yang ada). Owner mendapat alert untuk selisih (mekanisme ada).
7. Admin/Owner lanjut **Terbitkan Invoice** (tombol yang sudah live).

## Komponen baru

| Bagian | Isi |
|---|---|
| Halaman | `/dashboard/deliveries` (daftar tugas saya), `/dashboard/deliveries/[id]` (wizard mobile-first) |
| Server action | `lib/delivery/web-actions.ts`: mulai, tiba, unggah bukti, selesai. Tenant & aktor dari sesi; hanya pengantar yang ditugaskan (atau admin/owner) yang boleh; idempotency key per langkah |
| Penyimpanan | bucket `delivery-evidence` (migration baru, pola sama `payment-proofs`/`store-photos`: RLS per company, signed URL), batas ukuran/tipe file |
| Menu | "Pengiriman" di sidebar untuk sales & driver; admin/owner tetap lewat detail order |
| Assign | `createDeliveryAction` tanpa cek Telegram; kirim notifikasi WhatsApp menyusul saat WA aktif (di luar cakupan awal) |
| Tampilan Owner | bukti foto/tanda tangan/lokasi tampil di panel pengiriman detail order (viewer signed URL) |

Tidak berubah: skema inti delivery, RPC finalisasi, aturan eligibility, template invoice.

## Keamanan & anti-fraud

- Lokasi & waktu dicatat **di server** (waktu) dan dari browser (koordinat); file bukti
  tidak bisa ditimpa (append-only, `delivery_evidence` immutable).
- Pengantar hanya melihat tugas miliknya; lintas-tenant ditolak oleh RLS + cek sesi.
- Pengiriman tanpa lokasi (izin GPS ditolak) tidak diblokir tetapi **ditandai** dan
  dimasukkan ke daftar audit acak Owner (prioritas #5).
- Ini TIDAK menyelesaikan celah "sales merangkap pengantar memegang semua bukti"
  (prioritas #6/#5); hanya membuat buktinya ada, lengkap, dan bisa diperiksa Owner.

## Keputusan yang dibutuhkan dari Founder

1. **Lokasi GPS wajib?** Saran: selalu dicatat; bila ditolak browser boleh lanjut tapi
   ditandai "tanpa lokasi". (Aturan lama hanya mewajibkan untuk toko tutup.)
2. **Siapa boleh mengerjakan?** Saran: hanya pengantar yang ditugaskan. Admin/Owner
   input atas nama pengantar ditunda (bisa menjadi jalur curang).
3. **Pengiriman sebagian** tetap menghasilkan order yang tidak bisa ditagih sampai
   rancangan invoice parsial disetujui (menunggu pertanyaan Pak Waluyo no. 2).

## Pemecahan pekerjaan (3 irisan, masing-masing bisa diuji sendiri)

1. **S1** — assign tanpa Telegram + daftar tugas + Mulai Antar/Sudah Tiba.
2. **S2** — wizard hasil + bukti (foto, tanda tangan, GPS) + finalisasi + bucket storage.
3. **S3** — menu sidebar, tampilan bukti untuk Owner, uji end-to-end di HP (viewport mobile).

Pengujian: unit untuk validasi bukti (sudah ada, dipakai ulang), integration terhadap
Postgres lokal, verifikasi browser viewport mobile. Deploy: migration `db push` dulu,
lalu `git push`.
