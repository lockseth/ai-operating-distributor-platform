# Module Spec — FlowSales AI

## Purpose

FlowSales AI membantu owner memantau performa sales, target OA, omzet, area visit, produk terjual, repeat order, dan rekomendasi action.

## Core Use Cases

1. Sales input laporan harian.
2. Owner melihat pencapaian OA dan omzet.
3. AI membuat summary performa sales.
4. AI mendeteksi outlet yang biasa order tapi belum order.
5. AI memberi rekomendasi follow-up.

## MVP Features

- Sales target input
- Daily report input
- Product sold item list
- Area visit
- OA achievement
- Omzet achievement
- Gap calculation
- Remaining working day field
- Sales ranking
- AI sales summary

## Example Report Fields

- Report date
- Target OA
- OA achieved
- Target omzet
- Omzet achieved
- Gap
- Remaining working days
- Salesperson
- Area
- Product items
- Total value
- Discount
- Grand total

## AI Jobs

- summarizeSalesPerformance
- calculateSalesGap
- predictMonthEndAchievement
- recommendSalesAction
- detectRepeatOrderRisk
