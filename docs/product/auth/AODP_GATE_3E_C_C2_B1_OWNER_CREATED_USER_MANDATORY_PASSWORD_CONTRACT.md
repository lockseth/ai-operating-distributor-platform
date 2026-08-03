# AODP — Gate 3E-C-C2-B1: Owner-Created Tenant User Backend & Mandatory Password Change Contract

Status: **PASS** (backend-only implementation; UI journey deferred to Gate 3E-C-C2-B2).
Baseline: `main`, HEAD `1843101` (== `origin/main`, zero divergence).
Extends: `docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md` §5.B
("Owner adds user (admin | sales)") — that contract's `sales`-only path
(`createSalesmanAction` / `salesman/*`) is **unchanged** and remains the coverage-area
creation flow. This gate adds a **new, parallel** path for `{admin, sales}` without
coverage areas, with a mandatory-password-change requirement the old path does not have.

---

## 1. What changed

| Layer | File | Change |
|---|---|---|
| Migration | `supabase/migrations/20260911000001_gate_3e_c_c2_b1_owner_created_user_mandatory_password.sql` | `public.users.must_change_password` + `provisioned_password_hash` columns, column-level privilege lockdown, two `SECURITY DEFINER` RPCs. |
| Backend module | `apps/web/src/lib/tenant-users/*` | `types.ts`, `service.ts`, `password.ts`, `repository.ts`, `workflow.ts`, `actions.ts` (`createTenantUserAction`) — new, parallel to `salesman/*`. |
| Auth gate | `apps/web/src/lib/auth/get-user.ts` | Reads `must_change_password`; self-heals via RPC; redirects to `/reset-password` (existing page, unmodified) if not yet cleared. |
| Routing | `apps/web/src/lib/supabase/middleware.ts` | `/reset-password` excluded from the "bounce authenticated user to `/dashboard`" branch (was previously part of `isAuthRoute`) — required to avoid a redirect loop against the new gate. |
| Tests | `apps/web/src/lib/tenant-users/{workflow,security}.test.ts`, `apps/web/src/lib/auth/get-user.security.test.ts` (additions), `apps/web/src/lib/auth/gate-3e-c-c2-b1-owner-created-tenant-user.integration.test.ts` (new, DB-backed) | Unit + security (static) + live-Postgres integration coverage. |

No UI file was created or modified (per gate scope). `/reset-password` is the existing
`reset-password-form.tsx` (unmodified) — it already does exactly one thing,
`supabase.auth.updateUser({ password })`, which is sufficient for this contract.

---

## 2. Trust boundaries

- **Client (browser)** — for `createTenantUserAction`, may only assert `full_name`,
  `email`, `role` (`admin` | `sales`), `phone` (optional). It may **never** assert
  `company_id`, `actor_id`, or a temporary password — all three are either server-derived
  (`getAuthUser()`) or server-generated (`generateSecureTempPassword()`,
  `node:crypto.randomBytes`). Confirmed by `security.test.ts` (static assertions on the
  actual source) and by the type shape of `CreateTenantUserFormInput`.
- **Server action (`createTenantUserAction`)** — authenticates via `getAuthUser()`,
  requires `roles.includes("owner")` (`isOwnerActor`, identical domain to
  `salesman/actions.ts`), rejects demo sessions, then and only then touches
  `getAdminClient()` (service-role).
- **Service role (`getAdminClient()`)** — bypasses RLS. Used for `admin.createUser()`
  (Supabase Auth Admin API) and for calling `provision_owner_created_tenant_user()`.
  Per the frozen §4 principle ("Database is the actual authorization backstop"), the RPC
  **does not trust** that `actions.ts` already checked the actor — it re-verifies
  `owner` + `is_active` + same-tenant membership itself, exactly like
  `assign_salesman_coverage_areas`/`set_salesman_active_status` (migrations
  `20260814000001`/`20260815000001`).
