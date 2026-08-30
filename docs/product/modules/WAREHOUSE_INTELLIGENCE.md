# Module Spec — Warehouse Intelligence (AI-First, Roadmap)

> **Status**: Enterprise-tier / pasca-validasi, `🔒 LOCKED` sebagai
> placeholder-only di MVP per `AODP_PRODUCT_CONSTITUTION.md` (baris 245).
> Dokumen ini jawaban teknis "seperti apa bentuknya kalau dibangun" —
> hasil sesi perencanaan bersama Founder, 2026-08-25. Bukan implementasi
> kode. Untuk mulai membangun (Gate WH-0 dst., lihat "Urutan Rilis
> Teknis"), perlu konfirmasi eksplisit terpisah dari Founder saat itu —
> tidak otomatis jalan hanya karena dokumen ini tersimpan.

## Context

Rencana ini merespons narasi "kasus Rp550 juta": PO 300 dus dikirim,
customer cuma terima 150 dus, dan sistem hari ini **tidak bisa melacak**
di titik mana (PO → Picking → Loading → Delivery → Customer receiving)
kehilangannya terjadi. Titik kerugian pastinya belum diketahui, jadi
rencana ini menutup SEMUA titik.

**Penting**: rantai di atas sering dibaca cuma sebagai "barang keluar"
(gudang → customer). Tapi titik kerugian bisa juga terjadi di **barang
MASUK** — dari supplier/pabrik ke gudang distributor — SEBELUM proses
Picking/Loading bahkan dimulai. Kalau supplier mengirim 250 dus tapi
staf penerima mencatat "300 dus lengkap" (entah ceroboh, entah ada
kongkalikong dengan supplier), sistem akan menyimpan "stok hantu" 50
dus yang sebenarnya tidak pernah ada secara fisik — dan begitu stok
hantu itu "hilang" di proses berikutnya, semua kecurigaan salah arah
ke staf Picking/Loading, padahal akar masalahnya di penerimaan barang.
Karena itu rencana ini **wajib mencakup dua arah sekaligus**: barang
masuk (dari supplier) DAN barang keluar (ke customer) — bukan cuma
salah satu.

**Tiga prinsip wajib dari Founder** yang membentuk seluruh rencana ini:

1. **Berbasis AI** — bukan sekadar form isian yang direkonsiliasi
   manual, tapi AI yang benar-benar mengamati, belajar pola, dan
   mengambil keputusan (persis kerangka `AI Decision Framework` yang
   sudah terkunci di `AODP_PRODUCT_CONSTITUTION.md` §14: Data → Pattern
   Learning → Insight → Decision → Action).
2. **AI menjaga bisnis Owner** — posisinya sama seperti Business Guard
   ("hero module" di Constitution §12): proaktif mendeteksi &
   mengingatkan, bukan menunggu Owner buka layar dan mencari sendiri.
3. **Campur tangan manusia seminimal mungkin** — KECUALI approval Owner.
   Ini prinsip yang paling mengubah desain: staf gudang **tidak boleh
   diminta mengetik angka manual** kalau bisa dihindari — sedapat
   mungkin AI yang menangkap datanya secara pasif (kamera, sensor),
   bukan staf yang lapor sendiri (yang justru rawan dibohongi/dikolusi).

**Temuan yang mempertajam kasusnya**: `dispatch_delivery_atomic`
(`supabase/migrations/20260823000001_delivery_audit_atomic.sql:146-208`)
saat ini **hard-code** `dispatched_quantity = ordered_quantity` — sistem
mengasumsikan begitu saja tidak ada kehilangan di leg Picking→Loading.
Insertion point paling konkret untuk seluruh rencana ini.

---

## Filosofi Inti — AI Warehouse Guard

Ini BUKAN sistem "isi form di tiap checkpoint lalu AI cek angkanya."
Desain itu punya kelemahan: angka yang diketik manusia bisa dibohongi,
apalagi kalau dua orang sepakat berbohong bersama. Desain ini membalik
urutannya:

> **AI adalah yang MENANGKAP data (lewat kamera/sensor), bukan yang
> cuma MEMERIKSA data yang diketik manusia.**

Loop-nya persis kerangka resmi AODP:

| Tahap | Di Warehouse Intelligence |
|---|---|
| **Data** | Kamera + sensor menangkap otomatis: berapa unit lewat di titik ambil-rak, berapa unit naik ke truk — TANPA staf mengetik apa pun |
| **Pattern** | AI belajar pola normal per produk/staf/rute (waktu picking wajar, variasi kecil yang biasa terjadi) |
| **Insight** | AI temukan penyimpangan: "PO ini kehilangan 30 dus di titik Picking, terdeteksi kamera, oleh staf yang sedang bertugas jam segitu" |
| **Decision** | AI rekomendasikan tindakan berprioritas: tahan pengiriman untuk hitung ulang / tandai untuk investigasi / minta opname |
| **Action** | **Satu-satunya titik manusia wajib terlibat: Owner menyetujui tindakan itu** (atau menolak/menunda) — staf gudang sendiri tidak perlu "konfirmasi angka," mereka cukup kerja seperti biasa, AI yang mengamati |

Konsekuensi jujur dari prinsip ini: **tingkat "campur tangan manusia
minimal" itu berbanding lurus dengan alat yang dipasang.** Tanpa kamera/
sensor sama sekali, seseorang tetap harus memberi tahu sistem "saya
ambil sekian unit" — tidak ada cara lain barang bisa "melapor sendiri."
Karena itu, rencana ini satu rencana dengan alat penangkap otomatis
sebagai BAGIAN INTI (bukan tambahan opsional), karena alat itulah yang
memungkinkan prinsip #3 tercapai sungguhan.

---

## Ringkasan Bahasa Awam

Alur barang lengkap ada DUA arah: **Barang MASUK** (Pesanan ke supplier
→ Truk supplier datang → Diturunkan di gudang) dan **Barang KELUAR**
(Pesanan customer → Diambil dari rak/Picking → Dimuat ke truk/Loading →
Truk berangkat → Toko terima barang). Kerugian bisa terjadi di titik
mana pun di kedua arah ini — bukan cuma yang keluar.

Bayangkan dipasang kamera pintar (bukan CCTV biasa yang cuma merekam —
ini kamera yang "bisa menghitung apa yang dilihatnya") di TIGA titik:
area bongkar barang masuk dari supplier, area rak tempat barang diambil
untuk dikirim, dan area muat truk keluar. Kamera ini otomatis
menghitung berapa dus yang lewat di tiap titik — staf gudang tidak
perlu mengetik atau melapor apa pun, mereka cukup kerja seperti biasa.
AI membandingkan hitungan dari ketiga kamera itu, plus hitungan dari
pesanan (baik ke supplier maupun dari customer) dan konfirmasi toko di
ujung — kalau ada yang tidak nyambung di mana pun (termasuk kalau
supplier ternyata mengirim lebih sedikit dari yang dijanjikan), Owner
dapat WhatsApp hari itu juga, lengkap dengan titik mana yang dicurigai
dan siapa yang bertugas di jam itu.

Owner tidak perlu jadi detektif, tidak perlu percaya laporan staf
begitu saja, dan staf gudang tidak perlu direpotkan mengisi form —
mereka cukup bekerja, kamera dan AI yang mengawasi dan melapor ke
Owner. Satu-satunya hal yang Owner sendiri masih perlu lakukan: menyetujui
tindakan kalau AI menemukan sesuatu yang mencurigakan (misalnya menahan
pengiriman untuk dicek ulang) — itu memang keputusan bisnis yang
sengaja TIDAK diambil otomatis oleh AI, harus Owner yang putuskan.

---

## Workflow Warehouse Intelligence (per sesi, dengan cerita role play)

Tokoh ilustrasi: **Budi** (staf gudang, ambil barang/picking), **Joko**
(staf gudang, muat truk/loading). Kasus: PO customer 300 dus cat.

### Sesi 0 — PO ke Supplier (Baseline "Seharusnya Berapa yang Datang")

**Teknis**: Sistem catat pesanan pembelian (Purchase Order) ke
supplier/pabrik — produk apa, berapa unit, kapan diharapkan datang.
Ini baseline yang jadi pembanding di Sesi 1. **Catatan penting**: fitur
PO-ke-supplier ini SAMA SEKALI BELUM ADA di AODP hari ini — tidak ada
tabel supplier/vendor, tidak ada tabel purchase order masuk. Ini bagian
yang benar-benar baru dibangun dari nol, bukan perluasan dari yang
sudah ada (beda dengan sisi keluar yang sudah punya `sales_orders`
sebagai pijakan).

**Titik sentuh manusia**: Owner/staf pembelian input PO ke supplier
(wajar — ini keputusan bisnis, bukan sesuatu yang bisa "diamati kamera"
karena belum ada barang fisik yang bergerak).

### Sesi 1 — Barang Masuk Gudang (Goods Receipt, diamati otomatis)

**Teknis**: Kamera pintar di area BONGKAR MUAT PENERIMAAN (titik truk
supplier menurunkan barang) menghitung otomatis berapa unit yang
benar-benar turun dari truk — dibandingkan ke PO Sesi 0, BUKAN ke surat
jalan yang dibawa supir supplier. Hasil hitungan kamera inilah yang
masuk ke buku besar stok (`stock_movements`), bukan angka yang ditulis
manusia di kertas mana pun.

**Titik sentuh manusia**: staf tetap fisik menerima & menurunkan barang
dari truk (tidak terhindarkan), TAPI tidak perlu mengetik/menghitung
"saya terima sekian unit" secara manual, dan yang lebih penting: **tidak
bisa lagi cuma tanda tangan surat jalan supplier tanpa hitung ulang** —
kamera yang jadi sumber kebenaran, bukan dokumen dari pihak luar.

**Cerita role play (fraud di sisi MASUK, bukan cuma keluar)**:
Distributor pesan 300 dus dari pabrik. Truk supplier datang, tapi
fisiknya cuma bongkar 250 dus — entah supplier sengaja mengirim kurang
(sambil tetap menagih 300, "kongkalikong" dengan staf penerima yang
dapat bagian), entah staf penerima (misalnya "Dedi") cuma percaya surat
jalan tertulis "300" tanpa repot menghitung ulang satu-satu. Hari ini,
sistem AODP akan mencatat stok masuk 300 dus — **padahal fisiknya cuma
250**. 50 dus "hantu" ini akan tersimpan di sistem seolah-olah ada,
sampai suatu saat "hilang" lagi di proses berikutnya — dan Owner akan
salah menuduh staf Picking/Loading, padahal barang itu memang TIDAK
PERNAH ADA di gudang sejak awal.

Dengan Sesi 1 (kamera di titik bongkar), sistem menghitung independen
dari surat jalan: cuma 250 yang benar-benar turun dari truk, meski
suratnya tertulis 300. Selisih 50 dus otomatis terdeteksi SEBELUM
barang itu bahkan sempat "hilang" secara administratif — Owner dapat WA:
"PO ke Supplier X untuk 300 dus, kamera penerimaan hitung cuma 250 yang
turun hari ini jam sekian — ada selisih 50 dus dari yang dijanjikan
supplier." Owner bisa langsung komplain ke supplier dengan bukti visual
konkret, dan staf penerima tidak bisa lagi cuma "ikut tanda tangan"
tanpa risiko — kalau ada kongkalikong dengan supplier, kamera yang jadi
saksi, bukan surat jalan yang bisa dikarang siapa saja.

### Sesi 2 — Picking (Ambil dari Rak, diamati otomatis)

**Teknis**: Kamera pintar di area rak menghitung otomatis unit yang
diambil untuk tiap PO, dicocokkan ke jumlah pesanan. AI mencatat jam
kejadian + (lewat jadwal shift yang sudah ada di sistem) siapa yang
sedang bertugas di titik itu — **tanpa Budi perlu mengetik atau scan
apa pun sendiri.**

**Titik sentuh manusia**: Budi tetap fisik mengambil barang dari rak
(tidak terhindarkan) — tapi TIDAK ADA input data manual sama sekali.

**Cerita role play**: Hari ini, Budi bisa ambil 300 dus, sisihkan 30
untuk dirinya, taruh 270 di area loading — tidak ada yang tahu, karena
tidak ada yang mengamati proses ini sama sekali. Dengan Sesi 2, kamera
menghitung berapa yang benar-benar lewat dari rak — 270, bukan 300 —
otomatis, terlepas dari apa pun yang mau Budi klaim secara lisan.
Selisih 30 dus langsung tercatat sebagai kejadian di titik Picking,
jam sekian, shift siapa.

### Sesi 3 — Loading (Muat ke Truk, diamati otomatis)

**Teknis**: Kamera kedua di loading dock menghitung otomatis unit yang
naik ke truk, dibandingkan ke hitungan Sesi 2 (bukan ke jumlah pesanan
— titik ini yang mengganti perilaku sistem hari ini yang diam-diam
menganggap "yang dikirim = yang dipesan").

**Titik sentuh manusia**: Joko tetap fisik memuat truk — tanpa input
data manual.

**Cerita role play (kolusi, celah paling rawan di desain form-manual)**:
Di desain lama (isi form manual), kalau Budi dan Joko sepakat sama-sama
menulis "300," sistem tidak akan curiga karena kedua ANGKA YANG DIKETIK
cocok satu sama lain. **Dengan kamera menghitung otomatis, tidak ada
lagi "angka yang diketik" untuk disepakati bersama** — kamera di rak
menghitung 270 lewat, kamera di loading menghitung berapa pun yang
benar-benar naik ke truk, dan keduanya independen dari apa pun yang
ingin diklaim Budi atau Joko secara lisan. Ini yang membuat prinsip
"minim campur tangan manusia" sekaligus mempersempit ruang kolusi jauh
lebih dalam dibanding rencana form-manual — bukan cuma kebetulan,
memang saling berkaitan: makin sedikit manusia yang input data, makin
sedikit titik yang bisa dibohongi.

### Sesi 4 — Delivery & Konfirmasi Terima Toko

**Teknis**: Bagian ini SUDAH ADA dan sudah bagus (Delivery Verification)
— toko konfirmasi berapa yang diterima, selisih otomatis memicu WA ke
Owner. Perubahan di rencana ini: angka "yang dikirim" sekarang berasal
dari hitungan kamera Sesi 3 yang sungguhan, bukan asumsi.

**Titik sentuh manusia**: PIC toko tetap perlu konfirmasi terima (ini
di luar kendali AODP — terjadi di pihak customer), tapi ini SATU-SATUNYA
input manual yang memang tidak bisa digantikan kamera milik distributor
(barangnya sudah di tempat customer).

**Cerita role play**: Toko cuma terima 150 dari 300. Karena Sesi 2-3
sudah membuktikan lewat kamera bahwa 300 benar diambil DAN 300 benar
naik ke truk, AI langsung tahu: kehilangan 150 dus ini terjadi di
PERJALANAN (antara loading dan sampai toko), bukan di gudang. Owner
tidak perlu menuduh staf gudang lagi — AI sudah mempersempit
kecurigaan ke leg yang benar berdasarkan bukti, bukan tebakan.

### Sesi 5 — AI Insight & Rekomendasi ke Owner (inti "AI menjaga bisnis")

**Teknis**: AI membaca seluruh rantai Sesi 1-4 sekaligus, menunjuk
PERSIS leg mana yang bermasalah, belajar pola per staf/produk/rute dari
waktu ke waktu (mis. staf tertentu yang berulang kali di titik dengan
selisih), dan **merekomendasikan tindakan** dengan tingkat keyakinan —
bukan cuma "ada yang aneh," tapi "kemungkinan besar terjadi di titik X,
oleh Y, rekomendasi: Z." Masuk ke halaman Risk Alert dan ringkasan WA
harian Owner yang sudah ada.

**Titik sentuh manusia — SATU-SATUNYA yang wajib**: Owner menyetujui
atau menolak rekomendasi AI (mis. "tahan pengiriman berikutnya ke rute
ini untuk diperiksa" atau "buka investigasi ke staf ini") lewat WhatsApp
atau dashboard. AI tidak pernah mengambil tindakan konsekuensial
(memblokir staf, membatalkan pengiriman) sendiri tanpa persetujuan
Owner — ini garis batas yang sengaja dijaga, sesuai prinsip #3.

**Cerita role play**: Pak Waluyo tidak perlu jadi detektif sendiri lagi.
Tiap pagi dia dapat WA: "Kemarin ada selisih 30 dus di titik Picking,
kamera menunjukkan ini terjadi jam 14.20, shift Budi. Ini kejadian
kedua bulan ini untuk Budi. Rekomendasi: panggil Budi untuk klarifikasi
sebelum shift berikutnya. Setujui / Abaikan?" — satu tombol, bukan
investigasi manual berhari-hari.

### Sesi 6 — Stock Opname (Jaring Pengaman, Tetap Perlu Sentuhan Manusia)

**Teknis**: Sesekali (mis. bulanan), hitung fisik oleh pihak independen
(bukan Budi/Joko) dibandingkan ke buku besar Sesi 1. Ini **satu-satunya
sesi yang secara jujur masih butuh keterlibatan manusia lebih dari
sekadar approval** — karena tujuannya justru memverifikasi bahwa
KAMERA/AI sendiri tidak salah hitung atau diakali (mis. kamera bisa
gagal mendeteksi kalau ada penghalang, sudut mati, atau seseorang
sengaja merusak/menutup lensa).

**Cerita role play**: Ini jaring pengaman terakhir — bukan untuk
menangkap Budi/Joko lagi (kamera sudah menutup celah itu), tapi untuk
memastikan KAMERA-nya sendiri tidak dikelabui (mis. seseorang taruh
stiker di lensa, atau ada sudut yang tidak terpantau). AI yang baik
tetap butuh verifikasi berkala terhadap dunia nyata — bukan dipercaya
buta selamanya.

---

## Tabel Titik Sentuh Manusia (ringkasan prinsip #3)

| Sesi | Arah | Sentuhan fisik (tak terhindarkan) | Input data manual? | Approval Owner? |
|---|---|---|---|---|
| 0. PO ke Supplier | Masuk | Tidak | Ya — keputusan bisnis, wajar | Tidak (ini justru keputusan Owner sendiri) |
| 1. Goods Receipt | **Masuk** | Ya (turunkan dari truk supplier) | **Tidak** — kamera menghitung | Tidak perlu, kecuali ada anomali |
| 2. Picking | Keluar | Ya (ambil dari rak) | **Tidak** — kamera menghitung | Tidak perlu, kecuali ada anomali |
| 3. Loading | Keluar | Ya (muat ke truk) | **Tidak** — kamera menghitung | Tidak perlu, kecuali ada anomali |
| 4. Delivery/Terima Toko | Keluar | Ya (pihak customer) | Ya — di luar kendali AODP | Tidak |
| 5. Insight & Rekomendasi | Keduanya | Tidak | Tidak | **Ya — satu-satunya gate wajib** |
| 6. Stock Opname | Keduanya | Ya (hitung fisik berkala) | Ya (masukkan hasil hitung) | Tidak (kecuali ada koreksi besar) |

---

## Kebutuhan Hardware (bagian INTI, bukan opsional)

Karena prinsip #3 mengharuskan penangkapan data otomatis, alat berikut
bukan lagi "tambahan kalau mau," tapi bagian minimum supaya rencana ini
benar-benar berjalan sesuai filosofi AI-first:

| Komponen | Fungsi | Estimasi Biaya |
|---|---|---|
| Kamera AI di area Penerimaan/Goods Receipt (1 unit) | Hitung otomatis unit turun dari truk supplier (**barang MASUK**) | Kamera Rp500rb-1,2jt + **layanan AI penghitung objek** (video analytics) — kisaran umum Rp500rb–2 juta/bulan per titik (langganan) ATAU model custom (biaya proyek terpisah, tidak bisa dipatok pasti tanpa vendor) |
| Kamera AI di area Picking (1 unit) | Hitung otomatis unit keluar dari rak (**barang KELUAR**) | Sama seperti di atas |
| Kamera AI di area Loading (1 unit) | Hitung otomatis unit naik truk (**barang KELUAR**) | Sama seperti di atas |
| Server/edge device untuk jalankan AI counting (kalau tidak pakai cloud vendor) | Proses video jadi angka hitungan, untuk 3 titik sekaligus | Rp4–10 juta sekali beli (mini PC/edge AI box dengan kapasitas 3 kamera), ATAU Rp0 kalau pakai layanan cloud vendor (bayar bulanan saja) |
| **Alternatif/pelengkap: RFID portal** di titik Penerimaan, Picking & Loading | Hitung otomatis via tag, lebih presisi dari kamera untuk barang yang mirip bentuk | Setup portal Rp15–40 juta **per titik** (lebih mahal, tapi paling minim gagal-hitung) + tag per unit ~Rp500–2rb/tag (kalau produk belum di-tag dari pabrik/supplier, ini jadi kerja tambahan sekali di awal) |

**Estimasi total realistis untuk mulai (kamera AI di 3 titik — Penerimaan,
Picking, Loading — tanpa RFID)**:
±**Rp6–14 juta sekali beli** (3 kamera + edge device) + **Rp1,5–6
juta/bulan** (langganan AI video analytics 3 titik) — **ini perlu
dikonfirmasi ke vendor spesifik**, kisaran di atas murni estimasi pasar
umum, bukan kutipan harga resmi.

**Kalau anggaran hanya cukup pasang bertahap**: titik **Penerimaan**
(Sesi 1) dan **Loading** (Sesi 3) diprioritaskan lebih dulu — keduanya
titik "gerbang" (barang masuk pertama kali dicatat / barang terakhir
kali di gudang sebelum lepas kendali) yang paling menentukan baseline
kebenaran. Titik Picking (Sesi 2) bisa menyusul kedua kalau anggaran
bertahap.

**Kalau anggaran sangat terbatas di awal**: opsi turun kelas yang jujur
— scan barcode via HP staf (Rp0 hardware, cuma printer label
~Rp800rb-2jt) BISA jadi titik awal, TAPI ini mundur dari prinsip #3
(staf tetap harus aktif scan/input, bukan murni diamati pasif). Kalau
anggaran belum memungkinkan kamera AI, opsi ini realistis sebagai
langkah antara — kompromi, bukan pemenuhan penuh prinsip "minim campur
tangan manusia."

### Contoh Merk & Varian (referensi pasar, riset 2026-08-25 — bukan endorsement, bukan quote resmi)

Daftar ini untuk memudahkan mulai cari quote vendor — **wajib
dikonfirmasi ulang saat WH-4 benar-benar dikerjakan**, harga & lineup
produk bisa berubah.

| Kategori | Contoh merk/varian | Catatan |
|---|---|---|
| Kamera AI + video analytics (global) | **Hikvision** — solusi "ACIC AI Counting" (kombinasi kamera seri DLHEOP + algoritma ACIC) dan solusi "PIXCount" khusus goods-counting di gudang; **Dahua** — kamera/PTZ/NVR dengan AI people/object counting bawaan, klaim akurasi 95–99% | Dua pemain CCTV terbesar dunia, paling mudah dicari partner instalasi lokal di Indonesia |
| Kamera AI + integrator lokal Indonesia | **Indovisual** (solusi "Kamera Penghitung Barang" & "CCTV Object Counting Detection", fokus gudang/distribusi/retail); **XDC Indonesia** (distributor resmi Uniview, bagian CTI Group, kamera AI seri IPC22xx); **Widya Robotics** (vendor AI vision lokal, punya solusi computer-vision custom untuk hitung barang di jalur produksi — opsi kalau butuh model custom per-SKU produk distributor) | Prioritaskan integrator lokal untuk instalasi + support after-sales real-time — lebih relevan daripada beli device global lalu bingung siapa yang pasang/kalibrasi |
| Edge device (jalankan AI counting on-premise, tanpa cloud) | **NVIDIA Jetson Orin Nano Super Developer Kit** — ±USD 249 (±Rp4 juta), 67 TOPS AI performance, cukup untuk proses beberapa stream kamera sekaligus | Alternatif kalau tidak mau bayar langganan cloud video-analytics bulanan; tetap butuh integrator yang pasang model counting-nya (Jetson cuma hardware-nya) |
| RFID portal & reader (opsi lebih presisi, lebih mahal) | **Zebra** — lini "Integrated RFID Portals" + fixed reader; **Impinj R700** — RAIN RFID reader kelas enterprise (biasanya jadi komponen di dalam portal Zebra/vendor lain) | Distributor resmi Zebra Indonesia: **Harrisma** dan **AGM Tech** (Zebra Indonesia juga jual/support langsung) — bisa langsung tanya quote portal RFID + tag ke mereka |

Sumber riset: [Hikvision — People Counting / ACIC AI Counting](https://www.hikvision.com/us-en/core-technologies/ai-analytics/people-counting/), [Hikvision PIXCount goods-by-AI-camera solution](https://tpp.hikvision.com/solution/SolutionDetail?Id=265&v=en), [Dahua People Counting](https://www.cctv-mall.com/blogs/news/how-to-use-dahua-people-counting-correctly), [NVIDIA Jetson Orin Nano Super Developer Kit](https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/nano-super-developer-kit/), [Zebra Integrated RFID Portals](https://www.zebra.com/us/en/products/rfid/integrated-rfid-portals/integrated-rfid-portals-series.html), [Impinj R700 RAIN RFID Reader](https://www.atlasrfidstore.com/impinj-r700-RAIN-rfid-reader/), [Harrisma — Distributor Zebra Indonesia](https://www.harrisma.com/en/zebra/), [Indovisual — Kamera Penghitung Barang](https://www.indovisual.co.id/kamera-penghitung-barang/), [XDC Indonesia — CCTV AI](https://xdc-indonesia.com/cctv-ai-teknologi-next-gen-untuk-keamanan-yang-lebih-cerdas/), [Widya Robotics — Kamera AI Penghitung Barang](https://widya.ai/kamera-ai-untuk-menghitung-jumlah-barang-di-jalur-produksi/).

---

## Confidence CTO

**Kalau pakai kamera AI penuh di Sesi 1-3 (sesuai prinsip #3 seutuhnya): HIGH.**
Data yang ditangkap bukan lagi self-report yang bisa disepakati bersama
untuk dibohongi — kamera menghitung independen dari apa pun yang staf
klaim. Ini menutup celah kolusi yang jadi kelemahan utama desain
form-manual. Confidence tetap bukan 100% (kamera bisa gagal deteksi di
sudut mati, oklusi barang bertumpuk, atau butuh Sesi 6 opname untuk
verifikasi berkala bahwa kamera sendiri tidak diakali) — tapi ini
peningkatan besar, dan sejalan dengan prinsip Owner-approval-only.

**Kalau technical/anggaran belum memungkinkan kamera AI, mundur ke scan
manual (barcode via HP): MEDIUM.**
Masih jauh lebih baik dari status quo (nol pengamatan sama sekali), dan
AI tetap bekerja penuh di Sesi 5 (pattern/insight/decision/action) di
atas data manual itu. Tapi jujur: ini TIDAK memenuhi prinsip #3
seutuhnya, karena staf tetap harus aktif scan/input — celah kolusi dua
orang (lihat Sesi 3) tetap ada sampai kamera benar-benar terpasang.

---

## Risiko & Catatan Jujur Lain

1. **AI video counting bukan "pasang lalu langsung sempurna."** Perlu
   kalibrasi per SKU (produk beda bentuk/ukuran perlu training/setup
   berbeda), rawan error kalau barang bertumpuk/saling menutupi, dan
   perlu vendor/quote spesifik untuk angka biaya pasti — estimasi di
   atas kisaran umum pasar, bukan kutipan resmi.
2. **Migrasi ke `dispatch_delivery_atomic`** (Sesi 3 bagian teknis)
   tetap perubahan dengan blast radius tertinggi — RPC ini terkunci,
   teruji, produksi. Wajib di-gate per-company flag (default OFF) +
   regression test jalur lama.
3. **Sesi 6 (opname fisik) tetap wajib ada**, bukan bisa dihilangkan
   sepenuhnya — AI yang mengamati lewat kamera tetap perlu diverifikasi
   sesekali terhadap dunia nyata, supaya tidak jadi "dipercaya buta."
4. **Skala kerja**: menambah lapisan AI video counting membuat rencana
   ini lebih besar dari draf software-manual — perlu integrasi vendor
   AI vision (pihak ketiga) di samping pengembangan internal AODP
   sendiri, bukan cuma coding di dalam codebase ini saja.

---

## Urutan Rilis Teknis (referensi implementasi, satu fokus per waktu)

| Gate | Sesi terkait | Isi | Ukuran |
|---|---|---|---|
| WH-0 | Sesi 0 | Subsistem baru sepenuhnya: tabel supplier/vendor + tabel purchase order ke supplier (inbound PO) — **belum ada sama sekali di AODP hari ini**, beda dengan sisi keluar yang sudah punya `sales_orders` sebagai pijakan | Sedang (skema baru dari nol, bukan perluasan) |
| WH-1 | Sesi 1 | Buku besar stok (`stock_movements`) untuk goods receipt + integrasi input dari kamera/RFID/manual (ketiganya masuk lewat RPC yang sama), dibandingkan ke baseline PO dari WH-0 | Kecil-Sedang |
| WH-2 | Sesi 2 | Picking checkpoint — mulai dengan input manual dulu (fallback), siap menerima input otomatis dari kamera begitu terpasang | Sedang |
| WH-3 | Sesi 3, 4 | Loading checkpoint + ubah `dispatch_delivery_atomic` (flag OFF default) | Sedang-Besar (blast radius RPC produksi terkunci) |
| WH-4 | Kamera AI | Integrasi vendor video-analytics/RFID ke Sesi 1, 2 & 3 (3 titik: Penerimaan, Picking, Loading) — gantikan input manual begitu hardware siap | Sedang-Besar (tergantung vendor yang dipilih) |
| WH-5 | Sesi 5 | Detector `detectStockLeakage`/`summarizeWarehouseRisk` + rekomendasi aksi + alur approval Owner — mencakup insight dari kedua arah (masuk & keluar) | Sedang |
| WH-6 | Sesi 6 | Stock opname | Sedang |

Minimum viable slice: **WH-0 + WH-1 + WH-2 (versi input manual dulu) +
WH-5** — sudah memberi AI insight & proteksi dasar di KEDUA arah (masuk
dari supplier via WH-0/WH-1, keluar via WH-2) sambil menunggu kamera
terpasang (WH-4), tanpa menyentuh RPC `dispatch_delivery_atomic` yang
terkunci sama sekali sampai WH-3 benar-benar siap.

## File Kritis untuk Referensi Implementasi

- `supabase/migrations/20260823000001_delivery_audit_atomic.sql` — RPC yang akan disentuh di WH-3
- `supabase/migrations/20260716000001_delivery_verification.sql` — pola reconciliation table untuk ditiru
- `supabase/migrations/20261022000001_collection_field_outcome.sql` — pola permission-tiering untuk ditiru
- `apps/web/src/lib/business-guard/engine.ts` + `features/discount-anomaly.ts` — pola detector untuk ditiru
- `apps/web/src/lib/business-guard/alert-state.ts` — anti-spam notify, tinggal tambah alert_type baru
- `supabase/migrations/20260626000003_create_business_tables.sql` — `products.stock_quantity` existing
- `apps/web/src/app/(dashboard)/dashboard/warehouse/page.tsx` — placeholder yang akan diganti
- `packages/ai` — AI provider layer existing (wajib dipakai untuk bagian rekomendasi/insight, bukan panggil vendor AI langsung, sesuai Development Rules #3)
- **Tidak ada file existing untuk WH-0** (supplier/vendor + inbound PO) — ini migration & tabel baru dari nol, bukan modifikasi. Ikuti pola multi-tenant standar (`company_id` + RLS) dari `20260626000003_create_business_tables.sql` sebagai template struktur, bukan isinya.

## Verifikasi (kalau dilanjutkan ke implementasi nyata)

- Setiap gate: `tsc` bersih, integration test Postgres asli (pola
  `describeIfDb`) untuk RPC baru, khusus WH-3 wajib ada regression test
  jalur flag-OFF (legacy) supaya tidak ada company existing yang
  terdampak diam-diam.
- WH-4 (integrasi kamera/RFID) perlu jalur uji terpisah dengan data
  vendor sungguhan (sandbox/demo mode vendor) sebelum dipasang fisik.
- Browser lokal, arah KELUAR: alur Picking → Loading → Dispatch →
  Delivery end-to-end dengan skenario sengaja ada selisih di satu leg,
  buktikan detector `detectStockLeakage` menunjuk leg yang benar DAN
  alur approval Owner (setuju/tolak rekomendasi) berjalan sesuai desain.
- Browser lokal, arah MASUK: alur PO ke Supplier (WH-0) → Goods Receipt
  (WH-1) end-to-end dengan skenario sengaja ada selisih (PO 300, kamera
  hitung 250), buktikan selisih terdeteksi SEBELUM masuk buku besar stok
  dan Owner dapat insight yang menunjuk ke leg penerimaan, bukan ke
  staf Picking/Loading.
- Sebelum push ke hosted: konfirmasi eksplisit ke Founder bahwa
  `warehouse_intelligence_enabled` tetap OFF untuk tenant Waluyo sampai
  benar-benar siap dipakai lapangan.
