# PRD — AI Operating Distributor Platform v1.0

## 1. Background

Distributor kecil-menengah sering memiliki proses bisnis yang masih bergantung pada WhatsApp, laporan manual sales, catatan piutang, dan kontrol owner secara langsung. Risiko utama yang muncul adalah fraud, barang hilang, diskon bocor, sales tidak produktif, order tidak ter-follow-up, dan piutang mulai macet tanpa early warning.

AODP dibuat sebagai AI Operating System untuk membantu owner distributor menjaga bisnis tetap aman dan mengambil keputusan harian dengan cepat.

## 2. Goals

- Membuat owner bisa melihat kondisi bisnis harian secara cepat.
- Mengurangi order hilang dari WhatsApp.
- Memantau performa sales harian.
- Mendeteksi customer yang berubah perilaku.
- Membantu collection dan reminder pembayaran.
- Memberi alert fraud/risk seperti diskon tidak wajar, invoice mencurigakan, atau quantity mismatch.

## 3. Non Goals

- Tidak membuat accounting system penuh.
- Tidak membuat warehouse kompleks di MVP.
- Tidak membuat HR/payroll.
- Tidak membuat finance reconciliation penuh.

## 4. Target User

### Primary User

Owner distributor.

### Secondary User

- Admin sales
- Salesman
- Collection staff
- Gudang (future)

## 5. MVP Modules

### 5.1 Core Platform

- Login
- Role & permission sederhana
- Master customer
- Master product
- Master sales
- Dashboard owner
- Notification center
- Executive WhatsApp report structure

### 5.2 WhatsApp AI

- Capture incoming order
- Auto reply basic
- Missed call follow-up template
- Customer qualification
- Repeat order reminder
- Complaint tagging
- Summary report

### 5.3 FlowSales AI

- Sales daily report input
- Target OA
- Target omzet
- Pencapaian harian
- Area visit
- Product sold list
- Sales performance dashboard
- AI sales summary

### 5.4 Collection Intelligence

- Customer credit list
- Due date monitoring
- Aging AR
- Payment behavior change detection
- Reminder status
- Promise to pay

### 5.5 Business Guard AI

- Discount anomaly
- Customer behavior change
- Quantity mismatch placeholder
- Sales risk indicator
- Transaction risk score
- Executive alert

## 6. MVP Success Metrics

- Owner receives daily executive report.
- Sales report can be input and summarized.
- Customer repeat order risk can be detected.
- Collection aging can be monitored.
- At least 3 risk alerts are generated from transaction data.

## 7. First Version UX

Keep menu minimal:

1. Dashboard Owner
2. WhatsApp Inbox / Leads
3. Sales Report
4. Collection
5. Risk Alert
6. Master Data
7. Settings

## 8. Pricing Context

The locked pricing model:

- Owner Protection Lite: Rp1.990.000/month
- Owner Protection: Rp2.990.000/month
- Enterprise: Custom

Setup fee:

- Micro: Rp5.000.000
- Small: Rp10.000.000
- Medium: Rp20.000.000
- Enterprise: Custom
