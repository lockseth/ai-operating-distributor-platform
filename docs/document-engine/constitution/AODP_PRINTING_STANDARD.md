# AODP PRINTING STANDARD

## Paper

-   Continuous Form
-   3 Ply (physical/carbon copy rangkap of the printer -- never 3 HTML
    panels, never 3 transactions)
-   Physical sheet: 9.5 × 11 inch (24 × 28 cm) per physical sheet
-   One physical sheet is divided into 2 horizontal panels, 9.5 × 5.5
    inch each. Not divided into 3. One panel is one print unit of a
    document -- a document that fits within one panel's capacity (10
    items) uses one panel; a longer document uses several CONTINUATION
    panels in sequence, still one transaction/number/version (LOCK "AODP
    WALUYO -- CONTINUATION PANEL PRINT GATE", superseding the prior
    absolute rule "one panel is always exactly one transaction, no
    document may span panels"). One panel never contains parts of two
    different transactions. See `AODP_DOCUMENT_LAYOUT_GUIDE.md` for the
    full continuation panel design.

## Printer

-   Dot Matrix
-   Tractor Feed

## Print Requirements

-   Dedicated print stylesheet, using physical CSS units (`in`), not
    A4 or pixel-only sizing
-   `@page` set to `size: 9.5in 11in`
-   No uncontrolled browser margin
-   Content of each panel stays within its 5.5in boundary; no
    unintended page break mid-transaction; the two panels of one sheet
    never overlap
-   Safe padding so text never sits too close to the printer edge
-   Safe tractor-feed margins
-   Monochrome friendly
-   No dashboard/sidebar/buttons
-   No perforation/sprocket-hole/decorative-dot illustration anywhere in
    production print (populated or empty panel) -- AUDIT FIX, corrective
    pass kedua. The physical paper already has real perforation; printing
    ink to simulate it is not required and was found leaking into empty
    panel areas.
-   Two panels per physical sheet maximum (top, bottom), each rendered
    once from a validated panel view model -- no content merged across
    panels. A sheet may hold two short transactions, two pages of one
    long (continuation) transaction, or the final page of one
    transaction plus the first page of the next. 3 Ply carbon copies are
    produced physically by the printer, not by the renderer. Empty slot
    (no next panel/document in queue): stays empty (no dummy document).

## Revision History

-   Revisi 19 Juli 2026: format bagi 3 digantikan format bagi 2;
    CATATAN dihapus; tanda tangan menjadi Salesman, Pengirim, dan
    Penerima.
-   Revisi 23 Juli 2026 (Founder): format bagi 2 panel/halaman
    SUPERSEDED sementara -- satu dokumen sempat memenuhi satu halaman
    penuh 9.5x11in ("4 Ply"). Footer benefit/service, badge Continuous
    Form, dan strip COPY 1-4 DIHAPUS dari layout cetak.
-   Revisi 23 Juli 2026 (Founder, LOCKED, keputusan final hari ini --
    lihat `AODP_DOCUMENT_LAYOUT_GUIDE.md` untuk detail lengkap dan
    kronologi): keputusan "satu halaman penuh = satu dokumen" di atas
    DIBATALKAN -- kembali ke format bagi 2 panel per lembar fisik
    9.5x11in, masing-masing panel 9.5x5.5in, SATU transaksi per panel.
    Terminologi dikoreksi dari "4 Ply" menjadi "3 Ply" (jumlah rangkap
    kertas karbon fisik yang benar). Footer benefit/service, badge
    Continuous Form, dan strip COPY 1-4 TETAP dihapus dari layout
    cetak.
-   Revisi 23 Juli 2026 (Founder, LOCKED, "AODP WALUYO -- CONTINUATION
    PANEL PRINT GATE", corrective pass kedua): OPSI A -- CONTINUATION
    PANEL disetujui. Aturan "satu panel selalu satu transaksi, dokumen
    tidak boleh melintasi panel" SUPERSEDED -- dokumen >10 baris item
    dilanjutkan ke continuation panel, bukan ditolak. Ilustrasi
    perforasi DIHAPUS TOTAL (sebelumnya hanya dibatasi arealnya) dari
    seluruh production print.
