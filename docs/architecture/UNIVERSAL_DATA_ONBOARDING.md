# Universal Data Onboarding — Architecture Decision Record

Status: **Accepted** (2026-08-02)

## Konteks

AODP butuh cara mengimpor data lama (CSV/XLSX) dari sistem tenant sebelumnya
(Excel manual, Accurate, SIMS, dll) ke 5 domain MVP: `CUSTOMER_PIC`,
`PRODUCT_PRICE`, `OPEN_AR`, `OPEN_ORDER`, `HISTORICAL_ORDER`. Kebutuhan ini
BUKAN spesifik untuk satu tenant (Toko Pak Waluyo) atau satu produk (AODP) --
platform AI Operating lain di masa depan akan butuh pola yang sama: file
sumber -> validasi keamanan -> mapping kolom -> staging -> preview -> commit
tervalidasi -> rollback aman.

Karena itu, arsitektur ini SENGAJA dipisah dua lapis, dengan dependency
**satu arah**:

```
AODP Domain Adapter (lib/imports/*)  --->  Universal Data Onboarding Core (lib/data-onboarding/core/*)
```

Core **tidak pernah** mengimpor dari `lib/imports/*` atau menyebut nama tabel
schema AODP (`customers`, `customer_pics`, `sales_orders`,
`import_batches`, `legacy_ar_invoices`, `products`). Ini ditegakkan lewat
contract test structural (`core/adapter-boundary.test.ts`) yang men-scan
seluruh source file di bawah `lib/data-onboarding/core/` untuk kedua
pelanggaran tersebut -- bukan cuma didokumentasikan, tapi diuji otomatis.

## Lapisan

### A. Universal Core -- `apps/web/src/lib/data-onboarding/core/`

Generik, tidak tahu domain/tenant apa pun. Berisi:

| File | Tanggung jawab |
|---|---|
| `types.ts` | `FieldDefinition`, `ColumnMapping`, `ParsedWorkbook`, `RowValidationResult`, `MappingProfile`, `ImportDomainAdapter` contract types, dll. |
| `security.ts` | Ekstensi/ukuran/magic-byte/limit row-sheet-cell, neutralisasi formula injection CSV, marker formula XLSX. |
| `parsing/csv.ts`, `parsing/xlsx.ts`, `parsing/index.ts` | Parsing CSV+XLSX jadi `ParsedWorkbook` yang bentuknya identik untuk kedua format. |
| `mapping.ts` | `suggestColumnMapping` (alias-matching) + `validateMappingCompleteness`, generik atas `FieldDefinition[]`. |
| `normalize.ts` | Primitif normalisasi (tanggal/nominal ID, boolean, slug) -- bukan validasi domain. |
| `templates.ts` | Generate template CSV/XLSX dari `FieldDefinition[]`, metadata versi template. |
| `adapter.ts` | Kontrak `ImportDomainAdapter<TValidateContext, TCommitResult, TRollbackResult>`. |

### B. AODP Domain Adapter -- `apps/web/src/lib/imports/`

Implementasi konkret untuk AODP: `DOMAIN_FIELDS` per `ImportType`, aturan
duplikat AODP-specific (`dedupe.ts`), lookup schema AODP (`repository.ts`),
reconciliation AR (`reconciliation.ts`), orkestrasi batch (`service.ts`),
commit/rollback ke Postgres RPC (`commit_import_batch`/
`rollback_import_batch`), dan sekarang juga **saved mapping profile**
(`mapping-profiles.ts`).

Adapter ini **boleh** mengimpor dari core (satu arah), dan memang begitu:
`security.ts`, `mapping.ts`, `normalize.ts`, `templates.ts` di `lib/imports/`
sekarang jadi thin wrapper yang mendelegasikan ke core, hanya menjembatani
`ImportType` AODP -> `FieldDefinition[]` generik core.

### C. Tenant Mapping Profile -- `import_mapping_profiles`

Lapisan tambahan (addendum "SAVED IMPORT PROFILE"): tenant menyimpan mapping
kolom yang sudah dipetakan, di-key oleh `(company_id, import_type,
source_system, profile_name)`. Kontrak generiknya (`MappingProfile`,
`MappingProfileStore`) ada di core (`core/types.ts`) supaya adapter non-AODP
bisa memakai pola yang sama tanpa reimplementasi -- tapi **implementasi**
konkretnya (`SupabaseMappingProfileStore`, tabel Postgres) tetap di adapter
AODP, karena core tidak boleh menyentuh Supabase/Postgres. Versioning:
menyimpan ulang profil dengan nama+domain+source_system yang sama menaikkan
kolom `version` (UPDATE, bukan baris baru) -- riwayat versi tidak disimpan
penuh (out of scope MVP), tapi struktur ini tidak mengunci ke satu versi
mapping selamanya karena admin selalu bisa timpa ulang atau memilih "-- pilih
profil --" untuk mapping manual dari nol.

### D. Import Batch -- `import_batches` / `import_batch_rows`

