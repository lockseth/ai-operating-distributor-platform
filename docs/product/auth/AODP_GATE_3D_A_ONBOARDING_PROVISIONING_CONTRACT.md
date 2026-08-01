# AODP — Gate 3D-A: Production Onboarding & User Provisioning Contract Freeze

Status: **GAP FOUND** (contract frozen for what exists; production signup/invite paths are unbuilt — implementation is out of scope for this gate). **G1 and G7 are RESOLVED/FROZEN by amendment Gate 3D-A1 (2026-08-01)** — see §7 and §10. G2–G6 remain open, contract-only, pending Gate 3D-B+ implementation.
Baseline: `main` @ `36353c7171760bb5a996b435ccc7b430cfce94fc` (== `origin/main`).
Supersedes: nothing (first auth/provisioning contract doc — Gate 3A/3B/3C shipped as code + commit messages only, no dedicated contract doc existed before this one).
Related locked gates: Gate 3A (demo baseline), Gate 3B (`20260905000001_gate_3b_role_permission_matrix.sql`), Gate 3C (`f46a94e`), Gate 3C-A (`36353c7`).

---

## 0. Scope note

This gate is **contract-first**. No migration, RPC, or route was added or changed to
produce this document, beyond this file itself. Every "FROZEN" statement below either
(a) describes behavior that is already enforced in code/DB today, or (b) is an explicit
**target contract** for work that does not exist yet, marked GAP. Section 8 lists every
gap; nothing in Sections 3–6 should be read as "already implemented" unless it says so.

---

## 1. Existing auth/provisioning surface (audit findings)

| Surface | File | Status |
|---|---|---|
| Login (email+password) | `apps/web/src/components/auth/login-form.tsx` | Built. Client-side `supabase.auth.signInWithPassword`. OAuth removed (Gate 3C/3C-A). |
| Forgot password | `apps/web/src/components/auth/forgot-password-form.tsx` | Built. `resetPasswordForEmail`, fixed same-origin `redirectTo`. |
| Reset password | `apps/web/src/components/auth/reset-password-form.tsx` | Built. `updateUser({ password })` only — no other field touched. |
| Sign out | `apps/web/src/lib/actions/auth.ts` | Built. Audit-logged, demo-aware. |
| Session/route guard | `apps/web/src/lib/supabase/middleware.ts` (`proxy.ts`) | Built. Explicit route allowlist, fail-closed default. |
| Auth identity resolution | `apps/web/src/lib/auth/get-user.ts` | Built. DB-sourced roles/permissions, fail-closed on inactive/no-membership (Gate 3A/3C). |
| **Public self-service signup** | — | **Does not exist.** No `/signup` route, no signup form/action, no public RPC. |
| **Owner invites/creates admin or sales user** | `apps/web/src/lib/salesman/*` (`createSalesmanAction` → `createSalesman()` workflow) | **Partially exists, role-limited.** Owner-only, atomic, compensating rollback — but hardcoded to `role = 'sales'` only. No path creates an `admin` user. |
| First user of a new tenant | `apps/web/src/lib/platform/tenant-actions.ts` (`createCompanyAction`, `createFirstUserAction`) | **Exists, but is an internal platform-operator tool**, not public signup. Gated on `roles.includes("super_admin")`, reachable only from `/dashboard/platform/tenants`. Assigns `owner` role via lookup of the system `owner` role row — not client input. |
| OAuth callback | — | Removed (Gate 3C-A). No runtime reference to `/callback` or `signInWithOAuth` remains. Confirmed by grep. |

**Direct consequence:** the product decision "Pak Waluyo menjadi pengguna pertama yang
melakukan signup" describes a flow that has **no code today**. The closest existing
mechanism (`createFirstUserAction`) requires an AODP-internal `super_admin` operator to
manually create the tenant and set Waluyo's temp password — it is not self-service.

---

## 2. Canonical sources of truth

Confirmed from `supabase/migrations/20260626000002_create_users_roles_permissions.sql`,
`20260626000004_rls_policies.sql`, `20260904000001_inactive_user_rls_containment.sql`,
and `apps/web/src/lib/auth/get-user.ts`:

| Concept | Canonical source | Notes |
|---|---|---|
| Tenant | `public.companies.id` | `slug` is `UNIQUE`; no other tenant-identity signal exists. |
| User identity | `auth.users.id` == `public.users.id` (1:1, FK `ON DELETE CASCADE`) | `public.users` is the only app-level profile row. |
| Active membership | Existence of a `public.user_roles` row for `(user_id, company_id)` | **Not** `auth.users.user_metadata`, not any client-supplied claim. |
| Role | `public.roles.name` joined through `user_roles.role_id` | Read via `get_user_roles()` / `getAuthUser()`. `user_metadata.role` is never read by any server code path (confirmed by grep — 0 references) and is proven ineffective by Gate 3B/3C integration tests (`spoofedMetadataRole` cases). |
| Onboarding/active status | `public.users.is_active` | Since Gate 3A fix, `get_user_company_id()` returns `NULL` for inactive users, which cascades to `NULL`/`FALSE` in every RLS policy and in `user_has_role`/`user_has_permission`. `getAuthUser()` additionally hard-redirects + signs out inactive users and users with zero `user_roles` rows (Gate 3C). |
| "Tenant already has an owner" | **No canonical source exists.** | No column, flag, or unique constraint records this. It can only be derived today by an ad-hoc `EXISTS` query against `user_roles JOIN roles` for `role.name = 'owner' AND company_id = X`. See Gap G1. |
| Service-role / RLS-bypass boundary | `apps/web/src/lib/supabase/admin.ts` (`getAdminClient()`) | Explicitly documented "server-only, never in client bundle." Used by `tenant-actions.ts`, `salesman/actions.ts`, `audit.ts`. |

