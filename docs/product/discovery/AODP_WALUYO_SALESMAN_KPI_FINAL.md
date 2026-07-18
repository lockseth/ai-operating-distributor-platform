# AODP Waluyo — Salesman KPI Final

**Status:** FINAL — LOCKED
**Effective date:** 18 Juli 2026
**Source:** Rekaman dan klarifikasi Pak Waluyo, 16–18 Juli 2026

## Active KPI

Waluyo saat ini menggunakan tepat dua target Salesman:

1. `CALL` — kunjungan operasional valid ke toko assignment/coverage.
2. `EFFECTIVE_CALL` — Call valid yang menghasilkan Sales Order `confirmed` dengan `order_source = FIELD_VISIT`.

Formula achievement belum diimplementasikan pada Configurable KPI Foundation. Pada phase Achievement Integration:

- `call_achievement = valid_calls / call_target × 100%`
- `ec_achievement = effective_calls / ec_target × 100%`
- `ec_rate = effective_calls / valid_calls × 100%` — insight, bukan KPI ketiga.

Kedua KPI berdiri sendiri. Waluyo tidak memakai weighted/composite score.

## AR Regulation

AR/Collection bukan KPI salesman karena penjualan Waluyo didominasi cash. Penagihan adalah regulasi yang melekat pada kunjungan:

1. AI memeriksa invoice outstanding/jatuh tempo sebelum kunjungan.
2. Faktur dilampirkan pada visit task Telegram.
3. Salesman membawa faktur dan menagih saat kunjungan.
4. Outcome dicatat dan direkonsiliasi.
5. Titipan uang tetap `unverified` sampai bukti lengkap.

Kegagalan toko membayar tidak menurunkan Call/EC. Operational compliance hanya menilai apakah task dijalankan dan outcome dicatat dengan benar.

## Remote Order

Order dari telepon/WhatsApp pelanggan tetap dimasukkan Salesman melalui Telegram. Order tersebut sah, tetapi tidak dihitung sebagai EC karena tidak memiliki Call induk. `sales_orders.order_source` menjadi sumber pembeda.

## Foundation Boundary

Configurable KPI Foundation hanya membangun:

- tenant KPI catalog `CALL` dan `EFFECTIVE_CALL`;
- period `DRAFT → ACTIVE → LOCKED`;
- target per Salesman/periode;
- versioning, change reason, audit trail, RLS, dan tenant isolation.

Tidak termasuk achievement measurement, score, ranking, dashboard, WhatsApp report, atau AR visit-task execution. Semua itu masuk phase berikutnya.
