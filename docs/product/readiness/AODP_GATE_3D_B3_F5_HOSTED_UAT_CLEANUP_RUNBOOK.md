# AODP — Gate 3D-B3-F5: Hosted UAT Cleanup Runbook

Runbook operator untuk membersihkan dua identitas UAT test dari project
Supabase hosted **`mcbwgvtkhykrrtvbpeys` (AODP-Waluyo-Demo)** setelah
verifikasi Gate 3D-B3-F4D PASS. Script ini disiapkan oleh Claude Code
sesuai otorisasi eksplisit Founder — **eksekusi dilakukan oleh operator
sendiri**, bukan oleh Claude Code (permanent data deletion di database
hosted berada di luar batas tindakan yang boleh dieksekusi otomatis).

Target dan dependency di bawah sudah diverifikasi read-only pada
Gate 3D-B3-F4D/F5 preflight (lihat percakapan sesi terkait). Script ini
TIDAK melakukan pencarian wildcard — semua filter memakai exact UUID.

## 0. Ringkasan target

| | Target 1 | Target 2 |
|---|---|---|
| UUID | `1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5` | `c7e7eff8-a4c8-44fa-95b8-db0cb697cb54` |
| Email | `cerbonan.ai+uatgate3db3f4b2@gmail.com` | `cerbonan.ai+uatgate3db3f4@gmail.com` |
| Company | `11fd49b7-561d-479f-a6b5-715263589118` (PT SUMBER WARNA ALAM SUDIADA) | tidak ada (orphan — belum pernah provisioning) |
| public.users | 1 baris | 0 baris |
| user_roles | 1 baris (owner) | 0 baris |
| audit_logs | 3 baris (1 `tenant.first_owner_provisioned` + 2 `logout`) | 0 baris |

**Protected — wajib tidak tersentuh** (baseline terverifikasi sebelum cleanup):

| Entity | ID | Baseline |
|---|---|---|
| Tenant demo | `2d49badc-5ebb-40f5-8467-73e1f36464c2` (PT. Sumber Warna Alam Sudiada — demo) | 1 company, 3 users |
| Isolation tenant | `3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2` (PT. Isolation Test Tenant (Synthetic)) | 1 company, 1 user |
| `owner.demo@waluyo.aodp.test` | — | aktif |
| `admin.demo@waluyo.aodp.test` | — | aktif |
| `sales.demo@waluyo.aodp.test` | — | aktif |

## 1. PUBLIC-SCHEMA SQL (jalankan di Supabase Studio → SQL Editor)

Satu transaksi. Blok `DO $$ ... $$` di bagian precondition akan
`RAISE EXCEPTION` — yang otomatis **ROLLBACK seluruh transaksi, tidak ada
yang ter-commit** — bila salah satu syarat gagal. `DELETE` di bagian
company memakai precondition assertion kedua sesaat sebelum eksekusi
sebagai jaring pengaman ganda. FK constraint ke `companies.id` dari tabel
lain (bila ada yang belum ter-cover script ini) juga akan otomatis
menggagalkan `DELETE FROM public.companies` dan meng-abort transaksi.