- **Database (RLS + SECURITY DEFINER RPCs)** — the authoritative surface:
  - `provision_owner_created_tenant_user(p_actor_id, p_company_id, p_user_id, p_role_id,
    p_full_name, p_email, p_phone)` — granted **only** to `service_role`. Re-verifies actor,
    re-verifies `p_role_id` via the existing `public.is_tenant_assignable_role()` helper
    (Gate 3E-C-B0-S1) — the **same** allowlist source used by the direct-REST `user_roles`
    RLS policies, so there is exactly one place that defines "assignable role."
  - `complete_mandatory_password_change()` — granted **only** to `authenticated`, takes
    **zero** parameters, identity is always `auth.uid()`. A caller can only ever affect
    their own row — there is no `user_id` parameter to target another user.

---

## 3. Provisioning lifecycle (atomic + compensating)

Same shape as `createSalesman()` (`salesman/workflow.ts`), generalized:

```
validate input (service.ts)
  → invalid_input
resolve role_id by name, allowlist {admin, sales} (repo.findRoleIdByName)
  → invalid_role
generate temp password server-side (password.ts, crypto.randomBytes)
admin.createUser()  [Supabase Auth Admin API — auth.users row created OUTSIDE this tx]
  → duplicate_email / unexpected_error
provision_owner_created_tenant_user()  [ONE Postgres transaction]
  ├─ re-verify actor: owner, active, same company_id            → forbidden
  ├─ re-verify role_id via is_tenant_assignable_role()           → invalid_role
  ├─ validate full_name/phone/email lengths                     → invalid_input
  ├─ snapshot auth.users.encrypted_password (read-only, SECURITY DEFINER)
  ├─ INSERT public.users (must_change_password=TRUE, provisioned_password_hash=snapshot)
  ├─ INSERT public.user_roles
  └─ INSERT public.audit_logs ('tenant_user.created', no password/hash)
  → any exception (e.g. unique_violation) bubbles to TS
if provisioning failed for ANY reason → repo.deleteAuthUser(userId) [compensating delete,
  cascades the profile via FK ON DELETE CASCADE — matches createSalesman()'s pattern]
→ outcome "created": { userId, tempPassword }  [returned to the owner exactly once]
```

Profile + role + password-hash-snapshot + audit are one Postgres transaction (stronger
atomicity than the older `sales`-only path, which does two separate top-level calls with
TS-level compensation only). The **only** non-transactional step is `admin.createUser()`
itself, which is why compensation (delete) is still needed at the TS layer — identical
reasoning to `provision_first_owner()`'s and `createSalesman()`'s documented rationale.

---

## 4. Mandatory password state machine

```
                    ┌──────────────────────────────┐
                    │ Owner creates admin|sales     │
                    │ must_change_password = TRUE   │
                    │ provisioned_password_hash =    │
                    │   snapshot(auth.users.         │
                    │   encrypted_password)          │
                    └───────────────┬────────────────┘
                                    │ user logs in with temp password
                                    ▼
                    ┌──────────────────────────────┐
                    │ RESTRICTED STATE               │
                    │ getAuthUser() sees flag=TRUE,   │
                    │ calls complete_mandatory_       │
                    │ password_change() (self-heal)   │
                    └───────────────┬────────────────┘
              RPC compares current            RPC compares current
              encrypted_password ==            encrypted_password !=
              snapshot (not yet changed)       snapshot (changed!)
                        │                                │
                        ▼                                ▼
        redirect /reset-password              flag cleared, hash nulled,
        (existing page, session NOT           audit_logs row written,
        signed out) — repeats on              access proceeds normally
        every subsequent request until
        password is actually changed
```

**Allowed routes/actions during the restricted state** (server-enforced, not UI-only):
- `/reset-password` (existing page — `middleware.ts` no longer bounces an authenticated
  session away from it; `getAuthUser()` is never called by that page, so no loop).
- Logout (`signOutAction`) — does not call `getAuthUser()` at all, always available.
- Nothing else. Any other page or Server Action that calls `getAuthUser()` (confirmed:
  95 call sites across the app) redirects to `/reset-password` before running.

**Proof requirement**: the flag is *never* cleared on a client claim. It is cleared only
when Postgres itself observes that `auth.users.encrypted_password` differs from the
snapshot taken at provisioning time — i.e., only after a real, successful
`supabase.auth.updateUser({ password })` (or an admin password reset) has committed.
Verified live: integration tests #10/#11 (`gate-3e-c-c2-b1-...integration.test.ts`) call
the RPC *before* changing the password (rejected) and *after* (cleared), against a real
local Postgres/GoTrue instance.

---

