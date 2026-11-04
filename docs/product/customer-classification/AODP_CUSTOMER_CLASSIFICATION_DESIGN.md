# Rancangan — Klasifikasi Customer (tempo, harga, ambang persetujuan)

Status: **USULAN, menunggu persetujuan Founder** (2026-11-04). Belum ada kode.
Asal: jawaban Pak Waluyo — master customer punya klasifikasi (besar, grosir, eceran) dengan
tempo diset; memanggil customer mengisi tempo & harga otomatis; ambang persetujuan nilai besar
"tergantung kondite customer".
Rujukan, jangan disalin: `AODP_PARTIAL_DELIVERY_INVOICING_DESIGN.md`, `AODP_DELIVERY_ADMIN_INPUT_DESIGN.md`.

## Fakta kode (terverifikasi 2026-11-04)

- `customers.type` hanya `reseller|direct|distributor|modern_trade` (CHECK); tidak ada tempo,
  harga, atau limit per customer.
- Form order meminta `payment_terms_days` manual (`components/orders/order-form.tsx`).
- Harga: `products.price` tunggal. Penegakan harga (gate 3E D4/D6, TERKUNCI) membandingkan
  `unit_price` order dengan `products.price`; harga lain wajib lewat proposal harga khusus
  yang disetujui Owner. Penulis `products.price` hanya import master data.
  => Harga per klasifikasi MENYENTUH gerbang terkunci.

## Rancangan

Tabel baru `customer_classes` (per company, RLS, wajib `company_id`):
`id, company_id, name (mis. Besar/Grosir/Eceran), default_payment_terms_days,
approval_threshold_amount (ambang persetujuan Owner untuk tagihan besar, NULL = tanpa ambang),
is_active`. Kolom baru `customers.class_id` (nullable → tidak merusak data lama).

Penetapan & ubah klasifikasi customer: hanya Owner/Admin; perubahan tercatat di audit log
(klasifikasi menentukan harga & tempo → jangan bisa diubah sales).

### Irisan (masing-masing bisa diuji sendiri)

1. **K-1 Klasifikasi + tempo default** (aman, tidak menyentuh gerbang terkunci):
   tabel + `customers.class_id`, layar kelola klasifikasi (Owner), pilih klasifikasi di form
   customer, tempo order terisi otomatis dari klasifikasi (tetap bisa dikoreksi dengan
   alasan? — keputusan Founder di bawah).
2. **K-2 Ambang persetujuan nilai besar**: invoice/penagihan di atas `approval_threshold_amount`
   kelas customer menunggu persetujuan Owner (pagar anti-kolusi admin–sales). Customer tanpa
   kelas memakai ambang bawaan perusahaan.
3. **K-3 Harga per klasifikasi** (menyentuh gerbang harga TERKUNCI → gate terpisah, hati-hati):
   tabel `product_class_prices (company_id, product_id, class_id, price)`; fungsi tunggal
   "harga acuan" (kelas jika ada, else `products.price`) dipakai form order DAN RPC penegakan
   harga; semua suite harga khusus diuji ulang. Dikerjakan terakhir.

## Keputusan Founder yang dibutuhkan

1. Urutan K-1 → K-2 → K-3 (K-3 terakhir karena menyentuh gerbang terkunci). Setuju?
2. Tempo hasil klasifikasi: sales boleh mengubah di order, atau terkunci (hanya Owner/Admin)?
   Saran: terkunci; perubahan lewat Owner (tempo panjang = risiko piutang).
3. Ambang: nilai awal per kelas dikonfirmasi Pak Waluyo (saran awal Rp5 juta tidak dipakai
   sebagai angka tunggal; beliau: tergantung kondite). Ambang awal boleh kosong dulu?
4. Data awal: daftar klasifikasi + tempo + harga per klasifikasi dari Pak Waluyo
   (diimpor lewat Setup Data bila tersedia).

## Pengujian

- Unit: pemilihan tempo/ambang/harga acuan per kelas, fallback customer tanpa kelas.
- Integration Postgres lokal: RLS lintas tenant, hanya Owner/Admin yang boleh mengubah kelas,
  K-3: seluruh suite penegakan harga & harga khusus tetap hijau.
- Browser: buat kelas → pilih di customer → order terisi tempo → (K-2) tagihan besar menunggu Owner.
- Deploy: migration `db push` dulu, lalu `git push`.