---

## 3. State machine — onboarding & session

```
                    ┌─────────────────────────┐
                    │  (A) FIRST-OWNER SIGNUP  │   GAP — unbuilt, see §8 G2
                    │  new tenant + new user   │
                    └────────────┬─────────────┘
                                 │ atomic provisioning (target contract, §5.A)
                                 ▼
     ┌───────────────────────────────────────────────────────┐
     │ auth.users row exists  +  public.users row exists  +   │
     │ exactly one user_roles(role='owner') row for tenant    │
     └───────────────────────┬─────────────────────┬──────────┘
                              │                     │ any step fails after
                              │ all steps succeed   │ auth.users created
                              ▼                     ▼
                        ACTIVE OWNER          ORPHAN AUTH USER
                        (can log in)          (must self-heal — §6 recovery)

     ┌───────────────────────────────────────────────────────┐
     │ (B) LOGIN — existing user, any role                    │
     │ signInWithPassword → getAuthUser() resolves company/   │
     │ role/permissions from DB, fail-closed on inactive or   │
     │ zero-membership                                        │
     └───────────────────────────────────────────────────────┘

     ┌───────────────────────────────────────────────────────┐
     │ (C) OWNER ADDS admin|sales                              │
     │ owner-only actor check → atomic compensating workflow:  │
     │ createAuthUser → insertProfile → assignRole             │
     │ (any step fails → deleteAuthUser rollback)               │
     │ Currently role hardcoded to 'sales' only — GAP §8 G3     │
     └───────────────────────────────────────────────────────┘

     ┌───────────────────────────────────────────────────────┐
     │ (D) FORGOT / RESET PASSWORD                             │
     │ resetPasswordForEmail (generic outcome) → recovery       │
     │ session (Supabase-managed, one-time) → updateUser        │
     │ (password only) → redirect /login. No tenant/role/       │
     │ membership field is touched anywhere in this path.       │
     └───────────────────────────────────────────────────────┘

     ┌───────────────────────────────────────────────────────┐
     │ (E) EMAIL CONFIRMATION                                  │
     │ Admin-created users (tenant-actions.ts, salesman         │
     │ workflow): email_confirm=true set directly by service    │
     │ role — no confirmation email, immediate login capable.   │
     │ Public self-signup: confirmation behavior is a HOSTED     │
     │ Supabase project setting, not repo-controlled — GAP §8 G6 │
     └───────────────────────────────────────────────────────┘
```

These five are explicitly distinct per the gate brief, and the audit confirms the
codebase already treats them as five separate code paths with no shared implementation
(good — no accidental conflation to unwind). (A) is the only one with no implementation
at all; (C) is implemented for `sales` only.

---

## 4. Trust boundaries

- **Client (browser)** — may only ever assert: an email/password pair (login, signup),
  a new password (reset), or form fields for a *target* user being created by an owner
  (`fullName`, `email`, `phone`, `tempPassword`, `areaIds`). It may **never** assert
  `company_id`, `role`, or `assigned_by` — every existing provisioning action pulls
  those from the authenticated server session (`getAuthUser()`), confirmed in
  `tenant-actions.ts`, `salesman/actions.ts`.
- **Server action / route handler (anon or user session)** — authenticates the caller,
  re-derives role from DB, and is the only layer allowed to invoke service-role
  operations. RLS still applies to any query this layer runs on the user's own session
  client.
- **Service role (`getAdminClient()`)** — bypasses all RLS. Every current caller
  (`tenant-actions.ts`, `salesman/actions.ts`, `audit.ts`) is a `"use server"` file that
  performs its own authorization check (`roles.includes(...)`) **before** touching the
  admin client. There is no server action today that calls `getAdminClient()` without a
  preceding role check — confirmed by reading all three call sites.
- **Database (RLS + `SECURITY DEFINER` RPCs)** — the actual authorization backstop.
  Gate 3B proved that RPCs called via the service-role client bypass RLS entirely, so
  RPCs **must** re-implement their own authorization (as `update_sales_order_atomic`
  does). Any future first-owner/add-user RPC must follow the same pattern: check
  actor's role from `user_roles`/`roles` inside the function body, never trust a
  parameter for authorization.
- **Webhook/automation routes** — explicit allowlist in `middleware.ts`
  (`AUDITED_WEBHOOK_ROUTES`, `AUDITED_INTERNAL_AUTOMATION_ROUTES`), each with its own
  Bearer/secret auth. Not part of the user-auth trust boundary; noted only to confirm
  no user-auth bypass leaks through these paths.

---

## 5. Frozen contracts

