# AODP Waluyo Living Knowledge Pack v1.0

## 1. Metadata

| Field | Value |
|---|---|
| Pack ID | `AODP-WALUYO-CORE-001` |
| Version | `1.0.0` |
| Status | `PUBLISHED — LOCKED` |
| Effective date | 15 Juli 2026 |
| Design partner | Waluyo Distributor / Pak Waluyo |
| Product | AI Operating Distributor Platform (AODP) |
| Knowledge type | Design-partner operating knowledge |
| Source | Wawancara/discovery Pak Waluyo dan keputusan Founder yang telah dikunci |
| Supersedes | Draft/default discovery assumptions sebelum wawancara |

> Catatan identitas: Waluyo Distributor adalah design partner resmi. “Surabraja” tidak termasuk scope AODP dan tidak boleh digunakan sebagai sumber discovery. PT Viona Multi Global merupakan konteks proyek sebelumnya, bukan design partner AODP.

## 2. Tujuan

Knowledge Pack ini menerjemahkan temuan lapangan Waluyo menjadi pengetahuan bisnis yang dapat digunakan oleh workflow, database, AI decision support, Business Guard, Executive Intelligence, demo, dan onboarding AODP.

Prinsip utamanya:

1. Owner harus tetap memegang kontrol atas order, barang, penagihan, dan uang.
2. Sistem harus membandingkan rencana dengan kenyataan, bukan hanya mencatat transaksi.
3. Exception harus memiliki alasan dan bukti.
4. Sales tidak boleh dapat menghapus jejak alert atau penyimpangan.
5. Pengetahuan bisnis dapat diperbarui sebagai versi baru tanpa menunggu rilis ulang platform inti.

## 3. Temuan tervalidasi

| ID | Temuan lapangan | Status | Dampak produk |
|---|---|---|---|
| WK-01 | Kasus PO/kiriman 300 dus tetapi yang benar-benar turun atau diterima hanya 150 dus menimbulkan kerugian besar, sekitar Rp550 juta. | LOCKED | Wajib ada Delivery Verification dan rekonsiliasi PO–kirim–terima–invoice. |
| WK-02 | Nilai order toko dapat menurun bertahap, misalnya Rp10 juta → Rp5 juta → Rp3 juta. | LOCKED | Menjadi sinyal Customer Health dan potensi churn/masalah pembayaran. |
| WK-03 | Tempo pembayaran yang digunakan dalam konteks Waluyo adalah sekitar dua minggu. | LOCKED | Menjadi baseline konfigurasi Collection Intelligence, bukan konstanta universal platform. |
| WK-04 | Pergantian orang yang memesan, misalnya sebelumnya suami lalu istri, pergantian PIC, atau perubahan nomor WhatsApp dapat menandakan perubahan kondisi toko. | LOCKED | Wajib dicatat sebagai perubahan relasi/PIC dan masuk Customer Health. |
| WK-05 | Titip uang sebagian, misalnya Rp1 juta dari kewajiban Rp10 juta, dapat menjadi awal pola penyimpangan atau fraud. | LOCKED | Business Guard harus menandai serah-terima uang tidak langsung dan pembayaran yang tidak terverifikasi. |
| WK-06 | Dapat terjadi mismatch antara nilai kiriman/tagihan dan uang yang diterima, misalnya transaksi Rp15 juta tetapi uang yang tercatat hanya Rp10 juta. | LOCKED | Wajib ada rekonsiliasi invoice–payment serta alert selisih. |
| WK-07 | Sales bekerja berdasarkan wilayah/TO, termasuk Cirebon Timur, Kota, dan Barat. | LOCKED | Monitoring kinerja dan anomaly harus mempertimbangkan area penugasan. |
| WK-08 | Tanda tangan digital untuk bukti penerimaan disetujui. | LOCKED | Delivery evidence harus mendukung identitas penerima dan tanda tangan. |
| WK-09 | Toko dapat tutup, menerima sebagian, atau menolak barang ketika pengiriman dilakukan. | LOCKED | Exception delivery harus menjadi state resmi, bukan koreksi manual diam-diam. |
| WK-10 | Penyimpangan rute driver dari pola atau rute tugas yang wajar perlu memicu perhatian supervisor. | LOCKED | Route deviation menjadi kandidat sinyal Business Guard berbasis GPS/provider tracking. |
| WK-11 | Owner membutuhkan perlindungan dan ringkasan exception, bukan sekadar dashboard angka. | LOCKED | Executive Intelligence harus menyajikan risiko, alasan, bukti, dan tindakan yang direkomendasikan. |
| WK-12 | Operasional internal/sales menggunakan Telegram; owner/executive menggunakan WhatsApp. | LOCKED | Semua workflow dan alert wajib mengikuti pemisahan channel ini. |

