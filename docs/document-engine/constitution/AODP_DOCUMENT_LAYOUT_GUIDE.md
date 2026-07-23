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

## Print Panel Layout (LOCKED -- revisi 23 Juli 2026, SUPERSEDE bagian 2-panel di bawah)

> **Bagian "2 panel per halaman" di bawah ini SUDAH SUPERSEDED.** Keputusan
> Founder 23 Juli 2026: Continuous Form 4 Ply berarti kertas rangkap FISIK/
> carbonless printer (4 lembar karbon tercetak bersamaan dalam satu print
> run) -- BUKAN duplikasi konten oleh renderer. Aturan aktif sekarang:

-   Physical page: Continuous Form 4 Ply, 9.5 x 11 inch.
-   **SATU transaksi (SATU dokumen) memenuhi SATU halaman penuh 9.5 x 11
    inch.** Renderer TIDAK membuat 2 (atau berapa pun) salinan/panel HTML
    dari satu snapshot -- 4 Ply adalah rangkap kertas fisik di printer, sudah
    identik dengan sendirinya lewat karbon, bukan sesuatu yang perlu
    direplikasi di markup.
-   Struktur visual mengikuti template Pak Waluyo (source of truth visual,
    lihat laporan gate Document Engine 23 Juli 2026): perforasi kiri/kanan,
    header logo + identitas + garis hijau/oranye, panel metadata dokumen
    (No. Dokumen/Tanggal/Tempo/Salesman -- **SATU-SATUNYA** tempat tempo
    pembayaran ditampilkan), panel DATA TOKO/CUSTOMER full-width dua kolom
    internal (kiri: Kode Toko/Nama Toko/Alamat; kanan: No. Telp/Ref. Order/
    Ref. Delivery/Salesman), tabel produk header hijau, panel tanda tangan,
    ringkasan total, footer benefit/service, badge "Continuous Form 4 Ply" +
    strip informasi COPY 1-4 (statis, bukan data tenant).
-   **LOCKED (Founder, 23 Juli 2026, revisi kedua hari yang sama):** panel
    KETENTUAN PEMBAYARAN terpisah DIHAPUS -- redundan dengan baris Tempo di
    panel metadata header. Ruang yang dibebaskan dipakai memperluas panel
    DATA TOKO/CUSTOMER menjadi full-width dua kolom internal (lihat di
    atas). Jangan menampilkan tempo pembayaran di lebih dari satu tempat.
-   Bank/No. Rekening/Metode Pembayaran TIDAK ditampilkan -- belum ada
    canonical source di skema (bukan dikarang). Termin pembayaran WAJIB ada
    (payment_terms_days, ditegakkan PAYMENT_TERMS_INCOMPLETE saat issuance).

~~One physical page is divided into 2 horizontal panels, 9.5 x 5.5 inch
each. Not divided into 3. 4 Ply is the physical/carbon copy rangkap of the
printer -- there are only 2 HTML panels per page, never 4. Both panels are
rendered from the same document snapshot; document number, items, and
totals are always identical on both panels.~~ *(LOCK 19 Juli 2026 --
superseded 23 Juli 2026, lihat di atas)*

## Footer

Signatures, left to right: **SALESMAN, PENGIRIM, DITERIMA OLEH** (revisi 23
Juli 2026, mengikuti wording template Pak Waluyo -- sebelumnya "Penerima").
Salesman and Pengirim may be the same person, but both signature areas
remain separate and are always shown. No "CATATAN" section and no empty
notes area.

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
