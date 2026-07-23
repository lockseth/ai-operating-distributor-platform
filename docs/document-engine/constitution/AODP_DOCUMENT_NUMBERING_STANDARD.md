# AODP DOCUMENT NUMBERING STANDARD

## Rules

-   Tenant scoped
-   Unique
-   Immutable
-   No duplicate numbers
-   Preview does not allocate a new number
-   Refresh does not allocate a new number

## Format (as implemented, `allocate_document_number()`)

`{TENANT_PREFIX}-{DOC_TYPE}-YYYYMMDD-000001`

-   `TENANT_PREFIX` -- kode tenant terstruktur dari
    `companies.document_number_prefix` (mis. `SWAS` untuk PT Sumber Warna
    Alam Sudiada/Pak Waluyo). Berasal dari konfigurasi/kontrak tenant,
    TIDAK PERNAH hardcoded di renderer/allocator. Wajib diisi sebelum
    tenant dapat menerbitkan dokumen apa pun.
-   `DOC_TYPE` -- `PO` (Purchase Order), `SJ` (Surat Jalan/Delivery Note),
    `INV` (Invoice). Contoh: `SWAS-PO-20260812-000001`,
    `SWAS-SJ-20260811-000001`, `SWAS-INV-20260812-000001`.
-   Faktur Pajak (`FP`) dan Receipt belum diimplementasikan pada MVP --
    lihat `AODP_DOCUMENT_ENGINE_ARCHITECTURE.md` (Future Ready), bukan
    bagian dari format yang berlaku saat ini.

## Audit

Every issued number must be traceable with timestamp and user.

## Revision History

-   Revisi 23 Juli 2026: format "Suggested Format" lama (`PO-`, `INV-`,
    `DO-`, `FP-` tanpa prefix tenant) digantikan format nyata yang
    diimplementasikan `allocate_document_number()` -- prefix tenant wajib,
    `DO` diganti `SJ` (Surat Jalan, istilah yang benar-benar dipakai di
    migration/kode). `FP` ditandai belum diimplementasikan.
