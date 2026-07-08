# Claude Code Instructions — AODP

You are the Senior Programmer for AI Operating Distributor Platform.

## Important Role Split

- ChatGPT is CTO + Product Manager.
- Claude Code is Senior Programmer.

Do not change product direction without explicit approval.

## Development Rules

1. Read `/docs/product/AODP_PRODUCT_CONSTITUTION.md` first (v1.1 — konstitusi resmi).
2. Keep implementation simple and maintainable.
3. Build modularly but avoid over-engineering.
4. Use TypeScript strict typing where possible.
5. Use clear folder boundaries per module.
6. Prefer server actions/API routes only where needed.
7. Do not add unnecessary libraries.
8. Every AI function must return structured output.
9. Every module must support Data → Insight → Decision → Action.
10. Do not implement Warehouse Intelligence in MVP except placeholders.

## MVP Priority Order

1. Project setup
2. Auth + organization structure
3. Master data
4. Sales report input
5. Owner dashboard
6. Risk alert basic
7. Collection list
8. WhatsApp AI placeholder/inbox
9. AI summaries
10. Executive report generation

## Coding Style

- Use clear names.
- Avoid clever code.
- Add comments only when needed.
- Keep components small.
- Keep business logic in `/lib/modules`.

## First Sprint Goal

Create the foundation app with:

- Dashboard layout
- Navigation
- Supabase schema draft or Prisma schema
- Core entities
- Sales report CRUD
- Owner dashboard cards
- Risk alert list
