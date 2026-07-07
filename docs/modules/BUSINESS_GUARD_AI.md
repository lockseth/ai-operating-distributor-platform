# Module Spec — Business Guard AI

## Purpose

Business Guard AI adalah hero module untuk menjaga owner tetap aman dari fraud, kebocoran diskon, quantity mismatch, perilaku mencurigakan, dan transaksi high risk.

## Core Use Cases

1. PO 300 dus, pabrik kirim 300 dus, customer hanya menerima 150 dus.
2. Diskon bocor dan melebar ke banyak sales.
3. Customer tiba-tiba berubah PIC order.
4. Sales memberi diskon di luar aturan.
5. Retur atau cancel invoice tidak wajar.

## MVP Features

- Risk alert list
- Discount rule monitoring
- Customer behavior change alert
- Transaction risk score
- Sales risk indicator
- Executive risk summary

## AI Jobs

- detectDiscountAnomaly
- detectBehaviorChange
- calculateTransactionRiskScore
- generateRiskExplanation
- generateOwnerActionRecommendation

## Risk Categories

- Discount Risk
- Customer Risk
- Sales Risk
- Collection Risk
- Delivery Risk
- Warehouse Risk

## Alert Format

- Alert title
- Severity: low / medium / high / critical
- Entity involved
- Reason
- Recommended action
- Status: open / investigating / resolved
