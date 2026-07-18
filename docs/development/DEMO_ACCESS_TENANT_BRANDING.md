# Demo Access & Tenant Branding

**Status: IMPLEMENTED — LOCALLY AND REMOTE-AUTH VERIFIED**
**NOT YET DEPLOYED**

## Scope

Gate ini menyediakan akses Demo yang stabil (login Supabase Auth nyata,
bukan bypass) ke Supabase project `AODP-Waluyo-Demo` (ref
`mcbwgvtkhykrrtvbpeys`), beserta tenant branding untuk
**PT. Sumber Warna Alam Sudiada** di login page dan shell setelah login.

Tidak termasuk: Telegram Salesman Enrollment, KTP OCR, selfie/liveness, KPI,
target, coverage wilayah, Tambah Toko/PIC, Delivery Verification, perubahan
Dispatch, WhatsApp, atau deployment.

## Dua mekanisme yang TIDAK BOLEH tertukar

1. **Development demo bypass** (`apps/web/src/lib/demo/config.ts`,
   `apps/web/src/lib/actions/demo.ts`) — tombol "🧪 Masuk Demo (Development
   Only)" di halaman login. Gate satu-satunya: `NODE_ENV === "development"`
   (strict equality, fail-closed — lihat `config.test.ts`). Tidak pernah
   memanggil Supabase Auth, hanya menandai cookie lokal. **Tidak diperluas ke
   environment Demo/staging** oleh gate ini.
2. **Demo Access (gate ini)** — login email/password Supabase Auth **nyata**
   terhadap project `AODP-Waluyo-Demo`, untuk dua akun tetap:
   - Owner: `owner.demo@waluyo.aodp.test`
   - Sales: `sales.demo@waluyo.aodp.test` (fixture uji RLS role sales —
     **bukan** hasil Telegram Salesman Enrollment; tidak punya status
     biometric/identity verified; tidak dinyatakan siap operasional. Model
     active/inactive salesman formal belum ada di schema — didokumentasikan
     sebagai limitation, bukan dibangun di gate ini.)

## Tenant Demo

- Nama legal (persis, dari `companies.name`): **PT. Sumber Warna Alam Sudiada**
- Environment marker: `companies.settings.environment = "DEMO"`
- Coverage area awal (informational, `companies.settings.coverage_areas`):
  Cirebon Timur, Cirebon Kota, Cirebon Barat

## Branding — sumber data nyata

Branding **hanya** berasal dari kolom yang benar-benar ada:

- `companies.name`
- `companies.logo_url`
- `companies.settings.brand_color` (divalidasi format hex sebelum dipakai
  sebagai CSS value — fallback `#2563EB` jika tidak valid)
- `companies.settings.environment` (badge "DEMO ENVIRONMENT" hanya muncul
  jika persis `"DEMO"`)

`companies.settings.display_name` **tidak ada** — jangan gunakan.

Resolusi aman ada di `apps/web/src/lib/branding/service.ts`
(`resolveCompanyBranding`) — logo URL divalidasi harus `http(s)://` sebelum
dipakai sebagai `src`, brand color divalidasi regex hex sebelum dipakai
sebagai `style.backgroundColor`. Dipakai oleh `components/layout/sidebar.tsx`
dan `components/layout/header.tsx` melalui `AuthUser.company.settings` (query
`getAuthUser()` sekarang men-select kolom `settings`, sebelumnya tidak —
lihat catatan bug di bawah).

Branding **selalu** dari company milik authenticated user (`getAuthUser()` →
`profile.company_id`) — tenant lain tetap menampilkan brandingnya sendiri,
tidak pernah tertimpa data Waluyo (dibuktikan di
`apps/web/src/lib/branding/service.test.ts`).

### Bug yang diperbaiki gate ini

Sebelum gate ini, `sidebar.tsx` sudah mencoba membaca
`user.company.settings.brand_color` lewat unsafe cast, tapi query
`getAuthUser()` **tidak pernah men-select kolom `settings`** — sehingga
brand color tenant asli tidak pernah benar-benar terbaca, selalu fallback
diam-diam. Ini sudah diperbaiki (`get-user.ts` sekarang select `settings`,
`AuthUser.company.settings` bertipe eksplisit).

## Login page branding (Demo)

Sebelum login belum ada authenticated tenant, jadi branding login page
untuk Demo berasal dari environment variable **public** yang tervalidasi
server-side (`apps/web/src/lib/branding/login-branding.ts`), BUKAN query
database tanpa autentikasi dan BUKAN parameter client:

```
NEXT_PUBLIC_APP_ENV=demo
NEXT_PUBLIC_DEMO_COMPANY_NAME=PT. Sumber Warna Alam Sudiada
```