## 4. Workflow resmi AODP

Satu vertical slice resmi:

`Sales Order → Delivery Verification → Invoice → Collection → Owner Alert`

Workflow lain tidak boleh dibuka sebagai jalur implementasi terpisah sebelum vertical slice ini selesai end-to-end.

### 4.1 Sales Order

- Sales memasukkan order melalui Telegram menggunakan teks atau voice.
- Sistem mengekstrak customer, produk, jumlah, satuan, harga, dan diskon.
- Sistem mengirim ringkasan untuk dikonfirmasi sales sebelum order final.
- Customer/product/unit yang tidak dikenali menjadi Knowledge Candidate, bukan langsung dipublikasikan.
- Diskon di luar kebijakan menghasilkan status `requires_review`.

### 4.2 Delivery Verification

Sistem wajib menyimpan dan merekonsiliasi empat nilai:

1. Barang yang dipesan pada Sales Order/PO.
2. Barang yang disiapkan atau dibawa untuk dikirim.
3. Barang yang benar-benar diterima toko.
4. Barang yang boleh ditagihkan pada invoice.

State minimum:

- `planned`
- `dispatched`
- `arrived`
- `fully_received`
- `partially_received`
- `rejected`
- `store_closed`
- `failed`
- `verified`

Setiap perbedaan wajib memiliki reason code, catatan, waktu, lokasi, pelaksana, dan evidence.

Evidence minimum yang didukung:

- foto;
- waktu dan lokasi/GPS;
- nama serta identitas/keterangan penerima;
- tanda tangan digital;
- voice note atau catatan pendukung bila diperlukan.

### 4.3 Invoice

- Invoice dan piutang hanya boleh dibentuk dari barang yang benar-benar diterima dan diverifikasi.
- Barang yang ditolak, tidak terkirim, atau dibawa kembali tidak boleh otomatis menjadi piutang toko.
- Selisih antara order, kirim, terima, dan invoice harus tetap tersimpan untuk audit.

### 4.4 Collection

- Sistem membandingkan invoice, jatuh tempo, pembayaran terverifikasi, janji bayar, dan keterlambatan.
- Pembayaran melalui perantara/sales harus menyimpan pihak yang menyerahkan, pihak yang menerima, waktu, jumlah, dan bukti.
- Titip uang atau pembayaran sebagian bukan otomatis fraud, tetapi menjadi sinyal yang perlu diverifikasi.

### 4.5 Owner Alert

- Alert kritis dikirim kepada owner melalui WhatsApp.
- Tugas verifikasi, reminder, dan kebutuhan bukti dikirim ke internal/sales melalui Telegram.
- Alert harus berisi: transaksi/toko, jenis penyimpangan, nilai selisih, bukti yang tersedia, tingkat risiko, dan tindakan yang disarankan.
- Alert Business Guard bersifat append-only bagi sales; sales tidak boleh menghapus atau menurunkan status risiko.

## 5. Decision rules v1.0

### DV-01 — Full delivery

Jika jumlah diterima sama dengan jumlah yang dikirim dan bukti minimum lengkap, delivery dapat berstatus `verified`. Invoice menggunakan jumlah diterima.

### DV-02 — Partial delivery

Jika jumlah diterima lebih kecil daripada jumlah dikirim:

- status `partially_received`;
- alasan wajib dipilih;
- bukti penerimaan wajib ada;
- sisa barang harus memiliki disposition: dibawa kembali, dijadwalkan ulang, rusak, atau status lain yang diaudit;
- invoice hanya memakai jumlah yang diterima.

### DV-03 — Store closed

Jika toko tutup:

- status `store_closed`;
- foto, waktu, dan lokasi wajib direkam;
- tidak membuat invoice baru;
- sistem membuat tugas penjadwalan ulang.

### DV-04 — Rejected delivery

Jika toko menolak sebagian/seluruh barang:

- status `rejected` atau `partially_received`;
- alasan penolakan dan evidence wajib;
- invoice hanya untuk barang yang diterima;
- penolakan berulang menjadi sinyal Customer Health.

### DV-05 — Changed recipient/PIC

Jika penerima/PIC berbeda dari riwayat normal:

- sistem meminta identitas/keterangan penerima baru;
- perubahan dicatat sebagai relationship event;
- tidak otomatis memblokir transaksi;
- dapat menaikkan kebutuhan verifikasi atau memicu alert bila digabung dengan sinyal lain.

### BG-01 — Money handoff anomaly

Pembayaran yang dititipkan melalui sales/driver atau tidak memiliki bukti penerimaan resmi harus berstatus `unverified` sampai direkonsiliasi. Sistem tidak boleh menyimpulkan fraud hanya dari satu sinyal.