## 5. Security invariants (verified, not merely asserted)

All of the following were proven against a **real local Supabase/Postgres instance**
(`127.0.0.1:54321`/`54322`, not mocks), via
`gate-3e-c-c2-b1-owner-created-tenant-user.integration.test.ts` (15/15 passing):

1. Owner creates `admin` — profile/role/audit created atomically, `must_change_password`
   is `TRUE`.
2. Owner creates `sales` — regression check, unaffected by this new path.
3. Role injection (`owner`, `super_admin`) via the RPC — rejected (`invalid_role`),
   **zero** rows persisted.
4. Non-owner actor (tested: `admin`) — rejected (`forbidden`), zero persistence.
5. Inactive owner — rejected (`forbidden`), zero persistence.
6. Cross-tenant (owner of A targeting company B) — rejected (`forbidden`).
7. Auth user that doesn't exist in `auth.users` — fails closed with
   `AODP_INVALID_AUTH_USER`, zero persistence.
8. Retried provisioning against the same `user_id` — `unique_violation` (23505), first
   row untouched (proves atomicity/no silent overwrite).
9. Direct REST `PATCH /rest/v1/users` attempting to self-clear `must_change_password` —
   **permission denied at the column-privilege layer**, independent of RLS.
10. `complete_mandatory_password_change()` called before the password is actually changed
    — returns `password_not_yet_changed`, flag stays `TRUE`.
11. Called after a real `updateUser({ password })` — returns `cleared`, flag becomes
    `FALSE`; idempotent on a second call (`already_cleared`).
12. A second user cannot clear a different user's flag (no `user_id` parameter exists to
    target one).
13. `user_metadata` spoofing (`role: "owner"`, forged `company_id`) after creation — has
    zero effect on the stored `user_roles`/`company_id` (both are DB-sourced, never
    metadata-sourced, consistent with Gate 3B/3C).
14. `provisioned_password_hash` is not readable via `SELECT` by the `authenticated` role
    at all (column-level privilege), even for the row's own owner.

### Column-privilege finding (fixed during this gate, not merely designed around)