Staging lifecycle (dibangun di gate sebelumnya, LANGKAH 2-4): satu file =
satu batch, baris di-staging sebagai JSONB sebelum commit, status flow
`UPLOADED -> MAPPED -> VALIDATED -> READY_TO_COMMIT -> COMMITTED|FAILED|ROLLED_BACK`.

## Kenapa TIDAK direfactor jadi package terpisah (`packages/data-onboarding-core`)

Sesuai arahan eksplisit ("jangan refactor besar hanya demi nama folder"),
boundary ditegakkan dengan cara yang PALING MURAH: folder terpisah di dalam
`apps/web/src/lib/`, bukan workspace package pnpm baru. Yang wajib (dan
sudah ada) adalah:

1. **Boundary fisik** -- direktori terpisah (`core/` vs `imports/`).
2. **Dependency direction** -- diverifikasi lewat static import scan test.
3. **Contract test** -- `core/adapter-boundary.test.ts` membuktikan adapter
   FIKTIF (non-AODP, domain `INVENTORY_SNAPSHOT`) bisa memakai core end-to-end
   (canonical columns, suggest mapping, parsing CSV, validasi baris) tanpa
   satu pun impor dari `lib/imports/*`.

**Jalur ekstraksi ke package nyata** (kalau/ketika dibutuhkan produk AI
Operating lain di luar monorepo ini): pindahkan isi `lib/data-onboarding/core/`
apa adanya ke `packages/data-onboarding-core/src/`, update alias impor dari
`@/lib/data-onboarding/core/*` ke `@flowsales/data-onboarding-core`, tambahkan
`package.json` + `tsconfig` mengikuti pola `packages/types`/`packages/shared`
yang sudah ada di monorepo ini. Tidak ada perubahan LOGIKA yang dibutuhkan --
murni pemindahan file, karena boundary-nya sudah bersih sejak awal.

## Old vs New Import Module Coexistence (audit)

Audit ditrigger oleh temuan sidebar menampilkan DUA menu "Import Data" yang
membingungkan (URGENT fix, 2026-08-02). Ringkasan status final:

| Aspek | Modul lama (`import_templates`/`import_jobs`) | Modul baru (`import_batches`/`import_batch_rows`, kanonis) |
|---|---|---|
| Route | `/dashboard/settings/import/*` | `/dashboard/imports/*` |
| Sidebar | **Tidak ada entri** (dihapus, LANGKAH sidebar reconciliation) | Satu entri: "Import Data" -> `/dashboard/imports`, permission `imports.view` |
| Permission | `settings.view` (CRUD template) | `imports.view/execute/commit/rollback` (permission set terpisah, tidak overlap) |
| Buat batch BARU untuk data live | **DIBLOKIR** -- `executeImportAction` langsung `throw` dengan pesan arahan ke `/dashboard/imports`, sebelum baris `import_jobs` mana pun ditulis | Ya, jalur satu-satunya |
| Baca riwayat lama | Tetap berfungsi (`getImportJobsAction`, halaman `/jobs`) -- read-only, tidak disentuh | N/A (riwayat baru ada di `/dashboard/imports/[id]`) |
| Tabel/data lama | **Tidak dihapus** -- `import_templates`/`import_jobs` tetap ada, tidak ada migration destructive | Skema terpisah sepenuhnya |
| UI saat dibuka | Banner deprecation ambar di 6 halaman (`settings/import/*`) mengarahkan ke `/dashboard/imports` | N/A |
| Halaman Pengaturan | Link "Template Import (Lama)" tetap ada (baca-riwayat/CRUD template lama), deskripsi eksplisit mengarahkan ke menu baru untuk import data baru | Link "Import Data" di sidebar utama |

**Kesimpulan audit**: tidak ada route collision (path berbeda total), tidak
ada permission overlap yang memberi akses ekstra (grant `imports.*` terpisah
dari `settings.view`, dikonfirmasi lewat `20260707000001_seed_system_role_permissions.sql`
dan `20260801000001_legacy_import_foundation.sql`), tidak ada dua sumber
kebenaran untuk batch yang sama (modul lama tidak bisa lagi menulis batch
baru sama sekali). Modul baru adalah **Legacy Data Onboarding kanonis**;
modul lama dipertahankan hidup HANYA untuk baca riwayat/template lama,
ditandai deprecated di UI, tidak dihapus datanya.

## Test yang menegakkan dokumen ini

- `core/adapter-boundary.test.ts` -- core tidak pernah impor `@/lib/imports`
  atau menyebut nama tabel AODP; adapter fiktif non-AODP jalan lewat core.
- `imports/adapter-boundary.test.ts` -- dua domain AODP berbeda memakai mesin
  batch yang sama; mapping domain yang salah ditolak.
- `imports/mapping-profiles.test.ts` -- isolasi tenant + versioning profil.
- `data-onboarding/core/templates.test.ts` + `imports/templates.test.ts` --
  kompatibilitas versi template + round-trip semua 5 domain.
- `components/layout/sidebar.test.ts` + `lib/settings/import-execution.test.ts`
  -- satu menu Import Data, modul lama diblokir membuat batch baru.
