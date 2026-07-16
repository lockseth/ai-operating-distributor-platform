# Demo Access & Tenant Branding Gate

## Scope

Gate ini menyediakan lingkungan presentasi lokal untuk tenant design partner
Waluyo tanpa mencampurkan sesi atau data Supabase pilot/production.

## Safety contract

- Demo hanya aktif jika `NODE_ENV === "development"` dan
  `NEXT_PUBLIC_DEMO_MODE === "true"` secara bersamaan.
- Server Action masuk demo memeriksa ulang kontrak tersebut; tombol UI bukan
  kontrol keamanan.
- Sesi demo memakai cookie `httpOnly`, `sameSite=lax`, berumur maksimum delapan
  jam, dan tidak pernah memberi akses ke data production.
- Preview, pilot, dan production harus menetapkan `NEXT_PUBLIC_DEMO_MODE=false`.
- Banner `DEMO MODE` dan label `DATA SIMULASI` selalu terlihat selama demo.

## Tenant demo

- Nama legal: **PT. Sumber Warna Alam Sudiada**
- Nama brand: **Waluyo Distributor**
- Role: **Owner**
- Data dashboard: data simulasi, bukan data operasional.

Tenant production menggunakan `companies.logo_url` serta
`companies.settings.display_name` dan `companies.settings.brand_color`.
Nilai branding dinormalisasi di server sebelum disimpan atau ditampilkan.

## Menjalankan lokal

1. Salin `.env.example` menjadi `.env.local`.
2. Isi konfigurasi Supabase bila ingin menguji login nyata.
3. Set `NEXT_PUBLIC_DEMO_MODE=true`.
4. Jalankan `pnpm dev`, buka `/login`, lalu pilih **Masuk Demo Waluyo**.

## Verification

```bash
pnpm test
pnpm type-check
pnpm lint
pnpm build
```