`REVOKE UPDATE (col) ON table FROM role` **has no effect** if that role already holds a
table-level `UPDATE` grant — and `authenticated`/`anon` do, via the blanket
`GRANT ALL ON ALL TABLES IN SCHEMA public` (migration `20260707000003`). Column-level and
table-level ACLs in Postgres are additive, not "more-specific-wins." The migration
therefore does `REVOKE SELECT, UPDATE ON public.users FROM authenticated, anon` first,
then re-grants column-scoped `SELECT`/`UPDATE` for exactly the pre-existing columns —
`must_change_password`/`provisioned_password_hash` are the only two columns intentionally
excluded from `UPDATE` (and `provisioned_password_hash` additionally excluded from
`SELECT`). This was verified live (`docker exec ... psql`, `SET ROLE authenticated`)
both before the fix (bypass succeeded) and after (permission denied), and again through
the DB-backed integration tests (#9, #14). No pre-existing column's effective privilege
was narrowed — `users_self_update`/`users_manager_update`/`users_company_select` RLS
policies are untouched.

---

## 6. Regression checks

- Existing login/signup/forgot-password/reset-password flows: unaffected — no shared
  code was modified except `get-user.ts` (additive gate after the existing `is_active`
  check) and `middleware.ts` (narrowed `isAuthRoute`, `/reset-password` moved to its own
  flag but kept in `isPublicRoute` — unauthenticated recovery-link access is preserved).
- `salesman/*` (`sales`-only, with coverage areas): entirely untouched — different
  module, different action, different RPC.
- `provision_first_owner()` / demo accounts / `createSalesmanAction`-created users: never
  touch `must_change_password` or `provisioned_password_hash` — both columns default to
  `FALSE`/`NULL`, and the `CHECK` constraint only constrains the `TRUE` case, so existing
  `INSERT` statements that don't mention these columns are unaffected.
- Full `vitest run` (unit + security + all existing integration suites) and `tsc --noEmit`
  were run after these changes; the only `tsc` finding is a pre-existing error in
  `gate-3d-b2-atomic-owner-provisioning.integration.test.ts` (confirmed present on the
  base commit via `git stash`, not introduced by this gate).

---

## 7. Deferred to Gate 3E-C-C2-B2 (explicitly out of scope here)

- UI: a form for `createTenantUserAction` (full_name/email/role/phone), and displaying
  the returned `tempPassword` exactly once to the owner (e.g. a one-time reveal dialog —
  must not be logged, put in a URL, or persisted client-side beyond the single render).
- Any visual/journey treatment of the mandatory-password-change redirect (currently it
  silently lands on the existing generic `/reset-password` form with no messaging
  explaining *why* the user landed there).
- Coverage-area assignment for `admin`/`sales` created via this new path (the old
  `sales`-with-coverage-areas path via `createSalesmanAction` is untouched and remains
  available; unifying the two — or deciding whether `admin`/`sales` created here should
  also get coverage areas — is a product decision for a later gate).
- Deactivation/reactivation UI for users created via this path (the underlying
  `is_active` column and `users_manager_update` RLS already support it structurally, but
  no dedicated action/RPC parallel to `setSalesmanActiveStatusAction` was built here —
  out of scope per this gate's brief).

---

## 8. Summary

```
RESULT: PASS
BASELINE: main @ 1843101 (== origin/main, zero divergence)
AUDIT FINDINGS: owner-add-user existed only for role=sales with coverage areas
  (salesman/*); no must_change_password-equivalent existed anywhere; users_self_update
  RLS (no WITH CHECK) combined with the blanket GRANT ALL table privilege meant any
  self-update column would have been client-writable without a column-level fix.
CONTRACT IMPLEMENTED: owner-only, allowlist {admin, sales} (re-verified in DB, not just
  app layer), atomic provisioning RPC with compensating auth-user delete, server-
  generated temp password (crypto.randomBytes, returned once), mandatory password change
  enforced in getAuthUser() via a DB-provable RPC (encrypted_password hash comparison,
  not a client claim), zero new UI/routes.
FILES CHANGED: supabase/migrations/20260911000001_gate_3e_c_c2_b1_owner_created_user_
  mandatory_password.sql (new); apps/web/src/lib/tenant-users/{types,service,password,
  repository,workflow,actions,workflow.test,security.test}.ts (new);
  apps/web/src/lib/auth/get-user.ts (additive gate); apps/web/src/lib/auth/
  get-user.security.test.ts (additions); apps/web/src/lib/supabase/middleware.ts
  (isAuthRoute narrowed, isResetPasswordRoute added); apps/web/src/lib/auth/
  gate-3e-c-c2-b1-owner-created-tenant-user.integration.test.ts (new).
MIGRATION: 20260911000001 — applied and verified against local loopback Supabase
  (127.0.0.1:54321/54322, AODP project) only; not run against any hosted project.
AUTH/SECURITY INVARIANTS: see §5 — 14 invariants proven against real Postgres/GoTrue,
  including a column-privilege bug found and fixed mid-gate (table-level GRANT ALL
  defeats column-level REVOKE unless the table-level grant is revoked first).
COMPENSATION: provisioning failure after auth.users creation → deleteAuthUser() (cascades
  profile via FK), identical pattern to createSalesman()/provision_first_owner().
TESTS: 34 unit/security tests (apps/web/src/lib/tenant-users), 6 get-user security tests
  (3 new), 15 DB-backed integration tests — all passing against local Postgres.
REGRESSION: salesman/* untouched; provision_first_owner()/demo accounts unaffected
  (columns default FALSE/NULL); full vitest run + tsc --noEmit clean except one
  pre-existing, unrelated tsc error confirmed present on the base commit.
DIRTY FILE PRESERVATION: CLAUDE.md, docs/sales-kit/00_INDEX.md, scripts/seed-dev.ts
  (modified, untouched); docs/document-engine/assets/samples/waluyo/logo-pt-sumber-
  warna-alam-sudiada.jpeg, docs/product/readiness/AODP_GATE_3D_B3_F5_HOSTED_UAT_CLEANUP_
  RUNBOOK.md, docs/sales-kit/demo-movie/ (untracked, untouched).
HOSTED ACTIONS NOT PERFORMED: no migration run against a hosted/production Supabase
  project; no real (non-test) user created; no commit/push/deploy performed.
NEXT: Gate 3E-C-C2-B2 — Owner-Created User UI & Mandatory Password Change Journey.
```
