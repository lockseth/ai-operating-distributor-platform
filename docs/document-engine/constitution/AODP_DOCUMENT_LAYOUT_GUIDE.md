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

## Print Panel Layout (LOCKED)

-   Physical page: Continuous Form 4 Ply, 9.5 x 11 inch.
-   One physical page is divided into 2 horizontal panels, 9.5 x 5.5
    inch each. Not divided into 3.
-   4 Ply is the physical/carbon copy rangkap of the printer -- there
    are only 2 HTML panels per page, never 4.
-   Both panels are rendered from the same document snapshot; document
    number, items, and totals are always identical on both panels.

## Footer

Signatures, left to right: Salesman, Pengirim, Penerima. Salesman and
Pengirim may be the same person, but both signature areas remain
separate and are always shown. No "CATATAN" section and no empty notes
area.

## Revision History

-   Revisi 19 Juli 2026: format bagi 3 digantikan format bagi 2;
    CATATAN dihapus; tanda tangan menjadi Salesman, Pengirim, dan
    Penerima.