### BG-02 — Financial mismatch

Jika nilai invoice berbeda dari pembayaran terverifikasi, sistem menghitung selisih dan membuat exception. Severity mempertimbangkan nilai, umur selisih, pengulangan, dan bukti.

### BG-03 — Route deviation

Route deviation hanya boleh dinilai jika tersedia data GPS/provider yang sah dan rute tugas/baseline yang memadai. Penyimpangan menghasilkan reminder/alert supervisor, bukan vonis fraud otomatis.

### CH-01 — Order decline

Penurunan nilai/frekuensi order dari pola historis menjadi sinyal Order Health. Ambang persentase dan periode observasi harus dikalibrasi per tenant dan disimpan sebagai konfigurasi Knowledge Pack.

### CH-02 — Relationship change

Pergantian PIC, pemesan, nomor WhatsApp, atau penerima menjadi Relationship Health event. Dampak risiko ditentukan bersama sinyal pembayaran, order, dan exposure.

### DC-01 — Discount control

Diskon harus dibandingkan dengan kebijakan aktif berdasarkan produk/customer/role. Diskon di luar batas tidak boleh lolos diam-diam; statusnya `requires_review` dan memerlukan approval sesuai kewenangan.

## 6. Customer Health v1.0

Customer Health adalah insight layer, bukan modul terpisah. Empat dimensi awal:

| Dimensi | Sinyal awal |
|---|---|
| Order Health | Penurunan nilai/frekuensi, order berhenti, perubahan mix produk, penolakan berulang |
| Payment Health | Terlambat, pembayaran sebagian, janji bayar meleset, selisih tidak selesai |
| Relationship Health | Pergantian PIC/pemesan/nomor/penerima, kontak sulit dihubungi |
| Exposure Health | Nilai piutang, konsentrasi transaksi, nilai barang dalam proses, exception terbuka |

Belum ada bobot atau threshold universal yang dikunci. Implementasi v1 harus menyimpan sinyal dan alasan secara transparan; threshold dikelola sebagai konfigurasi versioned, bukan hard-code tersembunyi.

## 7. Living Knowledge governance

Siklus pengetahuan:

`Observed → Candidate → Reviewed → Published → Superseded/Retired`

Aturan:

- Koreksi sales/driver tidak boleh langsung mengubah Published Knowledge.
- Setiap perubahan menyimpan sumber, reviewer, waktu, alasan, versi sebelumnya, dan tanggal efektif.
- Rule published harus dapat dilacak ke temuan atau keputusan yang sah.
- AI boleh merekomendasikan kandidat, tetapi manusia berwenang yang mempublikasikan kebijakan bisnis.
- Tenant-specific threshold tidak boleh dianggap berlaku universal bagi distributor lain.

## 8. Batas keputusan AI

AI boleh:

- mengekstrak order;
- mendeteksi selisih dan perubahan pola;
- mengelompokkan severity berdasarkan aturan yang transparan;
- meminta bukti tambahan;
- merekomendasikan tindakan.

AI tidak boleh:

- menuduh sales, driver, atau toko melakukan fraud tanpa proses verifikasi;
- membuat invoice atas barang yang belum diterima;
- menghapus evidence/alert;
- mempublikasikan Knowledge Candidate secara otomatis;
- mengubah kebijakan diskon atau tempo tanpa approval.

## 9. Consumers

| Consumer | Penggunaan pack |
|---|---|
| Telegram Sales Assistant | Order entry, confirmation, exception task, evidence request |
| Delivery Verification | Reconciliation, state, reason, evidence |
| Invoice/AR | Menentukan kuantitas/nilai yang layak ditagihkan |
| Collection Intelligence | Jatuh tempo, payment mismatch, promise-to-pay |
| Business Guard | Financial, relationship, delivery, discount, dan route signals |
| Customer Health | Empat dimensi health dan perubahan pola |
| Executive Intelligence | Ringkasan risiko, bukti, rekomendasi, dan owner action |
| WhatsApp Owner Channel | Critical alert, approval tertentu, executive report |

## 10. Versioning berikutnya

Versi `1.1.0` dapat diterbitkan setelah data operasional pilot menghasilkan kalibrasi nyata untuk:

- ambang penurunan order;
- toleransi keterlambatan dan payment mismatch;
- severity berdasarkan nilai selisih;
- pola perubahan PIC;
- baseline/radius route deviation;
- approval matrix diskon;
- evidence minimum per jenis exception.

Perubahan tersebut tidak membatalkan v1.0; perubahan diterbitkan sebagai firmware-like knowledge update dengan changelog.