```sql
BEGIN;

-- ============================================================
-- PRECONDITION ASSERTIONS — abort seluruh transaksi bila gagal
-- ============================================================
DO $$
DECLARE
  v_target1_id      uuid := '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5';
  v_target1_email   text := 'cerbonan.ai+uatgate3db3f4b2@gmail.com';
  v_target1_company uuid := '11fd49b7-561d-479f-a6b5-715263589118';
  v_target2_id      uuid := 'c7e7eff8-a4c8-44fa-95b8-db0cb697cb54';
  v_protected       uuid[] := ARRAY[
    '2d49badc-5ebb-40f5-8467-73e1f36464c2'::uuid,  -- tenant demo
    '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2'::uuid   -- isolation tenant
  ];
  v_row   public.users%ROWTYPE;
  v_count int;
BEGIN
  -- (a) target1: identitas exact match
  SELECT * INTO v_row FROM public.users WHERE id = v_target1_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ABORT: target1 % tidak ditemukan di public.users', v_target1_id;
  END IF;
  IF v_row.email IS DISTINCT FROM v_target1_email THEN
    RAISE EXCEPTION 'ABORT: email target1 tidak cocok (found=%, expected=%)', v_row.email, v_target1_email;
  END IF;
  IF v_row.company_id IS DISTINCT FROM v_target1_company THEN
    RAISE EXCEPTION 'ABORT: company_id target1 tidak cocok (found=%, expected=%)', v_row.company_id, v_target1_company;
  END IF;

  -- (b) company target1 bukan protected tenant
  IF v_target1_company = ANY(v_protected) THEN
    RAISE EXCEPTION 'ABORT: company target1 termasuk protected tenant list';
  END IF;

  -- (c) company target1 HANYA berisi target1 (tidak ada user lain / bukan shared)
  SELECT count(*) INTO v_count FROM public.users WHERE company_id = v_target1_company;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ABORT: company target1 punya % user (expected exactly 1)', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.users WHERE company_id = v_target1_company AND id <> v_target1_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: company target1 punya user lain di luar scope';
  END IF;

  -- (d) user_roles company target1 HANYA milik target1 (single-owner, no foreign membership)
  SELECT count(*) INTO v_count FROM public.user_roles WHERE company_id = v_target1_company;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'ABORT: user_roles company target1 = % (expected exactly 1)', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM public.user_roles WHERE company_id = v_target1_company AND user_id <> v_target1_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: user_roles company target1 menunjuk user di luar scope';
  END IF;

  -- (e) target2 harus tetap orphan (tidak ada public.users/user_roles/audit_logs)
  --     — bila ternyata SUDAH ada relasi, itu berarti asumsi F4D basi, STOP.
  SELECT count(*) INTO v_count FROM public.users WHERE id = v_target2_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: target2 % ternyata punya public.users profile — bukan orphan seperti hasil preflight', v_target2_id;
  END IF;

  SELECT count(*) INTO v_count FROM public.user_roles WHERE user_id = v_target2_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: target2 % punya user_roles — di luar scope orphan', v_target2_id;
  END IF;

  SELECT count(*) INTO v_count FROM public.audit_logs WHERE user_id = v_target2_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: target2 % punya audit_logs — di luar scope orphan', v_target2_id;
  END IF;

  RAISE NOTICE 'PRECONDITION OK — lanjut cleanup public schema (target1=%, target2=% orphan/no-op)', v_target1_id, v_target2_id;
END $$;

-- ============================================================
-- CLEANUP — urutan FK-safe: audit_logs -> user_roles -> users -> companies
-- (hanya tereksekusi bila blok precondition di atas TIDAK RAISE EXCEPTION)
-- ============================================================

-- 1. audit_logs milik target1 (scoped user_id + company_id, bukan wildcard)
DELETE FROM public.audit_logs
 WHERE user_id = '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5'
   AND company_id = '11fd49b7-561d-479f-a6b5-715263589118';

-- 2. user_roles milik target1
DELETE FROM public.user_roles
 WHERE user_id = '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5'
   AND company_id = '11fd49b7-561d-479f-a6b5-715263589118';

-- 3. public.users profile target1
DELETE FROM public.users
 WHERE id = '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5';

-- target2: tidak ada baris public schema (sudah terkonfirmasi orphan) — no-op by design,
-- tidak ada DELETE yang dijalankan untuk target2 di public schema.

-- 4. company UAT target1 — assert ULANG tepat sebelum delete (double safety net),
--    hanya dihapus bila benar-benar sudah tidak ada user/role yang tersisa.
DO $$
DECLARE
  v_target1_company uuid := '11fd49b7-561d-479f-a6b5-715263589118';
  v_count int;
BEGIN
  SELECT count(*) INTO v_count FROM public.users WHERE company_id = v_target1_company;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: company target1 masih punya % user setelah cleanup — company TIDAK dihapus', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM public.user_roles WHERE company_id = v_target1_company;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'ABORT: company target1 masih punya % user_roles setelah cleanup — company TIDAK dihapus', v_count;
  END IF;

  DELETE FROM public.companies WHERE id = v_target1_company;
END $$;

COMMIT;
```

Jika Studio menampilkan error `ABORT: ...` — transaksi otomatis rollback,
**tidak ada perubahan tersimpan**. Baca pesan error, cocokkan dengan
precondition mana yang gagal, laporkan ke Claude Code sebelum mencoba lagi
— jangan mengubah script sendiri untuk "melewati" assertion.

## 2. AUTH CLEANUP (setelah langkah 1 sukses/COMMIT)

Supabase tidak mengizinkan penghapusan `auth.users` yang aman lewat SQL
biasa dari SQL Editor (butuh Auth Admin API agar sesi/identity/refresh
token ikut ter-cascade dengan benar). Pilih salah satu:

**Opsi A — Studio UI (direkomendasikan, paling aman untuk operator manual):**

1. Buka Supabase Studio project `mcbwgvtkhykrrtvbpeys` → **Authentication → Users**.
2. Cari **exact UUID** `1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5` → cocokkan email `cerbonan.ai+uatgate3db3f4b2@gmail.com` → **Delete user**.
3. Cari **exact UUID** `c7e7eff8-a4c8-44fa-95b8-db0cb697cb54` → cocokkan email `cerbonan.ai+uatgate3db3f4@gmail.com` → **Delete user**.

**Opsi B — script admin API, dijalankan operator sendiri** (tidak berisi
secret — ambil key dari environment yang sudah ada di `.env.demo.local`):

```js
// scripts/adhoc-gate-3d-b3-f5-auth-cleanup.mjs
// Jalankan manual oleh operator: node scripts/adhoc-gate-3d-b3-f5-auth-cleanup.mjs
// Membaca URL & service role key dari environment variable — TIDAK hardcode secret.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_DEMO_URL;
const serviceRoleKey = process.env.SUPABASE_DEMO_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("Set NEXT_PUBLIC_SUPABASE_DEMO_URL & SUPABASE_DEMO_SERVICE_ROLE_KEY di environment.");
}

const supabase = createClient(url, serviceRoleKey);

// EXACT UUID allowlist — jangan diganti jadi query wildcard/email search.
const TARGET_UUIDS = [
  "1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5",
  "c7e7eff8-a4c8-44fa-95b8-db0cb697cb54",
];

for (const id of TARGET_UUIDS) {
  const { data, error } = await supabase.auth.admin.deleteUser(id);
  console.log(id, error ? `ERROR: ${error.message}` : "deleted", data ?? "");
}
```