### A. First owner (signup) — **target contract, not yet implemented**

1. Signup is **public** and unauthenticated. It must always create a **brand-new**
   `companies` row — there is no "join an existing tenant via signup" concept, so the
   "second owner of an existing tenant via public signup" attack surface reduces to:
   nothing stops a signup request from reusing a `company_id`/`slug`, because none is
   ever client-supplied for this flow. Any implementation MUST keep it that way — do
   not accept a `company_id` or `slug`-collision parameter from the signup form beyond
   the new company's own display name.
2. Owner assignment MUST be atomic and server/DB-side, following the exact compensating
   pattern already proven in `apps/web/src/lib/salesman/workflow.ts`
   (`createSalesman`): create company → create `auth.users` → insert `public.users`
   profile → insert `user_roles` with role resolved by name lookup (never a client
   parameter) → on any failure after the `auth.users` row exists, delete it (cascades
   the profile) and delete the just-created `companies` row.
3. Role is never accepted from the client or from `user_metadata`. The owner role id is
   resolved server-side by name lookup, mirroring `findSalesRoleId()`.
4. **Idempotency/recovery when an `auth.users` row exists but tenant provisioning
   failed:** the retry path is a re-submission of the same signup email. Because
   `auth.users.email` is unique, Supabase's `signUp`/`createUser` will reject a second
   attempt with "already registered" — the UI must special-case this and offer
   "resume/contact support," not a generic error, otherwise the user is stuck with an
   unusable orphaned account. This is unresolved — see Gap G4.
5. Email confirmation requirement for this specific flow is **undecided** — it depends
   on the hosted Supabase project's confirmation setting, which is not visible from the
   repo. See Gap G6.
6. **No second owner of the same tenant, ever, through any path** (public signup,
   forged request, metadata, race, replay, invitation, direct RPC): there is currently
   **no DB-level constraint enforcing "at most one owner per company."** **RESOLVED —
   see G1 (§7).** The DB-level guarantee (a `BEFORE INSERT` trigger, Option 1 in G1) is
   FROZEN as the mandatory, first implementation work item of Gate 3D-B (§7a) — no
   provisioning RPC and no signup UI may be built or merged before it lands and its own
   test (§8, Gate 3D-B item 0) passes. RLS/DB is the only surface Gate 3B treats as
   authoritative, and the same standard applies here.

### B. Owner adds user (admin | sales) — **partially built, role-restricted**

1. Only an **active `owner` membership** may initiate provisioning — already enforced
   (`isOwnerActor`, stricter than the broader `MANAGE_ROLES`/`canManageSalesman` check
   used only for page-view access). Freeze: this stays owner-only, matching Gate 3B's
   locked permission matrix (admin/manager never get provisioning rights).
2. Role input must be an **allowlist of `admin | sales`** — never `owner`, never
   free-form. Today the workflow hardcodes `sales` only (`findSalesRoleId()` with no
   parameter). Extending to `admin` requires threading an allowlisted role string
   through `CreateSalesmanFormInput`/`createSalesman()` and adding an equivalent
   `findRoleIdByName(role)` lookup restricted to `{'admin','sales'}` — the type system
   and a runtime allowlist check must both reject `'owner'` and any other value.
3. `company_id` is always `user.company_id` from the authenticated owner's session —
   never client input. Already correct in the existing `sales` path; must stay this way
   for the `admin` extension.
4. Mechanism decision (brief requires this be resolved, not left open): **reuse the
   existing owner-set-temporary-password pattern** already shipped for Salesman
   creation, rather than introducing Supabase invite emails. Rationale: it is the
   simplest mechanism already proven safe in this repo (atomic, compensating rollback,
   audit-logged, no hardcoded password — the value is operator-entered per user, not a
   constant), and Enterprise Lean Mode explicitly favors reusing existing architecture
   over introducing a new one (invite-email flow) without a stated need. If the Founder
   wants invite-email instead for the `admin` case specifically, that is a product
   decision to make explicitly — not assumed here.
5. No password is ever hardcoded in source for a production user — confirmed: the only
   hardcoded credentials anywhere in the auth surface belong to the Gate 3A **demo**
   accounts, which are out of scope for production provisioning (see §7).

### C. Admin & sales

1. Confirmed from `supabase/migrations/20260707000001_seed_system_role_permissions.sql`:
   `sales` receives **no** `users.*` permission at all → cannot view or reach
   `/dashboard/users`. `admin` receives **only `users.view`** → can see the user list
   page but every mutation (`createSalesmanAction`, `updateSalesmanCoverageAreasAction`,
   `setSalesmanActiveStatusAction`) is gated on `isOwnerActor`, which `admin` never
   satisfies. This matches the gate requirement exactly — **no change needed**.
2. Deactivation/reactivation (`setSalesmanActiveStatusAction`) is owner-only,
   fail-closed (unknown/foreign salesman → `forbidden`/`not_eligible`, never a silent
   no-op), and audit-logged via the RPC's own re-check inside
   `SupabaseSalesmanRepository` — matches "fail-closed and auditable." Frozen as-is.
3. Gate 3B's discount-policy owner-only lock (`kdp_manage` RLS) is untouched by this
   gate and remains the canonical discount-permission boundary.
