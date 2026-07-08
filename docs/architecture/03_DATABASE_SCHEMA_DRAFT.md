# Database Schema Draft — AODP MVP

## organizations

- id
- name
- business_type
- created_at

## users

- id
- organization_id
- name
- email
- phone
- role
- created_at

## customers

- id
- organization_id
- name
- area
- address
- customer_type
- credit_limit
- status
- created_at

## customer_contacts

- id
- customer_id
- name
- phone
- relationship_role
- is_primary
- created_at

## products

- id
- organization_id
- sku
- name
- unit
- base_price
- status

## salespersons

- id
- organization_id
- name
- phone
- area
- status

## sales_reports

- id
- organization_id
- salesperson_id
- report_date
- target_oa
- achieved_oa
- target_revenue
- achieved_revenue
- gap_revenue
- remaining_working_days
- area
- discount_amount
- grand_total
- ai_summary
- created_at

## sales_report_items

- id
- sales_report_id
- product_id
- product_name_snapshot
- quantity
- unit
- value

## invoices

- id
- organization_id
- customer_id
- salesperson_id
- invoice_number
- invoice_date
- due_date
- total_amount
- discount_amount
- status

## payments

- id
- invoice_id
- payment_date
- amount
- method
- note

## whatsapp_conversations

- id
- organization_id
- customer_id
- phone
- last_message_at
- status
- intent

## whatsapp_messages

- id
- conversation_id
- direction
- message_text
- message_type
- ai_intent
- created_at

## risk_alerts

- id
- organization_id
- severity
- category
- title
- description
- entity_type
- entity_id
- recommended_action
- status
- created_at

## discount_rules

- id
- organization_id
- product_id
- area
- customer_type
- max_discount_percent
- start_date
- end_date
- status
