# UAT Role-Play — Pilot Waluyo (Sales, Admin, Owner)

Skrip uji manual "pura-pura jadi user" untuk memastikan alur bisnis Waluyo
berjalan dari awal sampai uang masuk, dan tidak ada proses yang terlewat.
Beda dari test otomatis: ini menguji **alur nyata di layar**, dipegang
Founder/tim, bukan kode.

Rujukan peta alur & status gate: `docs/product/AODP_ORDER_TO_CASH_WORKFLOW.md`.
Hasil temuan dicatat ke `TRACKER.md` (Sedang Dikerjakan) sebelum diperbaiki.

## Persiapan

- Lingkungan: **lokal** (`pnpm seed:dev`, `supabase start`, `pnpm dev`) atau
  hosted. Jangan uji pembayaran/WA nyata di hosted tanpa izin Founder.
- Akun seed (password `Aodp2026!`): sales `waluyo@aodp.test`, admin
  `admin@aodp.test`, owner `owner@aodp.test`.
- Pakai 2 jendela browser berbeda (satu biasa, satu incognito) supaya bisa
  ganti peran tanpa logout terus.
- Model Waluyo: **sales merangkap pengantar** (tidak ada role driver).
  Role `driver` hanya untuk klien lain (SURABRADJA) — jangan diuji di sini.
- **Prasyarat bulanan Owner**: periode KPI berstatus ACTIVE yang mencakup
  hari uji **dan** target per salesman. Tanpa periode aktif, kunjungan
  tidak dikreditkan sebagai Call (tampil "CALL 0" tanpa peringatan).
- **Profil perusahaan** (alamat, email, telepon, prefix) harus lengkap,
  kalau tidak Terbit Invoice ditolak. Di lokal: `pnpm seed:dev`.
- Sales/pengantar harus sudah **terdaftar Telegram** sebelum bisa di-assign.
- Catat hasil tiap langkah: **OK / GAGAL / ANEH** + catatan singkat.

## Siapa boleh apa (harus cocok dengan kenyataan)

| Kemampuan | Sales | Admin | Owner |
|---|---|---|---|
| Buat/ubah order | ya | ya | ya |
| Putuskan harga khusus | tidak | tidak | **ya** |
| Assign pengantar | tidak | ya | ya |
| Terbitkan invoice | tidak | ya | ya |
| Lapor "toko sudah bayar" (klaim) | **ya** | tidak | tidak |
| Catat/verifikasi pembayaran | tidak | tidak | **ya** |
| Catat hasil kunjungan penagihan | ya (non-bayar) | ya | ya |
| Setujui batal order / retur / refund | tidak | ajukan | **setujui** |
| Lihat KPI, Risk Alert, Tanya AODP | KPI sendiri | tidak | **ya** |

Kalau ada yang tidak sesuai tabel ini saat dites → itu temuan.

## Skenario A — Jalan lurus (happy path)

| # | Peran | Aksi | Hasil yang diharapkan |
|---|---|---|---|
| A1 | Sales | Menu **Kunjungan Sales**: mulai kunjungan ke toko, ambil foto + GPS | Kunjungan tercatat (Call). |
| A2 | Sales | **Sales Order → Buat Order**: pilih toko, 2–3 produk, harga normal, termin bayar | Order tersimpan status Draft, nomor order terbentuk. |
| A3 | Sales | Konfirmasi order | Status Dikonfirmasi. Sales tidak bisa ubah harga setelahnya. |
| A4 | Sales | Selesaikan Kunjungan (hasil: ada order) | Kunjungan jadi Effective Call, terkait order. |
| A5 | Admin | Buka detail order → **Assign pengantar** (pilih sales) | Muncul panel Delivery Verification; tugas terkirim. |
| A6 | Sales (pengantar) | Terima tugas lewat Telegram, kirim barang, catat diterima penuh + bukti (foto/tanda tangan/GPS) | Status delivery terverifikasi; status order jadi **Terkirim**. |
| A7 | Admin | Detail order → panel **Invoice → Terbitkan Invoice** | Pindah ke halaman invoice, nomor invoice terbentuk, nilai = barang yang diterima. |
| A8 | Admin | **Lihat/Cetak Invoice** → Cetak | Header perusahaan benar, tabel rapi, total + terbilang benar. Cetak ke printer **dot matrix 3 ply** (cek hitam-putih, tembus 3 lembar, tidak terpotong). |
| A9 | Sales | Toko bayar: **Klaim Pembayaran** → lapor sudah diterima + upload bukti | Klaim berstatus menunggu review. |
| A10 | Owner | **Klaim Pembayaran** → setujui; lalu Finance → Pembayaran/Rekonsiliasi | Outstanding invoice turun; bila lunas status Lunas. |
| A11 | Owner | Dashboard, **KPI Salesman**, **Laporan Sales** | Call, Effective Call, Order, Revenue sales tadi ikut terhitung. |

## Skenario B — Harga khusus