4. **Gap:** none of the above (2) currently exists for `admin`-role targets, because no
   path creates an `admin` user yet (see B.2). Once it does, deactivation/role-change
   for `admin` targets must reuse the same owner-only, fail-closed, audited pattern —
   not a new one.

### D. Recovery (forgot/reset password)

1. **Redirect allowlist:** `redirectTo` is hardcoded to
   `${window.location.origin}/reset-password` — never derived from a query parameter
   or any user input. This is a fixed single path, which trivially satisfies "redirect
   only to domain/path allowlist" — freeze: do not change this to accept a dynamic
   `redirectTo`/`next` parameter without re-adding an explicit allowlist check.
2. **Generic messaging:** partially correct. `resetPasswordForEmail` itself does not
   reveal whether an email is registered (Supabase's documented behavior — it returns
   success regardless). The UI's error branch
   (`"Gagal mengirim email reset. Pastikan email terdaftar."`) only fires on a genuine
   Supabase error (e.g., rate limit, network), not on "email not found," so no
   enumeration oracle exists in practice today. The wording itself is slightly
   misleading (implies the cause is always non-registration) but is not a security
   defect — documented as a minor wording note, not a gap requiring implementation.
3. **One-time token:** enforced by Supabase Auth's recovery-session mechanism, which is
   hosted behavior outside this repo — not independently verifiable from source. Noted
   as a hosted-config assumption, not a gap (Supabase's documented default).
4. **Recovery never touches tenant/membership/role:** confirmed —
   `reset-password-form.tsx` calls `updateUser({ password })` only, no other field.
   Frozen: any future change to this form must not add fields beyond password.
5. **Inactive/no-membership users stay locked out after reset:** confirmed by
   construction. A successful password reset only changes the Supabase Auth password;
   it does not touch `public.users.is_active` or `user_roles`. The next `getAuthUser()`
   call (which every dashboard route depends on) still applies the Gate 3A/3C
   fail-closed checks (`is_active = FALSE` → sign out + redirect; zero `user_roles` →
   sign out + redirect). **No gap here.**

### E. Demo vs. production separation

1. Demo bypass (`DEMO_MODE_COOKIE`, `isDemoModeAllowed()`) is gated on a strict
   allowlist check (`process.env.NODE_ENV === "development"`), not a denylist —
   verified against the production build output per the module's own documentation
   comment. This mechanism cannot activate in a production deployment regardless of
   cookie/env tampering, short of `NODE_ENV` itself being misconfigured at the hosting
   layer (a deployment-config concern, not a code concern).
2. The Gate 3A **permanent demo accounts** (`owner.demo@waluyo.aodp.test`,
   `admin.demo@waluyo.aodp.test`, `sales.demo@waluyo.aodp.test`, per
   `scripts/verify-demo-auth.ts`) live in a **separate Supabase project**, addressed via
   `.env.demo.local` — distinct from both local dev (`.env.local`) and any future
   production project. This is real infrastructure separation, not just a flag.
   Freeze: production onboarding must never write to or read from the demo project's
   credentials, and the demo project must never be the target of the first-owner signup
   flow once built.
3. `scripts/seed-dev.ts` is out of scope for this audit (protected dirty file per gate
   instructions) — not read, not modified, not referenced beyond acknowledging its
   existence as a dev-seed script separate from the demo project.
4. Demo accounts are **not** a production onboarding mechanism and must never become
   one — there is no code path today that conflates them (demo bypass never touches
   Supabase; demo project is credential-isolated). No gap.

---

## 6. Threat / race analysis

| Threat | Current state | Verdict |
|---|---|---|
| Two concurrent public signups → two owners of the *same* tenant | No public signup exists yet. Once built, each signup creates its own new `companies` row (§5.A.1) — there is no shared-tenant race *unless* a future implementation adds "join by slug/invite code" to public signup, which is explicitly out of scope. | N/A today; contract for future work states in §5.A.6 that a DB-level one-owner-per-company guarantee is still required as defense-in-depth even though the current design shouldn't reach it. |
| Orphan `auth.users` row (auth created, tenant provisioning failed) | No signup code exists. The proven pattern (`createSalesman`) always deletes the `auth.users` row on any downstream failure, leaving zero orphans **when followed**. Any first-owner implementation must follow the same compensating-transaction shape. | GAP — contract set, not implemented (G2/G4). |
| Duplicate tenant (same distributor signs up twice) | `companies.slug` is `UNIQUE`, but slug is generated app-side (not yet designed) — collision handling is unspecified. | GAP — flagged for the eventual signup implementation, not resolved here. |
| Cross-tenant provisioning (owner of tenant A creates a user in tenant B) | Not possible today for the `sales` path — `company_id` is always `user.company_id` from the actor's own session, never client input (§5.B.3). | No gap — but must be preserved when `admin` is added. |
| Role escalation via `user_metadata` | Proven ineffective by Gate 3B/3C integration tests (`spoofedMetadataRole` cases) and by `get_user_roles()` reading only `user_roles`/`roles`. No server code path reads `user_metadata` for authorization (confirmed by grep — zero matches outside the two forms that don't set/read a role claim there). | No gap. |
| Service-role bypass (an action using `getAdminClient()` without its own auth check) | All three current server-side `getAdminClient()` call sites perform a role check before use. | No gap in existing code. A future admin-role-add path must preserve this. |
| Metadata spoofing at signup (client sends `role: "owner"` in a request body) | No signup endpoint exists to test this against. Contract (§5.A.3): any implementation must never read a role field from the signup request at all. | GAP — contract set, not implemented. |
| Second owner via direct RPC/forged request bypassing the UI | No RPC for owner assignment exists yet. Once one exists, without a DB-level constraint, a direct call (even a legitimate one, e.g. two admins clicking "make owner" simultaneously in a hypothetical future feature) could insert two `owner` `user_roles` rows for one company — nothing in the schema prevents it today. | **GAP G1 — must be closed at the DB layer before any owner-provisioning RPC ships**, not merely at the application layer. |

---

## 7. Gaps / blockers

- **G1 — No DB-level "one owner per tenant" guarantee — RESOLVED / FROZEN (Gate
  3D-A1, 2026-08-01; clarified Gate 3D-B1-R1, 2026-08-01).** `user_roles` has no
  constraint today preventing a second `role = 'owner'` row for the same `company_id`.
  Decision (no longer open):
  - **Adopted: Option 1.** A trigger on `public.user_roles` that, when the affected
    row's `role_id` resolves to `roles.name = 'owner'`, raises an exception if a
    *different* owner row already exists for that `company_id`. Defense-in-depth —
    protects against every write path (RPC bugs, future admin tooling, direct
    service-role misuse), consistent with Gate 3B's "RLS/DB is the authoritative
    surface" precedent.
  - **The invariant is "at most one owner per company after every `user_roles`
    mutation" — not "at most one owner inserted."** A `BEFORE INSERT` trigger alone is
    the **baseline minimum**, not the full contract: it does nothing to stop an
    existing `admin`/`sales` row from being `UPDATE`d to `role_id = owner`, nor an
    existing owner row's `company_id` from being `UPDATE`d into a tenant that already
    has one. Both are second-owner-producing mutations and MUST be rejected exactly
    like a second `INSERT`. Concretely the trigger MUST fire, and re-run the same
    "owner already exists for this `company_id`" check, on:
    1. `INSERT` of a row whose `role_id` resolves to `owner`;
    2. `UPDATE` of `role_id` to a value that resolves to `owner` (regardless of the
       row's previous role);
    3. `UPDATE` of `company_id` on a row whose (new) `role_id` resolves to `owner` —
       i.e. moving an owner into a different tenant; rejected unless the destination
       tenant currently has no owner;
    4. any of the above issued by `service-role` or a direct SQL client — the trigger
       is a table-level constraint, not an RLS policy, so it has no service-role or
       "trusted caller" exemption of any kind;
    5. any of the above issued concurrently — the check MUST remain race-safe (row-lock
       the target `companies.id` before evaluating "owner already exists") for UPDATE
       exactly as it already is for INSERT; two concurrent mutations converging on the
       same destination `company_id` must serialize so at most one ever commits as
       owner.
    An `UPDATE` that does not touch `role_id`/`company_id`, or that changes them
    without the *new* role resolving to `owner`, is unaffected and MUST continue to
    succeed unmodified (e.g. changing `assigned_by`, or demoting an owner away from
    `owner`).
  - Option 2 (`SELECT ... FOR UPDATE` row-lock inside the first-owner RPC) is **not** a
    substitute for Option 1 — it only protects one call site. It MAY be added later as
    belt-and-suspenders inside the RPC itself, but the trigger alone is sufficient to
    close this gap and is non-negotiable.
  - **Sequencing lock (binding for Gate 3D-B):** this trigger is implementation item
    **#1** of Gate 3D-B — before the atomic provisioning RPC (#2) and before any signup
    UI (#3). See §7a. The trigger is not "done" for the purposes of that sequencing
    lock until it covers INSERT and UPDATE as specified above — a step-1 trigger that
    only covers INSERT does not satisfy step 1.
- **G2 — Public self-service signup is entirely unbuilt.** No route, form, action, or
  RPC. §5.A is a target contract only. Requires explicit scoping/sprint planning
  (Gate 3D-B or later) before implementation.
- **G3 — Owner-add-user only supports `role = 'sales'`.** Extending to `admin` requires
  the allowlist change described in §5.B.2 — not implemented in this gate (contract-first
  per instructions).
- **G4 — No UI/UX decision for "signup retried with an email that already has an orphaned
  `auth.users` row but no tenant."** Needs a product decision: block with a support
  contact message, or auto-resume provisioning for that same email. Not decided here.
- **G5 — Company slug generation/collision strategy for public signup is undefined.**
  `companies.slug` is `UNIQUE`; nothing in the repo generates or de-duplicates a slug
  from a signup form (the only existing caller, `createCompanyAction`, takes slug as
  direct operator input).
- **G6 — Hosted Supabase configuration gaps (cannot be verified from repo):**
  - Whether "Enable email confirmations" is on for the (not-yet-created) production
    project, and whether that setting should differ from the admin-created-user path's
    `email_confirm: true` bypass.
  - Password strength/rate-limit policy at the Supabase Auth project level (the app
    only enforces `length >= 8` client-side in `reset-password-form.tsx` and
    `add-salesman-form.tsx`).
  - Whether a production Supabase project even exists yet — `CLAUDE.md` states
    `.env.local` currently points at the FlowSalesAI project and "wajib diganti ke
    project AODP sebelum operasi tulis/migration." No production project reference was
    found in this repo.
- **G7 — Product-decision conflict — RESOLVED / FROZEN (Gate 3D-A1, 2026-08-01,
  Founder-confirmed):** the gate brief states "Tidak ada superadmin," while
  `super_admin` is a real, actively used system role (seeded in
  `20260626000002_create_users_roles_permissions.sql`, referenced as an RLS/RPC bypass
  role throughout Gate 3B and multiple other migrations, and used today as the sole gate
  on `/dashboard/platform` tenant-provisioning tooling in `tenant-actions.ts`). Removing
  it entirely would be a large-blast-radius architecture change touching many
  already-locked migrations. **Founder-confirmed interpretation, now FROZEN contract:**
  "no superadmin" means *no tenant/company can ever contain, produce, or expose a
  `super_admin` through any tenant-facing flow*. Specifically, `super_admin`:
  - MUST NEVER appear, be selectable, or be creatable via: **public signup**; **any
    tenant UI**; **any role selector** shown to a tenant user; **tenant membership**
    (a `user_roles` row scoped to a `company_id` must never resolve to `super_admin`);
    or **owner-add-user** (`createSalesmanAction` / its future `admin` extension).
  - Remains solely an AODP-internal, platform-level operator role, reachable only from
    `/dashboard/platform` (already true today, confirmed by this gate's audit — §1).
  - **Owner-manageable roles are exactly `{admin, sales}`** (§5.B.2) — `owner` is never
    assignable by another user; it is produced exactly once per tenant, only by the
    first-owner signup flow (§5.A).
  This closes G7. No further confirmation round is required before Gate 3D-B; the
  boundary above is binding acceptance criteria for every Gate 3D-B/C implementation
  and its tests (§8, item 7).

---

## 7a. Gate 3D-B locked implementation order (binding — Gate 3D-A1 amendment)

Gate 3D-B MUST be implemented and merged in this exact order. Each step's own tests
(§8) must pass before the next step begins; no step may be skipped, reordered, or
built in parallel ahead of an earlier step:

1. **Database single-owner enforcement (closes G1).** The `BEFORE INSERT OR UPDATE`
   trigger on `public.user_roles` described in G1 (§7) — covering INSERT, UPDATE of
   `role_id`, and UPDATE of `company_id`, race-safe, and binding on service-role/direct
   SQL. Migration-only — no application code depends on it yet, so it lands and is
   tested (§8, Gate 3D-B item 0) independently and first.
2. **Atomic provisioning RPC.** The first-owner provisioning logic (§5.A.2) implemented
   as a `SECURITY DEFINER` RPC/transaction that is atomic and **fail-closed**: any
   failure after the `auth.users` row is created rolls back (deletes) both the
   `auth.users` row and the `companies` row, leaving zero orphans (§8, Gate 3D-B item
   4). The RPC must re-derive and re-check authorization/role assignment inside its own
   body per §4's "Database" trust-boundary rule — never trust a client parameter for
   role or `company_id`. This step depends on step 1 already being live, so a
   concurrent or forged call attempting a second owner insert is rejected at the DB
   layer even if the RPC itself has a bug.
3. **Signup UI.** The public signup form/route calling the RPC from step 2. This is the
   last step — no signup UI may be built, merged, or exposed before steps 1 and 2 are
   both complete and their tests are green.

Rationale: this ordering makes the DB the enforcement point before any user-facing
surface exists to exploit its absence, matching Gate 3B's precedent that RLS/DB is the
authoritative surface, not the application layer.

---

## 8. Test matrix — Gate 3D-B through 3D-D

Scope note: these are **planned** test surfaces for the implementation gates that follow
this contract freeze. None exist yet; listed here so 3D-B/C/D can be scoped directly
against this contract without re-deriving it.

### Gate 3D-B — First owner signup (G1/G7 resolved by Gate 3D-A1 — see §7/§7a; G2/G5/G6
still require resolution before/during implementation)

0. **[G1 acceptance criteria — migration-only, runs before any RPC or UI code exists,
   per §7a step 1]** Direct SQL insert of a second `user_roles` row with
   `role = 'owner'` for a `company_id` that already has an owner → the trigger raises
   and the insert is rejected, independent of any RPC or application code. This
   criterion additionally covers the UPDATE-bypass surface (Gate 3D-B1-R1): promoting
   an existing `admin`/`sales` row to `owner` in a company that already has one, and
   moving an existing owner's `company_id` into a company that already has one, are
   both rejected identically; a same-row UPDATE that doesn't change the effective
   owner/company outcome (no-op role/company update, or an unrelated column change)
   is unaffected; and every case holds for service-role/direct SQL and under
   concurrent UPDATE/INSERT racing toward the same destination company.
1. Successful signup creates exactly one `companies` row, one `auth.users` row, one
   `public.users` row, and exactly one `user_roles` row with role `owner`.
2. Role/company_id cannot be influenced by request body or `user_metadata` — attempt to
   pass `role: "owner"`/`role: "admin"`/arbitrary `company_id` in the request is ignored
   or rejected.
3. Two concurrent signups with the same email → exactly one succeeds; the other gets a
   clear "already registered" outcome, not a duplicate tenant or duplicate owner.
4. Simulated failure after `auth.users` creation (e.g., forced profile-insert failure)
   → `auth.users` row and the just-created `companies` row are both gone afterward (no
   orphan).
5. Direct RPC/forged call attempting to insert a second `owner` `user_roles` row for an
   existing `company_id` → rejected at the DB layer (**G1 acceptance criteria** — proves
   the Option 1 trigger adopted in §7).
6. Email confirmation behavior matches whatever hosted-config decision closes G6
   (either: unconfirmed users cannot reach `/dashboard`, or confirmation is intentionally
   skipped — whichever is decided, not assumed).
7. **G7 acceptance criteria.** Automated check (grep/lint rule or integration test)
   confirms: (a) no public signup, tenant UI, role selector, tenant-membership path, or
   owner-add-user path can select, assign, or produce `role = 'super_admin'`; (b) the
   owner-add-user role allowlist is exactly `{admin, sales}`; (c) `super_admin` remains
   reachable only from `/dashboard/platform`.

### Gate 3D-C — Owner adds admin/sales
1. Owner creates an `admin` user → exactly one `owner`-actor-authorized atomic creation,
   `company_id` always the owner's own tenant, role stored is exactly `admin`.
2. Owner creates a `sales` user → unchanged from existing `createSalesmanAction`
   behavior (regression check only).
3. Attempt to create a user with `role: "owner"` via this flow → rejected by allowlist,
   regardless of who calls it.
4. Non-owner actor (admin, manager, sales, super_admin, spoofed `user_metadata` role) →
   all rejected, mirroring the existing Gate 3B spoofed-metadata test pattern.
5. Cross-tenant attempt (owner of tenant A supplies/implies tenant B) → rejected;
   `company_id` is never accepted from client input.
6. Partial-failure rollback for the `admin` path (simulate role-assignment failure) →
   `auth.users` row deleted, no orphan — regression-equivalent to the existing
   `sales` rollback test.
7. Deactivation/reactivation and role change for an `admin` target → owner-only,
   fail-closed on invalid/foreign target, audit-logged — same shape as
   `setSalesmanActiveStatusAction`.

### Gate 3D-D — Recovery & demo/production boundary regression
1. Forgot-password for a nonexistent email → generic success response (no oracle),
   consistent with current Supabase behavior — regression check.
2. Reset-password does not alter `company_id`, `user_roles`, or `is_active` — regression
   check against current `updateUser({ password })`-only behavior.
3. Deactivated user completes a password reset successfully but is still redirected to
   `/login` on next dashboard access — regression check against Gate 3A/3C fail-closed
   behavior.
4. `redirectTo` cannot be overridden to an external/off-allowlist domain — regression
   check (currently trivially true; re-verify if `redirectTo` is ever parameterized).
5. Demo bypass cookie cannot grant access when `NODE_ENV !== "development"` — regression
   check against `isDemoModeAllowed()`.
6. Production first-owner signup (once built) cannot target the demo Supabase project,
   and demo credentials/env (`.env.demo.local`) are never read by the production signup
   path — config-isolation check, not a runtime code check.

---

## 9. Summary

```
RESULT: GAP FOUND
BASELINE: main @ 36353c7171760bb5a996b435ccc7b430cfce94fc (== origin/main)
EXISTING AUTH/PROVISIONING FINDINGS: login/forgot/reset/signout fully built and
  fail-closed; role always DB-sourced, never user_metadata; OAuth callback fully
  removed; owner-add-user exists but is hardcoded to role=sales; first-owner/public
  signup does not exist anywhere in the codebase — closest analog is an internal
  super_admin-only platform tool (tenant-actions.ts) that manually provisions the
  first user with an operator-set temp password.
CANONICAL SOURCES: tenant=companies.id; membership=user_roles row; role=roles.name via
  user_roles join; onboarding/active=users.is_active (NULL-propagating fail-closed since
  Gate 3A); "tenant has an owner"=NO canonical source today (gap).
FROZEN FIRST-OWNER CONTRACT: target-only (§5.A) — atomic compensating-transaction
  provisioning, role never client-supplied, one-owner-per-tenant must be enforced at
  DB level before implementation (G1).
FROZEN USER-PROVISIONING CONTRACT: owner-only, allowlist role in {admin,sales}, tenant
  id always server-derived, reuse existing temp-password compensating-workflow pattern
  (§5.B) — sales path already matches this exactly; admin path needs the allowlist
  extension (G3).
RECOVERY CONTRACT: generic outcome (already true via Supabase default), fixed
  same-origin redirect only, password-only mutation, fail-closed for inactive/no-
  membership users after reset — all confirmed already correct in existing code, no
  gap.
DEMO/PRODUCTION SEPARATION: demo bypass is a strict allowlist on NODE_ENV=development;
  demo accounts live in a separate Supabase project via .env.demo.local; no code path
  conflates demo with production onboarding. No gap.
THREAT/RACE ANALYSIS: see §6. Primary unresolved risk is G1 (no DB-level one-owner-per-
  tenant guarantee) — must close before any owner-provisioning RPC ships.
GAPS/BLOCKERS: G1 **RESOLVED/FROZEN** (Gate 3D-A1 — DB-level owner-uniqueness trigger
  adopted, locked as Gate 3D-B implementation item #1, §7/§7a), G2 (signup unbuilt),
  G3 (admin provisioning unbuilt), G4 (orphan-retry UX undecided), G5 (slug strategy
  undecided), G6 (hosted Supabase config unknown — confirmation setting, password
  policy, production project existence), G7 **RESOLVED/FROZEN** (Gate 3D-A1 —
  Founder-confirmed super_admin boundary, §7).
TEST MATRIX: §8 (Gate 3D-B/C/D planned surfaces; item 0 and item 7 are the G1/G7
  acceptance criteria added by Gate 3D-A1).
CHANGED FILES: docs/product/auth/AODP_GATE_3D_A_ONBOARDING_PROVISIONING_CONTRACT.md
  (new at Gate 3D-A; amended by Gate 3D-A1, see §10).
COMMIT: Gate 3D-A1 amends the existing Gate 3D-A commit in place (documentation-only,
  this file only; the pre-existing dirty files remain excluded and untouched).
DIRTY FILES PRESERVED: CLAUDE.md, docs/sales-kit/00_INDEX.md, scripts/seed-dev.ts
  (modified, untouched); docs/document-engine/assets/samples/waluyo/logo-pt-sumber-
  warna-alam-sudiada.jpeg, docs/sales-kit/demo-movie/ (untracked, untouched).
NEXT: Push the amended commit fast-forward, then LOCK Gate 3D-A. Proceed to Gate 3D-B
  in the order locked by §7a: (1) DB single-owner enforcement, (2) atomic provisioning
  RPC, (3) signup UI.
```

---

## 10. Amendment log

### Gate 3D-A1 (2026-08-01) — Contract Amend Only

Closed G1 and G7 as unresolved items, per explicit Founder instruction, without writing
any migration, RPC, runtime code, test implementation, seed, or signup UI:

- **G1** — adopted Option 1 (DB-level `BEFORE INSERT` trigger on `public.user_roles`)
  as the binding decision, and locked it as the mandatory first implementation item of
  Gate 3D-B (§7a).
- **G7** — Founder confirmed the audit's working interpretation of "no superadmin" as
  final contract: `super_admin` is an AODP-internal platform role, never reachable
  through any tenant-facing flow (public signup, tenant UI, role selector, tenant
  membership, owner-add-user); owner-manageable roles remain exactly `{admin, sales}`.
- Added §7a locking the Gate 3D-B implementation order: (1) DB single-owner
  enforcement, (2) atomic fail-closed provisioning RPC, (3) signup UI — in that order,
  no step skipped or reordered.
- Added explicit acceptance-criteria test items (§8, Gate 3D-B items 0 and 7) for G1
  and G7.

G2–G6 remain open and unresolved; they stay contract-only pending Gate 3D-B+
implementation and are not affected by this amendment.

### Gate 3D-B1-R1 (2026-08-01) — Contract Clarification (UPDATE Enforcement)

Founder identified that the Gate 3D-B1 `BEFORE INSERT` trigger, while satisfying the
letter of G1's original "adopted: Option 1" text, left an UPDATE-shaped bypass of the
same invariant: `UPDATE user_roles SET role_id = <owner>` or `UPDATE user_roles SET
company_id = <target>` on an existing owner row could still produce a second owner for
a company without ever going through `INSERT`. Clarified, without changing the adopted
mechanism (still a trigger on `public.user_roles`, still `unique_violation`/23505, still
migration-only):

- The single-owner invariant is **"at most one owner per company after every
  `user_roles` mutation,"** not merely "at most one owner inserted." `BEFORE INSERT` is
  the baseline minimum the original text described, not a license to leave `UPDATE`
  unguarded.
- Enforcement is now explicitly required to cover: INSERT of an owner row; UPDATE of
  `role_id` to `owner`; UPDATE of `company_id` that moves an owner into an
  already-owned company; service-role/direct SQL (no exemption, ever); and concurrent
  mutations (race-safe via the existing per-company row-lock pattern, extended to the
  UPDATE paths).
- No change to: the adopted mechanism (still a single trigger function, still
  `AODP_SINGLE_OWNER_VIOLATION` / SQLSTATE 23505), the Gate 3D-B step ordering (§7a:
  DB enforcement → atomic provisioning RPC → signup UI), or the `super_admin`
  boundary (G7). This amendment only closes a gap in how completely step 1 of §7a
  must be implemented before step 2 may begin.
- See §7 (G1) and §8 (Gate 3D-B item 0) for the updated normative text and acceptance
  criteria. Implementation repair tracked as a separate commit
  (`fix(auth): close single-owner update bypass`) against the same migration file
  introduced by Gate 3D-B1, per Founder instruction not to amend the already-committed
  Gate 3D-B1 commit.
