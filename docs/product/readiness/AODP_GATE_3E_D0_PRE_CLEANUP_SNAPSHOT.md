# AODP — Gate 3E-D0: Pre-Cleanup Snapshot (non-secret)

Snapshot metadata diambil tepat sebelum eksekusi destructive cleanup,
sesuai otorisasi Founder 2026-08-05. Re-verifikasi baseline PASS — cocok
persis dengan [inventory audit](AODP_GATE_3E_D0_HOSTED_CLEAN_SLATE_INVENTORY.md).

Project ref: `mcbwgvtkhykrrtvbpeys` (AODP-Waluyo-Demo)
Snapshot timestamp (client clock): 2026-08-05T00:51:09.905Z

Dokumen ini TIDAK berisi password, hash, token, secret, atau
service-role key — hanya ID, email, role, tenant, slug, dan count.

## Companies (3) — akan dihapus

| Company ID | Slug | Nama | Dibuat |
|---|---|---|---|
| `2d49badc-5ebb-40f5-8467-73e1f36464c2` | `sumber-warna-alam-sudiada-demo` | PT. Sumber Warna Alam Sudiada | 2026-07-16T10:21:19.604562+00:00 |
| `3aa2a0df-8ed2-4b4e-8299-73445ae6a1e2` | `isolation-test-tenant-synthetic` | PT. Isolation Test Tenant (Synthetic) | 2026-07-16T10:21:21.234723+00:00 |
| `90e6f03b-770b-4c4b-91fc-cf8ab522be71` | `pt-uat-gate-3e-c-c2-b2-0f3a28c9` | PT UAT Gate 3E-C-C2-B2 | 2026-08-03T23:33:54.521883+00:00 |

## auth.users / public.users (8) — akan dihapus (2 tahap: SQL cascade lalu Admin API)

| Auth User ID | Email | Company Slug | Role |
|---|---|---|---|
| `9da6f93f-1f60-43e0-86aa-6ff6c2296c58` | owner.demo@waluyo.aodp.test | sumber-warna-alam-sudiada-demo | owner |
| `bc38396b-4f13-45b3-9a3a-cb79cab82a29` | admin.demo@waluyo.aodp.test | sumber-warna-alam-sudiada-demo | admin |
| `60fefc86-0c69-45a8-9ca8-084de904d737` | sales.demo@waluyo.aodp.test | sumber-warna-alam-sudiada-demo | sales |
| `f0d9eb66-a0d0-4307-aae5-7b67b2ba026c` | sales2.demo@waluyo.aodp.test | sumber-warna-alam-sudiada-demo | sales |
| `4e32c324-6934-4971-bbcb-ff0ad95810e3` | owner.isolation@aodp.test | isolation-test-tenant-synthetic | owner |
| `b413e193-ff04-4506-a335-2f8e6608ea56` | ptandratranscaterservices@gmail.com | pt-uat-gate-3e-c-c2-b2-0f3a28c9 | owner |
| `c3563fa8-4aac-4181-818e-9c0445d466c9` | diaryofero@gmail.com | pt-uat-gate-3e-c-c2-b2-0f3a28c9 | admin |
| `4f8d2395-e9cf-44ca-895d-23391094a8bd` | manglegendz@gmail.com | pt-uat-gate-3e-c-c2-b2-0f3a28c9 | sales |

Orphan check pre-cleanup: `auth.users` tanpa `public.users` = 0.
`public.users` tanpa `auth.users` = 0.

## Row count per tabel (89 tabel diperiksa) — pre-cleanup

| Tabel | Count |
|---|---|
| companies | 3 |
| users | 8 |
| roles (system, dipertahankan) | 8 |
| permissions (system, dipertahankan) | 65 |
| role_permissions (system, dipertahankan) | 205 |
| user_roles | 8 |
| products | 6 |
| customers | 5 |
| sales_orders | 5 |
| sales_order_items | 6 |
| audit_logs | 39 |
| knowledge_product_aliases | 8 |
| knowledge_customer_aliases | 9 |
| customer_pics | 5 |
| customer_pic_history | 9 |
| customer_relationship_events | 9 |
| order_cancellation_disputes | 1 |
| salesman_coverage_areas | 4 |
| coverage_areas | 3 |
| (73 tabel lain) | 0 |

GRAND TOTAL (89 tabel, termasuk system catalog): 406 baris.
Storage buckets: 0 (tidak dikonfigurasi).

## Post-cleanup expected state

- companies = 0
- auth.users = 0, public.users = 0, user_roles = 0 (tenant scope)
- seluruh data bisnis tenant = 0
- `roles` = 8, `permissions` = 65, `role_permissions` = 205 (tidak berubah — system catalog)
- storage buckets = 0 (tidak berubah)