Badge "DEMO ENVIRONMENT" dan nama tenant di login page HANYA tampil ketika
`NEXT_PUBLIC_APP_ENV === "demo"` persis. Kosongkan/biarkan tidak diset untuk
preview/pilot/production. "Powered by AODP" selalu tampil di footer login,
terlepas dari environment.

## UI setelah login

`components/layout/header.tsx` menampilkan sapaan berbasis role (di slot
title yang sebelumnya selalu kosong dari `dashboard/layout.tsx`):

- Owner: "Selamat Datang, Owner" + nama company
- Sales: "Selamat Datang di AI Operating Distributor Platform (AODP)" + nama
  company

Badge "DEMO ENVIRONMENT" (ungu) tampil di header/sidebar ketika
`settings.environment === "DEMO"` — berbeda dan independen dari badge
"🧪 Demo Mode" (amber, development bypass session). `components/layout/
sidebar.tsx` menampilkan logo (jika `logo_url` valid) atau inisial nama,
brand color tervalidasi, dan footer "Powered by AODP".

## Password Demo — stabil, tidak dirotasi

Akun Owner/Sales Demo memakai kunci environment kanonik di
`.env.demo.local` (root repo, gitignored, **tidak pernah** masuk Git):

```
AODP_DEMO_OWNER_EMAIL
AODP_DEMO_OWNER_PASSWORD
AODP_DEMO_SALES_EMAIL
AODP_DEMO_SALES_PASSWORD
```

- `scripts/seed-demo.ts` — idempotent. Akun belum ada → dibuat, password
  ditulis sekali. Akun sudah ada → password **tidak pernah** diubah/dirotasi.
  Kunci lama per-email (`DEMO_OWNER_PASSWORD_<EMAIL>`, dipakai sebelum
  konvensi ini) otomatis dimigrasi (carry-forward, nilai tidak berubah) ke
  kunci kanonik di atas jika ditemukan.
- `scripts/reset-demo-access.ts` — **satu-satunya** cara mengganti password,
  dan harus dipanggil eksplisit:
  ```
  pnpm reset:demo-access -- --account=owner
  pnpm reset:demo-access -- --account=sales
  ```
  Operator mengisi password baru di `AODP_DEMO_OWNER_PASSWORD_NEW` /
  `AODP_DEMO_SALES_PASSWORD_NEW` terlebih dahulu — script **tidak pernah**
  generate password sendiri. Fail-closed jika: target project bukan ref
  `mcbwgvtkhykrrtvbpeys`, email di luar allowlist Demo, atau kunci `*_NEW`
  kosong. Tidak membuat akun baru (hanya reset akun existing), tidak
  mereset akun lain, tidak pernah mencetak nilai password, tidak berjalan
  otomatis dari seed, dan tidak membuat endpoint HTTP publik apa pun (murni
  CLI/admin server-side). Aturan murni (project ref, allowlist email, guard
  password kosong) diekstrak ke
  `apps/web/src/lib/demo-access/reset-rules.ts` supaya bisa diuji vitest.

## Menjalankan lokal

1. `.env.local` (root & `apps/web/`) tetap menunjuk Supabase **lokal**
   (`http://127.0.0.1:54321`) — TIDAK diubah oleh gate ini, dev sehari-hari
   tidak terpengaruh.
2. Untuk demo bypass development-only: `pnpm dev`, buka `/login`, klik
   "🧪 Masuk Demo (Development Only)" (hanya aktif `NODE_ENV=development`).
3. Untuk menguji branding login page Demo secara visual tanpa mengubah
   `.env.local`: jalankan dev server dengan env tambahan di proses (bukan di
   file), mis. `NEXT_PUBLIC_APP_ENV=demo NEXT_PUBLIC_DEMO_COMPANY_NAME="PT.
   Sumber Warna Alam Sudiada" pnpm --filter @flowsales/web dev`.
4. Untuk login sungguhan ke Supabase Demo, arahkan
   `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` proses (bukan
   `.env.local`) ke project Demo, atau gunakan script verifikasi di bawah.

## Verifikasi live (remote AODP-Waluyo-Demo)

```
pnpm seed:demo          # idempotent, tidak merotasi password
pnpm verify:demo-rls    # tenant isolation (8 skenario)
pnpm verify:demo-auth   # login/session/logout/reset/branding (17 skenario)
```

## Recovery procedure

