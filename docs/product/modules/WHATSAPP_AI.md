# Module Spec — WhatsApp AI

## Purpose

WhatsApp AI adalah front office distributor. Modul ini membantu menangkap order, menjawab chat dasar, melakukan follow-up missed call, mendeteksi repeat order yang hilang, dan membuat ringkasan untuk owner.

## Core Use Cases

1. Customer chat ingin order.
2. Customer bertanya stok/harga.
3. Nomor baru masuk dan perlu dikualifikasi.
4. Customer biasa order tetapi belum order.
5. Customer telepon tetapi tidak terjawab.
6. Customer komplain barang kurang/rusak.

## MVP Features

- Conversation list
- Customer identification
- Order intent detection
- Complaint intent detection
- Missed call follow-up template
- Repeat order reminder queue
- WhatsApp daily summary

## AI Jobs

- classifyWhatsAppMessage
- extractOrderItems
- detectCustomerIntent
- generateReplySuggestion
- generateDailyWhatsAppSummary

## Owner Report Metrics

- Chat masuk
- Order baru
- Calon customer
- Komplain
- Missed call
- Belum dibalas
- Estimasi order value