| # | Peran | Aksi | Diharapkan |
|---|---|---|---|
| B1 | Sales | Buat order dengan harga di bawah kebijakan → **Ajukan Harga Khusus** | Status menunggu persetujuan Owner. |
| B2 | Sales | Coba konfirmasi order itu | **Ditolak** (harus tunggu Owner). |
| B3 | Owner | **Persetujuan Harga Khusus** → setujui | Order bisa dikonfirmasi dengan harga yang disetujui persis. |
| B4 | Owner | Ulangi dengan penolakan | Order kembali Draft. |

## Skenario C — Penyimpangan di lapangan

| # | Peran | Aksi | Diharapkan |
|---|---|---|---|
| C1 | Sales | Kirim sebagian: barang diterima kurang dari pesanan | Invoice hanya menagih yang diterima; selisih tampil di panel delivery. |
| C2 | Sales | Toko tutup / menolak barang | Status delivery sesuai; Owner dapat notifikasi; order **tidak** bisa ditagih penuh. |
| C3 | Admin | Coba terbitkan invoice sebelum order Terkirim | Tombol tidak muncul / ditolak dengan pesan jelas. |
| C4 | Admin | Terbitkan invoice dua kali untuk order yang sama | Kedua kalinya ditolak ("sudah memiliki invoice"). |
| C5 | Admin | Ajukan **batal order** (setelah invoice terbit) → Owner setujui | Invoice di-void, tidak masih tertagih. |
| C6 | Admin | Ajukan **retur** → Owner verifikasi | Piutang berkurang sesuai credit note. |

## Skenario D — Penagihan & uang

| # | Peran | Aksi | Diharapkan |
|---|---|---|---|
| D1 | Sales | Kunjungan tipe Penagihan, toko **belum bayar** → catat hasil | Tercatat di riwayat collection invoice. |
| D2 | Sales | Toko bayar **cicil** → Lapor Pembayaran Diterima | Klaim sebagian; Owner setujui → status Sebagian Dibayar. |
| D3 | Owner | **Finance → Collection**: janji bayar, lewat jatuh tempo | Muncul di daftar perlu tindakan / brief pagi. |
| D4 | Sales | Toko tertunggak > H+3 → buat order baru | **Terkunci**; sales ajukan **Buka Kunci** → Owner setujui sekali pakai. |
| D5 | Sales | Klaim bayar tapi uang tidak pernah disetor | Risk Alert "Unremitted Collection" muncul untuk Owner. |

## Skenario E — Penjagaan & Owner

| # | Peran | Aksi | Diharapkan |
|---|---|---|---|
| E1 | Owner | **Risk Alert**: cek peringatan diskon janggal, jam kunjungan mencurigakan | Alert muncul; **sales tidak bisa menghapusnya**. |
| E2 | Owner | **Tanya AODP**: "omzet minggu ini?", "toko mana yang menunggak?" | Jawaban sesuai data nyata, bukan karangan. |
| E3 | Owner | Brief WA (pagi/sore) | Isi sesuai data; **pagar nomor uji masih aktif** — jangan kirim ke nomor asli. |
| E4 | Owner | **Pengguna**: tambah sales, reset password anggota | Berhasil; sales baru bisa login dengan role benar. |

## Skenario F — Keamanan peran (harus GAGAL)

| # | Peran | Coba | Diharapkan |
|---|---|---|---|
| F1 | Sales | Buka URL `/dashboard/finance` langsung | Ditolak / dialihkan. |
| F2 | Sales | Buka detail order milik sales lain | Tidak terlihat sesuai aturan tenant/role. |
| F3 | Sales | Cari tombol Terbitkan Invoice / setujui harga khusus | **Tidak ada**. |
| F4 | Admin | Coba verifikasi/catat pembayaran | Tidak punya akses (hanya Owner). |
| F5 | Semua | Login sebagai tenant A lalu cari data tenant B | Tidak terlihat sama sekali. |

## Titik yang harus diwaspadai (diketahui belum sempurna)

1. Verifikasi pengiriman (A6) berjalan di **Telegram**; belum pernah diuji
   lengkap sampai invoice di lingkungan hosted. Ini titik paling rawan.
2. Pengantar bisa di-assign ke siapa saja yang aktif (belum ada penegakan
   role di backend) — Backlog #7. Aman untuk Waluyo (sales merangkap).
3. Tidak ada halaman edit profil perusahaan; profil kosong membuat
   Terbit Invoice ditolak.
4. Order seed `SO-DEV-0001` kosong item — buat order sendiri untuk uji.
5. Pesan error dari server production bisa tampil generik (Backlog #4).

## Lembar hasil

Salin tabel di atas ke catatan sesi uji, isi kolom OK/GAGAL/ANEH, lalu
serahkan semua yang GAGAL/ANEH ke Claude Code untuk dicatat di
`TRACKER.md` (intake) sebelum diperbaiki.

**Kriteria "sudah fix"**: Skenario A–D semua OK, Skenario F semua GAGAL
sebagaimana mestinya (artinya penjagaan bekerja), dan tidak ada temuan
ANEH yang menyentuh uang atau stok.
