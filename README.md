# AI Operating Distributor Platform (AODP)

AI Operating Distributor Platform adalah platform AI modular untuk owner distributor agar bisnis tetap aman, sales terkontrol, piutang terpantau, dan keputusan bisa diambil cepat.

## Core Philosophy

**Minimize but Optimize**

Setiap fitur harus mengikuti rantai:

**Data → Insight → Decision → Action**

Platform ini bukan ERP pencatatan biasa. Platform ini adalah AI Operating System untuk owner distributor.

## Modules

1. WhatsApp AI
2. FlowSales AI
3. Collection Intelligence
4. Business Guard AI
5. Warehouse Intelligence (Roadmap)

## Codebase Origin

Codebase ini diadopsi (fork) dari **FlowSalesAI Beta v1.0 RC** per keputusan Phase 0 (2026-07-07):

- FlowSalesAI beta tetap berjalan terpisah di repo aslinya untuk design partner PT Viona.
- Seed data dan mode demo Viona sudah di-exclude dari codebase ini.
- Nama tabel `companies` dipertahankan (bukan `organizations`).
- Salesperson dimodelkan sebagai `users` dengan role `sales` (tanpa tabel terpisah).
- Namespace internal package `@flowsales/*` dipertahankan — FlowSales Core adalah fondasi bersama, FlowSales AI menjadi salah satu modul AODP.

## Architecture

```
AODP Monorepo (Turborepo + pnpm workspaces)
├── apps/web/           # Next.js 16 (App Router) — seluruh UI + server actions
├── packages/
│   ├── ai/             # AI provider layer (anthropic/openai/mock, provider-agnostic)
│   ├── database/       # Supabase client + generated types
│   ├── shared/         # Util bersama
│   ├── types/          # Shared TypeScript types
│   └── ui/             # Komponen UI bersama
├── supabase/           # SQL migrations (multi-tenant + RLS)
├── n8n/                # Workflow automation (WhatsApp report, alert, reminder)
└── docs/               # Product Constitution, PRD, Architecture, Module Specs, Sprints
```

**Stack:** Next.js 16, TypeScript, Tailwind CSS, Supabase (PostgreSQL + RLS + Auth), Anthropic Claude via AI provider layer, n8n (HMAC-signed webhooks).

## Development

### Prerequisites

- Node.js 20+
- pnpm 9+
- Supabase project
- Anthropic API key

### Setup

```bash
pnpm install
pnpm db:migrate   # jalankan migrations ke Supabase project AODP
pnpm dev          # development server
```

> **PENTING:** `.env.local` hasil fork masih menunjuk ke Supabase project FlowSalesAI (beta PT Viona).
> Buat Supabase project baru khusus AODP dan ganti `NEXT_PUBLIC_SUPABASE_URL`,
> `NEXT_PUBLIC_SUPABASE_ANON_KEY`, dan `SUPABASE_SERVICE_ROLE_KEY` sebelum menjalankan
> `pnpm db:migrate` atau melakukan write apa pun. Jangan push migration ke project beta.

## Development Workflow

- ChatGPT berperan sebagai CTO + Product Manager.
- Claude Code berperan sebagai Senior Programmer.
- Claude Code wajib mengikuti dokumen di folder `/docs` sebelum implementasi.
- Jangan membuat fitur di luar scope tanpa approval.
