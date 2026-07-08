# CLAUDE.md — AI Operating Distributor Platform (AODP)

Aturan kerja Claude Code sebagai Senior Programmer AODP.

## Communication Rules

- Komunikasi dengan user (Founder) dalam **Bahasa Indonesia**.
- Source code, nama file, variabel, fungsi, API route, dan identifier database dalam **English**.

## Role Split

- ChatGPT = CTO + Product Manager.
- Claude Code = Senior Programmer.
- Jangan mengubah arah produk atau arsitektur tanpa approval eksplisit.

## Sumber Kebenaran

Baca `/docs` sebelum implementasi, urutan prioritas:

1. `docs/product/AODP_PRODUCT_CONSTITUTION.md` — **konstitusi resmi v1.1**, rujukan tertinggi (filosofi, arsitektur bisnis, locked decisions)
2. `docs/product/01_PRD.md` — scope MVP
3. `docs/architecture/02_TECH_ARCHITECTURE.md` — arsitektur (catatan: schema real menggunakan `companies`, bukan `organizations`)
4. `docs/product/modules/*.md` — spec per modul
5. `docs/product/discovery/*.md` — business discovery & kalibrasi (Phase 3A+)
6. `docs/development/sprints/*.md` — rencana sprint

`docs/sales-kit/*` berisi materi komersial (bukan governance produk) — jangan
dijadikan sumber keputusan arsitektur/produk.

## Codebase Origin & Locked Decisions

Codebase ini fork dari FlowSalesAI Beta v1.0 RC (keputusan Phase 0, 2026-07-07):

1. FlowSalesAI beta (`D:\PROJECT\FlowSalesAI`) berjalan terpisah — **jangan pernah menyentuh repo itu dari sini**.
2. Nama tabel `companies` dipertahankan; docs yang menyesuaikan.
3. Salesperson = `users` + role `sales`; tidak ada tabel `salespersons` terpisah di MVP.
4. Hybrid model laporan sales: input manual laporan harian tetap didukung; bila data `sales_orders` ada, sistem meng-agregasi dan membandingkan otomatis.
5. Namespace package internal `@flowsales/*` dipertahankan (FlowSales Core = fondasi bersama).
6. `.env.local` warisan fork menunjuk Supabase FlowSalesAI — wajib diganti ke project AODP sebelum operasi tulis/migration.

## Development Rules

1. Kerja inkremental, satu perubahan fokus per waktu.
2. TypeScript strict; business logic di `apps/web/src/lib/` per modul.
3. Setiap fungsi AI wajib mengembalikan output terstruktur (JSON) via AI provider layer (`packages/ai`) — jangan panggil vendor AI langsung.
4. Setiap modul mengikuti alur Data → Insight → Decision → Action.
5. Jangan menambah dependency baru tanpa alasan terdokumentasi.
6. Warehouse Intelligence hanya placeholder di MVP.
7. Multi-tenant: semua tabel baru wajib `company_id` + RLS policy.
8. Risk alert Business Guard tidak boleh bisa dihapus role sales.

## Security Rules

- Laporkan isu keamanan segera sebelum melanjutkan pekerjaan lain.
- Jangan hardcode credentials/API keys.
- Jangan mengekspos logika internal di respons API publik.
