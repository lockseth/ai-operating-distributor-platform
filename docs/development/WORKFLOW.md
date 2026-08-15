# Alur Kerja AODP — dari Ide sampai Selesai

Dibuat 2026-08-15 sebagai respons atas masalah "pengerjaan lompat-lompat dan
bolong-bolong". Ini alur yang **seharusnya** diikuti untuk setiap item kerja
— request Founder, temuan CTO saat audit, maupun bug report — sebelum ada
satu baris kode pun ditulis.

Bukan proses berat ala tim besar. Tim ini Founder + Claude Code sebagai
CTO+Programmer — alurnya sengaja tipis, tapi tetap harus dilewati supaya
tidak ada kerja yang mulai tanpa jejak dan tidak ada temuan yang hilang.

---

## Kenapa alur ini dibuat

Audit `TRACKER.md` (2026-08-15) menemukan pola konkret di balik keluhan
Founder:

1. Tracker cuma punya log **retrospektif** (apa yang sudah selesai) — tidak
   ada tempat yang menjawab "apa yang sedang/akan dikerjakan". Kerja jadi
   mulai dari pesan ad-hoc, bukan dari antrian yang terlihat.
2. Beberapa temuan besar (WIP `forgot-password-form.tsx` yang migration-nya
   hilang, gap target KPI Salma, dsb.) ditemukan **tidak sengaja** saat
   mengerjakan hal lain, bukan dari pengecekan terjadwal.
3. Skema ID Gate (`3E-D6-B-H-R1`, dst.) sudah terlalu dalam untuk dilacak.
4. Dokumen gate kadang tidak ke-commit ke git (untracked), padahal dianggap
   "sumber kebenaran".
5. Keputusan yang menunggu Founder ("perlu keputusan Founder") cuma tertulis
   di tengah paragraf backlog, tidak ada penanda supaya ditinjau ulang.
6. Tidak ada dokumen tunggal yang bilang branch mana yang production Vercel
   — sempat menyebabkan salah push ke branch demo di sesi yang sama dengan
   pembuatan dokumen ini.

Alur di bawah ini menutup keenam gap itu.

---

## Alur end-to-end

```
Intake
  ↓
Klasifikasi (teknis/produk, ukuran, perlu Gate ID?)
  ↓
Rencana tertulis (skip untuk quick fix)
  ↓
Build — Enterprise Lean Mode (CLAUDE.md)
  ↓
Verifikasi — Definition of Done
  ↓
Dokumentasi & Tutup
```

### 1. Intake

Setiap item baru — request Founder, temuan CTO, bug report — masuk dulu ke
`TRACKER.md` § [Sedang Dikerjakan / Berikutnya / Ditunda](../../TRACKER.md#sedang-dikerjakan--berikutnya--ditunda)
dengan tag asalnya (`[REQUEST FOUNDER]` / `[TEMUAN]` / `[TERENCANA]`).

Kalau langsung dikerjakan di sesi yang sama (kasus paling umum untuk request
Founder kecil), boleh langsung ke Log Milestone setelah selesai — tapi tag
asalnya tetap wajib ditulis. Intake bukan birokrasi, cuma memastikan tidak
ada kerja yang tidak tercatat sama sekali.

### 2. Klasifikasi

Sebelum mulai, jawab tiga pertanyaan:

**a. Teknis/arsitektur atau produk/bisnis?**
Rujuk `CLAUDE.md` § Role Split. Teknis → putuskan sendiri, dokumentasikan.
Produk/bisnis (scope fitur baru, prioritas roadmap, keputusan yang mengubah
model bisnis/UX inti) → tanya Founder dulu, jangan asumsi. Kalau ragu,
perlakukan sebagai produk/bisnis.

**b. Seberapa besar?**

| Ukuran | Ciri | Butuh rencana tertulis? |
|---|---|---|
| Quick fix | 1 file/komponen, tidak sentuh DB, selesai dalam satu sesi | Tidak — langsung ke Build |
| Feature slice | Sentuh beberapa file/modul, mungkin migration kecil, satu vertical slice | Ya — ringkas, lihat §3 |
| Struktural | Ubah arsitektur, migration besar, atau berdampak ke gate yang sudah LOCKED | Ya — lengkap, lihat §3 + kemungkinan perlu ke Founder dulu (klasifikasi a) |

**c. Perlu Gate ID?**
Feature slice/Struktural yang akan diverifikasi & di-lock → beri Gate ID
skema datar `P<fase>.<urutan>` (mis. `P4.01`). Jangan tambah sub-suffix baru
ke skema lama (`3E-D6-B-H-R1`). Quick fix cukup baris di Log Milestone,
tidak perlu Gate ID.

### 3. Rencana tertulis (skip untuk quick fix)

Sebelum coding (CLAUDE.md sudah menegaskan: "Jangan langsung melakukan
coding sebelum inspeksi"). Rencana minimal berisi:

- Scope: apa yang berubah, apa yang sengaja **tidak** disentuh
- Modul/file terdampak
- Perlu migration? Kalau ya: apakah reversible, apakah butuh backfill
- Cara verifikasi yang akan dipakai (lihat §5)

Untuk perubahan Struktural yang menyentuh gate LOCKED atau keputusan bisnis
(pola seperti item NOO reversal di backlog), rencana ini yang dibawa ke
Founder untuk keputusan — bukan langsung eksekusi.

### 4. Build

Ikuti alur yang sudah ada di `CLAUDE.md` § Enterprise Lean Mode:
Search → Read → Inspect → Implement. Satu vertical slice selesai dulu
sebelum mulai yang lain — jangan buka banyak perubahan paralel setengah jadi.

### 5. Verifikasi — Definition of Done

Sebelum menandai selesai, cek yang relevan:

- [ ] Lint/typecheck/test lokal PASS
- [ ] Kalau ubah DB: migration diverifikasi jalan **di hosted**, bukan cuma
      lokal (gap accepted-limitation #7 di Backlog tracker terjadi karena ini
      dilewati)
- [ ] Kalau UI: diverifikasi visual/interaksi nyata (browser), bukan asumsi
      "seharusnya jalan"
- [ ] Kalau perlu deploy: **cek dulu branch production** di `TRACKER.md` §
      Status Ringkas sebelum push (production = `main`, branch lain cuma
      Preview) — konfirmasi status deploy setelah push, jangan asumsi
      berhasil

### 6. Dokumentasi & Tutup

- Pindahkan item dari "Sedang Dikerjakan" ke Log Milestone `TRACKER.md`,
  dengan tag asal dan status (PASS/PARTIAL/BLOCKED)
- Kalau menutup atau membuka gap: update § Backlog & Gap Diketahui. Gap baru
  yang butuh keputusan Founder → tambahkan juga ke § Ditunda, bukan cuma
  disebut di tengah paragraf
- Dokumen gate (`docs/product/readiness/*.md`) **commit di commit yang sama**
  dengan kode/migration-nya — jangan ditinggal untracked
- Update § Progres Modul MVP kalau level modul berubah

---

## Peran (ringkas — detail di `CLAUDE.md`)

- **Founder**: arah produk/bisnis, keputusan yang di-parkir di § Ditunda
- **Claude Code (CTO + Senior Programmer)**: keputusan teknis/arsitektur
  otonom (didokumentasikan), eksekusi seluruh alur di atas

Kalau ragu suatu keputusan itu teknis atau produk/bisnis: perlakukan sebagai
produk/bisnis, tanya dulu.