Jika password Demo hilang/lupa: **jangan** membuat akun baru. Jalankan
`scripts/reset-demo-access.ts` sesuai prosedur di atas. Jika `.env.demo.local`
hilang seluruhnya: buat ulang filenya dengan `SUPABASE_DEMO_DB_PASSWORD`,
`NEXT_PUBLIC_SUPABASE_DEMO_URL`, `SUPABASE_DEMO_SERVICE_ROLE_KEY` (lihat
riwayat gate Demo Environment Foundation), lalu jalankan `pnpm seed:demo` —
akun Auth existing akan dikenali (bukan dibuat ulang) tapi password LAMA
tidak bisa dipulihkan tanpa reset eksplisit karena Supabase Auth menyimpan
password sebagai hash.

## Batas development demo bypass

`isDemoModeAllowed()` tetap **hanya** `NODE_ENV === "development"`. Gate ini
tidak menambah allowlist environment baru, tidak melonggarkan middleware
(`lib/supabase/middleware.ts`), dan tidak membuat jalur bypass baru yang bisa
dipicu dari client/request.

### Demo bypass TIDAK BISA melakukan DB write apa pun (berlaku untuk SEMUA modul)

Dikonfirmasi ulang lewat audit reconciliation (2026-07-18): `DEMO_AUTH_USER`
di `lib/auth/get-user.ts` memakai `id`/`company_id` sintetis
(`00000000-0000-0000-0000-000000000000`) yang **sengaja tidak punya baris
`companies`/`users`/`auth.users` penyokong** -- sesuai komentar aslinya
("tidak pernah memanggil Supabase Auth, hanya menandai cookie lokal").
Konsekuensinya: **operasi tulis DB apa pun** yang dijalankan di bawah sesi
demo bypass akan gagal foreign-key constraint saat itu juga (dibuktikan
lewat percobaan upload Import Data di bawah sesi demo -- error
`import_batches_company_id_fkey`). Ini **bukan bug modul tertentu** --
perilaku yang sama akan terjadi untuk modul MANA PUN yang menulis ke
Postgres (buat customer, order, dsb) di bawah sesi demo bypass, karena
akar masalahnya ada di identity sintetis tersebut, bukan di modul yang
mencoba menulis.

Konsekuensi praktis: **browser click-through untuk write-path** (upload →
validate → commit → rollback, atau modul tulis lain manapun) **harus**
memakai akun lokal nyata (login email/password Supabase Auth sungguhan
terhadap Supabase lokal, atau Demo Access asli seperti didokumentasikan di
atas) -- bukan tombol "🧪 Masuk Demo". Demo bypass tetap valid untuk
verifikasi UI/rendering READ-ONLY (dashboard, daftar kosong, badge status,
dsb).

**Diketahui juga**: login otomatis lewat magic-link (Supabase Admin API
`generateLink`, tanpa pernah menangani password) TIDAK berhasil membentuk
sesi persisten pada codebase ini -- `createBrowserClient` (`@supabase/ssr`)
yang dipakai `lib/supabase/client.ts` tidak mengonsumsi token hash-fragment
implicit-flow secara otomatis, dan `login-form.tsx` hanya membuat instance
client di dalam handler submit (bukan eager on-mount), sehingga tidak ada
titik masuk otomatis untuk sesi hasil magic-link. Ini murni keterbatasan
teknis yang ditemukan, BUKAN sesuatu yang diperbaiki di gate mana pun sejauh
ini -- diperlukan login manual sungguhan (email/password) oleh Founder untuk
verifikasi browser write-path.

**Backlog terpisah (belum dikerjakan)**: **Interactive Demo Authentication**
-- kebutuhan untuk sesi demo yang bisa benar-benar menulis ke DB (mis. lewat
tenant Demo sungguhan yang di-seed penuh, atau mekanisme login otomatis yang
sah tanpa password manual) supaya QA/browser click-through write-path bisa
dilakukan tanpa bergantung pada kredensial manual Founder. Jangan klaim Demo
Mode mendukung workflow tulis sampai backlog ini benar-benar dikerjakan dan
diverifikasi.

## Belum deployed

Belum ada deployment aplikasi ke environment Demo/staging manapun. Semua
verifikasi di gate ini adalah: (a) unit test lokal, (b) live integration test
terhadap Supabase Auth/DB Demo lewat script Node langsung, dan (c) satu sesi
browser lokal (development demo bypass) untuk membuktikan komponen
Sidebar/Header baru render tanpa error. Rendering browser sungguhan untuk
sesi Supabase Auth Demo yang asli (bukan dev bypass) **belum** diverifikasi
secara visual — dibatasi oleh dev server lokal yang sudah berjalan di port
3000 dengan env lain (lihat laporan gate untuk detail).

## Verification (quality gate)

```bash
pnpm test
pnpm type-check
pnpm lint
pnpm build
```
