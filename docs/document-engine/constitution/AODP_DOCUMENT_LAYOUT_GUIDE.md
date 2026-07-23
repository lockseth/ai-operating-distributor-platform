# AODP DOCUMENT LAYOUT GUIDE

> **⚠ SUPERSEDED / DRAFT LAMA — bukan source-of-truth kontrak aktif Pak Waluyo.**
>
> Keputusan bisnis LOCKED (Repository & Persistence Closure Gate) menetapkan
> template Totals kontrak aktif Pak Waluyo HANYA:
>
> **Subtotal → Potongan → Total → Terbilang**
>
> Bagian **Totals** di bawah ini (yang mencantumkan DPP/PPN/Other Charges)
> **TIDAK BERLAKU** untuk kontrak aktif — dipertahankan di sini hanya sebagai
> arsip historis draft yang sempat diperlihatkan ke Pak Waluyo, bukan
> spesifikasi yang harus diimplementasikan. Jangan menambahkan
> DPP/PPN/Other Charges (termasuk sebagai nilai nol) ke Document Engine atas
> dasar dokumen ini. Bagian lain di dokumen ini (Header, Customer Section,
> Item Columns LOCKED, Print Panel Layout LOCKED, Footer) tetap berlaku.

## Header

-   Company Logo
-   Company Name
-   Address
-   Phone
-   Email
-   Document Title
-   Number
-   Date

## Customer Section

-   Customer Code
-   Store Name
-   Address
-   Salesman

## Item Columns (LOCKED)

1.  No
2.  Kode Barang
3.  Nama Produk
4.  Jenis Produk
5.  Satuan
6.  Qty
7.  Harga
8.  Potongan
9.  Total

## Totals

Subtotal Invoice Discount DPP PPN Other Charges Grand Total Terbilang

## Print Panel Layout (LOCKED -- revisi 23 Juli 2026, keputusan FINAL hari ini)