Jalankan dengan environment sudah di-load, contoh (PowerShell):

```powershell
$env:NEXT_PUBLIC_SUPABASE_DEMO_URL = (Select-String -Path .env.demo.local -Pattern 'NEXT_PUBLIC_SUPABASE_DEMO_URL=(.*)').Matches.Groups[1].Value
$env:SUPABASE_DEMO_SERVICE_ROLE_KEY = (Select-String -Path .env.demo.local -Pattern 'SUPABASE_DEMO_SERVICE_ROLE_KEY=(.*)').Matches.Groups[1].Value
node scripts/adhoc-gate-3d-b3-f5-auth-cleanup.mjs
```

File ini belum dibuat di repo — buat manual bila mau pakai Opsi B, atau
pakai Opsi A (Studio UI) yang tidak butuh file tambahan sama sekali.

## 3. EXECUTION ORDER

1. Jalankan SQL §1 di Supabase Studio SQL Editor pada project `mcbwgvtkhykrrtvbpeys`. Konfirmasi `COMMIT` sukses tanpa error.
2. Jalankan cleanup auth §2 (Opsi A atau B) untuk kedua UUID.
3. Jalankan verification query §4.
4. Bandingkan hasil dengan §5 (Expected Final Cardinality).
5. Laporkan hasil ke Claude Code untuk penutupan Gate 3D-B3-F5.

## 4. POST-CLEANUP VERIFICATION (read-only)

```sql
SELECT 'public.users target1' AS check_name, count(*) AS n
  FROM public.users WHERE id = '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5'
UNION ALL
SELECT 'public.user_roles target1', count(*)
  FROM public.user_roles WHERE user_id = '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5'
UNION ALL
SELECT 'public.audit_logs target1', count(*)
  FROM public.audit_logs WHERE user_id = '1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5'
UNION ALL
SELECT 'public.companies target1', count(*)
  FROM public.companies WHERE id = '11fd49b7-561d-479f-a6b5-715263589118'
UNION ALL
SELECT 'public.users target2', count(*)
  FROM public.users WHERE id = 'c7e7eff8-a4c8-44fa-95b8-db0cb697cb54'
UNION ALL
SELECT 'demo tenant companies', count(*)
  FROM public.companies WHERE id = '2d49badc-5ebb-40f5-8467-73e1f36464c2'
UNION ALL
SELECT 'demo tenant users', count(*)
  FROM public.users WHERE company_id = '2d49badc-5ebb-40f5-8467-73e1f36464c2'
UNION ALL
SELECT 'isolation tenant companies', count(*)
  FROM public.companies WHERE id = '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2'
UNION ALL
SELECT 'isolation tenant users', count(*)
  FROM public.users WHERE company_id = '3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2';
```

Untuk sisi `auth.users` (setelah §2 dijalankan), cek lewat Studio
**Authentication → Users** dengan exact UUID search — hasilnya harus
"not found" untuk kedua UUID. Alternatif read-only via Admin API (butuh
service role key dari environment, bukan hardcode):

```bash
curl -s "$NEXT_PUBLIC_SUPABASE_DEMO_URL/auth/v1/admin/users/1e25baa6-7b78-45c2-8114-b2e3a7fcc7c5" \
  -H "apikey: $SUPABASE_DEMO_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_DEMO_SERVICE_ROLE_KEY"
curl -s "$NEXT_PUBLIC_SUPABASE_DEMO_URL/auth/v1/admin/users/c7e7eff8-a4c8-44fa-95b8-db0cb697cb54" \
  -H "apikey: $SUPABASE_DEMO_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_DEMO_SERVICE_ROLE_KEY"
```

Keduanya diharapkan mengembalikan `{"code":"user_not_found", ...}` atau HTTP 404 setelah cleanup.

## 5. EXPECTED FINAL CARDINALITY

| Check | Sebelum | Sesudah (expected) |
|---|---|---|
| `public.users` target1 | 1 | **0** |
| `public.user_roles` target1 | 1 | **0** |
| `public.audit_logs` target1 | 3 | **0** |
| `public.companies` target1 | 1 | **0** |
| `public.users` target2 | 0 | 0 (tidak berubah) |
| `auth.users` target1 & target2 | ada | **tidak ditemukan (404 / not found)** |
| Tenant demo — companies | 1 | 1 (tidak berubah) |
| Tenant demo — users | 3 | 3 (tidak berubah) |
| Isolation tenant — companies | 1 | 1 (tidak berubah) |
| Isolation tenant — users | 1 | 1 (tidak berubah) |

Bila salah satu angka "Sesudah" tidak cocok dengan ekspektasi ini —
**STOP**, jangan lanjut menutup gate, laporkan penyimpangannya.
