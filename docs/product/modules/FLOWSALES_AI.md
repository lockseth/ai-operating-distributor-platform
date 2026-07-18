# Module Spec — FlowSales AI

## Purpose

FlowSales AI membantu owner memantau performa sales, target Call dan Effective Call (EC), omzet sebagai insight, area visit, produk terjual, repeat order, dan rekomendasi action.

Untuk Waluyo, kontrak KPI aktif mengikuti `docs/product/discovery/AODP_WALUYO_SALESMAN_KPI_FINAL.md`: hanya `CALL` dan `EFFECTIVE_CALL`. Istilah OA pada implementasi laporan harian lama bersifat legacy/compatibility dan bukan sumber konfigurasi KPI resmi.

## Core Use Cases

1. Sales input laporan harian.
2. Owner melihat pencapaian Call dan EC; omzet tetap menjadi insight operasional.
3. AI membuat summary performa sales.
4. AI mendeteksi outlet yang biasa order tapi belum order.
5. AI memberi rekomendasi follow-up.

## MVP Features

- Configurable Call and EC target input
- Daily report input
- Product sold item list
- Area visit
- Call achievement
- Effective Call achievement
- EC Rate insight
- Gap calculation
- Remaining working day field
- Sales ranking
- AI sales summary

## Example Report Fields

- Report date
- Target Call
- Call achieved
- Target EC
- EC achieved
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
