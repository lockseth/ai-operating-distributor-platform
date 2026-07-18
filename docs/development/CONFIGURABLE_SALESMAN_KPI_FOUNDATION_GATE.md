# Configurable Salesman KPI Foundation Gate

## Scope

Implementasi additive berdasarkan `docs/product/discovery/AODP_WALUYO_SALESMAN_KPI_FINAL.md`.

### In scope

- `sales_kpi_definitions`
- `sales_kpi_periods`
- `sales_kpi_targets`
- initializer `CALL` + `EFFECTIVE_CALL`
- target versioning dan audit
- forward-only period lifecycle
- RLS dan service-role-only mutation RPC
- TypeScript domain contract, repository adapter, Server Actions, dan in-memory demo

### Out of scope

- achievement measurement/integration
- weighted/composite score
- AR/Collection sebagai KPI
- visit-task execution
- dashboard/ranking/owner WhatsApp report
- perubahan destructive pada `sales_reports` legacy

## Acceptance Criteria

1. Baseline 507 tests tetap lulus.
2. Initializer membuat tepat `CALL` dan `EFFECTIVE_CALL`, idempotent.
3. Tidak ada KPI AR, omzet, collection, weight, atau composite score.
4. Period tenant-scoped, tidak overlap, dan hanya `DRAFT → ACTIVE → LOCKED`.
5. Target hanya positive integer dan hanya untuk Salesman aktif pada tenant sama.
6. Target revision membuat versi baru; versi lama disupersede dan tetap ada.
7. Locked period menolak perubahan target.
8. Owner/manager/super_admin dapat manage; Salesman hanya read target sendiri.
9. RPC tidak exposed ke `PUBLIC`, `anon`, atau `authenticated`.
10. Server Action mengambil company/actor dari authenticated session, bukan input client.
11. Unit/security/demo tests, typecheck, lint, dan build PASS.
12. Tidak ada commit, push, cloud migration, atau deploy pada gate lokal.

## Local Checkpoint Result — 18 Juli 2026

- **Tests:** PASS — 536 lulus, 0 skipped, termasuk 5 DB integration test (baseline: 502 lulus, 5 skipped).
- **Typecheck:** PASS — 6/6 package.
- **Lint:** PASS — 0 error; 9 warning pre-existing di luar scope KPI.
- **Production build:** PASS — compile, TypeScript, page generation, dan optimization selesai pada Windows.
- **Migration syntax:** PASS — PostgreSQL 17 parser menerima 39 statement.
- **Migration execution:** PASS — Supabase CLI 2.109.1 clean reset berhasil menjalankan seluruh migration dari database kosong.
- **Runtime/RLS smoke:** PASS — initializer idempotent, hanya `CALL` + `EFFECTIVE_CALL`, target versioning dan period locking berfungsi, Salesman hanya melihat target sendiri.
- **Demo:** PASS — target `CALL` + `EFFECTIVE_CALL` dibuat, direvisi secara versioned, lalu period dikunci.
- **External mutation:** NONE — tidak ada commit, push, cloud migration, atau deploy.

**Gate decision:** local gate PASS; perubahan siap untuk scoped commit/push setelah review diff.