> **Kronologi hari ini (23 Juli 2026, PENTING dibaca berurutan):**
> 1. Pagi: format bagi 2 panel/halaman (LOCK 19 Juli 2026) sempat
>    SUPERSEDED -- Founder memutuskan satu dokumen memenuhi satu halaman
>    penuh 9.5x11in ("Continuous Form 4 Ply").
>    "DITERIMA OLEH" menggantikan "Penerima".
> 2. Siang/sore: dua revisi lanjutan pada model halaman-penuh tersebut
>    (panel KETENTUAN PEMBAYARAN dihapus, lalu footer/badge/COPY-strip
>    dihapus).
> 3. **Malam (LOCK FINAL, membatalkan #1 dan #2 di atas untuk urusan
>    ukuran halaman/panel dan wording tanda tangan):** Founder mengoreksi
>    bahwa "4 Ply"/"bagi 2" pada #1 disalahpahami. Keputusan final:
>    Continuous Form **3 Ply** (bukan 4), SATU lembar fisik 9.5x11in
>    **dibagi 2 panel horizontal** 9.5x5.5in, SATU transaksi per panel.
>    Wording tanda tangan ketiga kembali ke **"Penerima"** (bukan
>    "DITERIMA OLEH"). Footer benefit/service, badge Continuous Form, dan
>    strip COPY 1-4 (yang sudah dihapus di langkah #2) TETAP dihapus --
>    keputusan itu TIDAK dibatalkan.
>
> Aturan aktif SEKARANG (superseding #1 dan #2 untuk hal ukuran
> halaman/panel dan wording tanda tangan):

-   Physical sheet: Continuous Form **3 Ply**, 9.5 x 11 inch per lembar
    fisik.
-   **Satu lembar fisik dibagi 2 panel horizontal, 9.5 x 5.5 inch
    masing-masing.** **Satu panel adalah satu unit cetak DOKUMEN** (LOCK
    "AODP WALUYO -- CONTINUATION PANEL PRINT GATE", superseding aturan lama
    "satu panel selalu satu transaksi tanpa pengecualian" -- lihat bagian
    Continuation Panel di bawah): dokumen yang muat dalam kapasitas satu
    panel memakai SATU panel; dokumen yang lebih panjang memakai BEBERAPA
    continuation panel berurutan, TETAP satu transaksi/nomor/versi. Satu
    panel TIDAK PERNAH berisi bagian dari DUA transaksi berbeda. Satu
    lembar fisik BOLEH berisi: dua transaksi pendek (PO+PO, Invoice+
    Invoice, atau PO+Invoice); dua halaman dari satu transaksi panjang; atau
    halaman final satu transaksi + halaman awal transaksi berikutnya --
    sesuai urutan batch cetak deterministik.
-   Slot panel kosong (tidak ada panel/dokumen berikutnya dalam antrean
    batch) tetap KOSONG -- tidak ada dummy document, tidak ada
    nomor/header/tanda tangan karangan.
-   "3 Ply" berarti TIGA rangkap kertas karbon/carbonless FISIK di
    printer dot matrix (tercetak bersamaan satu print run) -- BUKAN tiga
    panel HTML, BUKAN tiga transaksi per lembar, BUKAN duplikasi konten
    oleh renderer.
-   Struktur visual mengikuti template Pak Waluyo (source of truth visual,
    lihat laporan gate Document Engine 23 Juli 2026): header logo +
    identitas + garis hijau/oranye, panel metadata dokumen (No. Dokumen/
    Tanggal/Tempo/Salesman -- **SATU-SATUNYA** tempat tempo pembayaran
    ditampilkan, ditambah indikator "Halaman X/N" pada dokumen continuation),
    panel DATA TOKO/CUSTOMER full-width dua kolom internal (kiri: Kode
    Toko/Nama Toko/Alamat; kanan: No. Telp/Ref. Order/Ref. Delivery/
    Salesman) -- ditampilkan di SETIAP panel continuation supaya tiap
    halaman fisik mandiri, tabel produk header hijau, panel tanda tangan
    (HANYA panel final) atau penanda "Bersambung ke halaman berikutnya"
    (panel non-final), ringkasan total (HANYA panel final) -- dikompresi
    (font/padding lebih rapat) supaya tetap terbaca dalam tinggi panel
    5.5in. TIDAK ADA ilustrasi perforasi/sprocket/decorative dots di
    production print (lihat "Hapus Perforasi" di bawah).
-   **LOCKED (Founder, 23 Juli 2026, REGRESSION LOCKED -- lihat
    `print-css.test.ts`):** footer benefit/service, badge "Continuous Form",
    dan strip informasi COPY 1-4 TETAP DIHAPUS dari layout cetak (ruang
    panel 5.5in tidak cukup untuk elemen dekoratif tambahan).
-   **LOCKED (Founder, 23 Juli 2026):** panel KETENTUAN PEMBAYARAN terpisah
    DIHAPUS -- redundan dengan baris Tempo di panel metadata header. Ruang
    yang dibebaskan dipakai memperluas panel DATA TOKO/CUSTOMER menjadi
    full-width dua kolom internal (lihat di atas). Jangan menampilkan
    tempo pembayaran di lebih dari satu tempat.
-   Bank/No. Rekening/Metode Pembayaran TIDAK ditampilkan -- belum ada
    canonical source di skema (bukan dikarang). Termin pembayaran WAJIB ada
    (payment_terms_days, ditegakkan PAYMENT_TERMS_INCOMPLETE saat issuance).

### Continuation Panel (LOCK "AODP WALUYO -- CONTINUATION PANEL PRINT GATE")

-   Kapasitas baris item per panel: **10 baris** (`MAX_ITEM_ROWS_PER_PANEL`
    di `apps/web/src/lib/document-engine/print-capacity.ts`), diukur nyata
    dari layout print.css dengan fixture WORST-CASE (nama produk/jenis
    produk/alamat toko/nama salesman panjang realistis) -- termasuk
    verifikasi ulang dengan indikator "Halaman X/N" pada panel final: margin
    aman turun dari 0.32in menjadi 0.20in (tetap positif, tanpa overflow).
-   Dokumen yang melebihi 10 baris **TIDAK ditolak** -- dilanjutkan ke panel
    berikutnya (`lib/document-engine/print-pagination.ts`,
    `paginatePrintDocument`). Batas 10 ini SEKARANG murni parameter
    pagination, BUKAN alasan penolakan issuance.
-   Batas DOMAIN dokumen (berapa banyak baris boleh dimiliki SATU dokumen
    sebelum issuance ditolak) adalah hal TERPISAH: `MAX_DOCUMENT_LINE_ITEMS`
    di `source-validation.ts` = **30** (dipulihkan -- penyatuan sebelumnya
    dengan kapasitas panel TIDAK disetujui sebagai aturan bisnis final,
    lihat Revision History). Dokumen 11-30 baris SAH diterbitkan dan dicetak
    lewat continuation panel.
-   Contoh wajib: 1-10 produk -> 1 panel; 11-20 -> 2 panel; 21-30 -> 3
    panel; 25 produk -> 10 + 10 + 5.
-   Identitas dokumen (nomor, versi, tenant, pelanggan) SAMA di seluruh
    panel continuation; nomor urut baris item BERLANJUT (tidak reset ke 1).
    HANYA panel final memiliki grand total & tanda tangan (Salesman/
    Pengirim/Penerima) -- grand total dihitung dari SELURUH item dokumen,
    TIDAK ADA subtotal per panel karangan.
-   Panel non-final boleh menampilkan penanda "Bersambung ke halaman
    berikutnya" -- tidak boleh terlihat sebagai transaksi baru.
-   Continuation TIDAK PERNAH membuat PO/Invoice baru; immutability dokumen
    issued tetap berlaku (pagination adalah fungsi PURE presentational,
    tidak menyentuh issued_documents/snapshot).

### Hapus Perforasi (AUDIT FIX, corrective pass kedua)

Ilustrasi lubang/sprocket/perforasi/decorative dots **DIHAPUS TOTAL** dari
seluruh production print/PDF -- baik panel berisi transaksi maupun panel
kosong. `.doc-engine-perforation` dan `print-color-adjust`/
`-webkit-print-color-adjust` (yang sebelumnya ditambahkan untuk
mempertahankan pola perforasi) sudah dihapus dari `print.css`. Debug guide
(garis bagi tengah, `.doc-engine-divider-guide`) tetap boleh ada sebagai
penanda potong netral -- BUKAN ilustrasi dekoratif. Label proof "Panel
Atas"/"Panel Bawah" HANYA pada mode screen, tidak pernah pada print.

## Footer

Signatures, left to right: **SALESMAN, PENGIRIM, PENERIMA** (LOCK Founder
23 Juli 2026, keputusan final hari ini -- wording "DITERIMA OLEH" yang
sempat dipakai pada revisi pagi hari yang sama SUPERSEDED, kembali ke
"Penerima" konsisten dengan LOCK 19 Juli 2026). Salesman and Pengirim may
be the same person, but both signature areas remain separate and are
always shown. No "CATATAN" section and no empty notes area. No standalone
benefit/service footer, form badge, or COPY 1-4 strip (removed 23 Juli
2026, REGRESSION LOCKED -- see Revision History).

## Revision History

-   Revisi 19 Juli 2026: format bagi 3 digantikan format bagi 2;
    CATATAN dihapus; tanda tangan menjadi Salesman, Pengirim, dan
    Penerima.
-   Revisi 23 Juli 2026 (Founder): format bagi 2 panel/halaman SUPERSEDED --
    satu dokumen kini memenuhi satu halaman penuh 9.5x11in (Continuous Form
    4 Ply = rangkap kertas fisik, bukan duplikasi renderer). Struktur visual
    diselaraskan dengan template Pak Waluyo (perforasi, header hijau/oranye,
    panel metadata/customer/ketentuan pembayaran, tabel header hijau, footer
    benefit/service, badge form/copy). Tanda tangan ketiga menjadi
    "DITERIMA OLEH" (sebelumnya "Penerima"). Termin pembayaran
    (payment_terms_days) ditambahkan sebagai field wajib.
-   Revisi 23 Juli 2026 (Founder, LOCKED, revisi kedua hari yang sama):
    panel KETENTUAN PEMBAYARAN terpisah (dengan badge lingkaran "3")
    DIHAPUS -- redundan dengan baris Tempo yang sudah ada di panel metadata
    header ("6 Agustus 2026 (14 Hari)"). Panel DATA TOKO/CUSTOMER diperluas
    full-width dengan dua kolom internal (kiri: Kode Toko/Nama Toko/Alamat;
    kanan: No. Telp/Ref. Order/Ref. Delivery/Salesman) supaya ruang yang
    dibebaskan tidak kosong. Disetujui setelah verifikasi visual PO 7-item
    dan Invoice 7-item.
-   Revisi 23 Juli 2026 (Founder, LOCKED, revisi ketiga hari yang sama,
    REGRESSION LOCKED -- lihat `print-css.test.ts`): footer benefit/service,
    badge "Continuous Form 4 Ply", dan strip informasi COPY 1-4 DIHAPUS dari
    layout cetak. Ruang yang dibebaskan mencegah tabel item bertabrakan
    dengan panel tanda tangan pada order dengan banyak baris.
-   Revisi 23 Juli 2026 (Founder, LOCKED, keputusan FINAL hari ini,
    membatalkan bagian ukuran halaman/panel dan wording tanda tangan dari
    tiga revisi di atas -- lihat `AODP_PRINTING_STANDARD.md`,
    `print-css.test.ts`, `PrintDocumentPanel.tsx`, `PhysicalPrintSheet.tsx`,
    `print-batch.ts`, `print-capacity.ts`): terminologi "4 Ply" dikoreksi
    menjadi **"3 Ply"** (jumlah rangkap kertas karbon fisik yang benar).
    Format "satu dokumen = satu halaman penuh 9.5x11in" DIBATALKAN --
    kembali ke **bagi 2 panel per lembar fisik**, 9.5x5.5in per panel, SATU
    transaksi per panel, DUA transaksi independen per lembar fisik
    (top/bottom). Tanda tangan ketiga dikoreksi kembali dari "DITERIMA
    OLEH" menjadi **"Penerima"**. Footer benefit/service, badge, dan strip
    COPY 1-4 (dihapus pada revisi ketiga di atas) TETAP dihapus -- bagian
    itu TIDAK dibatalkan oleh revisi ini. Kapasitas baris item per panel
    diukur ulang untuk tinggi 5.5in (lihat `print-capacity.ts`) --
    MAX_DOCUMENT_LINE_ITEMS di `source-validation.ts` (saat itu masih 30,
    dikunci untuk model halaman-penuh 11in) BELUM diselaraskan dengan
    kapasitas panel 5.5in yang baru -- dilaporkan sebagai limitation
    (lihat revisi corrective pass di bawah untuk resolusinya).
-   Revisi 23 Juli 2026 (Founder, LOCKED, corrective pass atas audit
    independen -- lihat laporan "Document Governance Reconciliation and
    Half-Sheet Print Gate" corrective pass): TIGA koreksi:
    (1) perforasi sheet DIBATASI 5.5in ketika slot bawah kosong
    (`data-has-bottom="false"`) -- sebelumnya meluber ke area panel kosong
    pada PDF produksi, sekarang dibuktikan 0 piksel non-putih di area
    kosong lewat rasterisasi PDF nyata;
    (2) kapasitas panel diukur ULANG dengan fixture WORST-CASE (nama
    produk/jenis produk/alamat ~80-120 karakter, bukan fixture pendek) --
    angka lama (18, bahkan 21) TERBUKTI TIDAK AMAN, turun menjadi
    **10 baris** (margin aman >0.3in di bawah worst-case terukur);
    (3) MAX_DOCUMENT_LINE_ITEMS (`source-validation.ts`) DISATUKAN dengan
    MAX_ITEM_ROWS_PER_PANEL (`print-capacity.ts`) -- SATU batas 10 dipakai
    di issuance maupun print, gap "issued tapi gagal cetak" (bagian 19-30)
    tertutup. Label proof "Panel Atas/Bawah" dikonfirmasi HANYA tampil pada
    screen (`@media print` memaksa disembunyikan) -- laporan gate
    sebelumnya yang menyatakan label tersebut terlihat pada PDF Proof C
    adalah KELIRU, dikoreksi di laporan corrective pass.
-   Revisi 23 Juli 2026 (Founder, LOCKED, "AODP WALUYO -- CONTINUATION PANEL
    PRINT GATE", corrective pass kedua -- lihat
    `lib/document-engine/print-pagination.ts`,
    `lib/document-engine/print-batch.ts`, `PrintDocumentPanel.tsx`,
    `print.css`, `source-validation.ts`): **OPSI A -- CONTINUATION PANEL**
    disetujui dan LOCKED. Penyatuan MAX_DOCUMENT_LINE_ITEMS=10 pada
    corrective pass sebelumnya DIBATALKAN sebagai aturan bisnis final --
    batas domain dipulihkan ke **30** (TERPISAH dari kapasitas panel,
    tetap 10). Transaksi >10 baris TIDAK LAGI ditolak -- dilanjutkan ke
    continuation panel berurutan (`paginatePrintDocument`); HANYA panel
    final punya total & tanda tangan. `assertPanelCapacity`/
    `PanelCapacityExceededError` DIHAPUS dari `print-capacity.ts` (sudah
    tidak dipakai untuk menolak). Ilustrasi perforasi DIHAPUS TOTAL
    (sebelumnya hanya dibatasi arealnya) dari production print, termasuk
    `print-color-adjust`/`-webkit-print-color-adjust` yang sebelumnya
    ditambahkan untuk mempertahankan pola tersebut.
