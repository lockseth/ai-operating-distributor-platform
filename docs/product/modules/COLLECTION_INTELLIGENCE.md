# Module Spec — Collection Intelligence

## Purpose

Collection Intelligence membantu owner mengendalikan piutang, aging AR, reminder, promise to pay, dan perubahan perilaku pembayaran customer.

## Core Use Cases

1. Customer mulai telat bayar.
2. Customer yang dulu lancar menjadi batuk-batuk.
3. PIC order berubah dari suami ke istri.
4. Toko mulai kecil order sebelum macet.
5. Collection butuh prioritas penagihan.

## MVP Features

- Customer credit active list
- Invoice due date
- Aging bucket
- Payment history
- Payment behavior score
- Promise to pay
- Reminder log
- Collection priority list

## AI Jobs

- detectPaymentBehaviorChange
- scoreCustomerCollectionRisk
- generateReminderMessage
- summarizeCollectionDaily

## Risk Signals

- Payment delay increasing
- Order value decreasing
- Order PIC changed
- WhatsApp number changed
- Promise to pay broken
- Invoice overdue multiple times
