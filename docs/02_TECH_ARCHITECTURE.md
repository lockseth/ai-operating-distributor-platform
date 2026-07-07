# Technical Architecture — AODP v1.0

## Recommended Stack

- Frontend: Next.js App Router
- Language: TypeScript
- Styling: Tailwind CSS
- Database: Supabase PostgreSQL
- Auth: Supabase Auth or custom auth using Supabase
- ORM: Prisma or Supabase client
- AI Layer: provider-agnostic AI service
- Messaging: WhatsApp Business API / webhook-ready abstraction
- Deployment: Vercel or VPS

## Architecture Principle

The system must be modular, but MVP should stay simple.

Suggested folder structure:

```txt
app/
  dashboard/
  whatsapp/
  sales/
  collection/
  risk/
  master-data/
  settings/
  api/
components/
lib/
  ai/
  auth/
  db/
  modules/
    whatsapp/
    flowsales/
    collection/
    business-guard/
  notifications/
  reports/
docs/
types/
```

## Core Entities

- Organization
- User
- Role
- Customer
- CustomerContact
- Product
- Salesperson
- SalesReport
- SalesReportItem
- Invoice
- Payment
- CollectionCase
- WhatsAppConversation
- WhatsAppMessage
- RiskAlert
- DiscountRule
- ProductPrice
- Area

## AI Layer

Create provider-agnostic AI functions:

- summarizeSalesReport()
- detectRepeatOrderRisk()
- detectPaymentBehaviorChange()
- detectDiscountAnomaly()
- generateExecutiveReport()
- classifyWhatsAppMessage()

AI output must be structured JSON where possible.

## Notification Layer

Support channels:

- In-app notification
- WhatsApp executive report
- Email optional later

## Security

- Role based access control
- Organization isolation
- Audit log for important actions
- Sensitive discount config protected
- Business Guard alerts cannot be deleted by sales users

## MVP Database Priority

Build only tables needed for MVP:

1. organizations
2. users
3. customers
4. customer_contacts
5. products
6. salespersons
7. sales_reports
8. sales_report_items
9. invoices
10. payments
11. whatsapp_conversations
12. whatsapp_messages
13. risk_alerts
14. discount_rules
