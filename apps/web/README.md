# FlowSales AI — Web App

> **Beta v1.0 RC** · Next.js 16.2.9 (Turbopack) · Supabase · Anthropic Claude

Aplikasi web utama FlowSales AI. Lihat [README.md di root monorepo](../../README.md) untuk dokumentasi lengkap.

## Development

```bash
# Dari root monorepo
pnpm dev          # Start semua apps
pnpm --filter web dev   # Start hanya web app

# Lint & Build
pnpm --filter web lint
pnpm --filter web build
```

## Struktur

```
src/
├── app/
│   ├── (auth)/       # /login, /forgot-password, /reset-password
│   ├── (dashboard)/  # /dashboard/* — semua halaman terproteksi
│   └── (demo)/       # /demo/* — route demo presenter
├── components/       # UI components
├── lib/
│   ├── ai/           # AI insights engine
│   ├── automation/   # Automation engine
│   ├── auth/         # RBAC utilities
│   ├── supabase/     # Supabase client factory
│   └── settings/     # Import pipeline
└── proxy.ts          # Global auth guard
```

Environment variables: lihat `.env.example`.
