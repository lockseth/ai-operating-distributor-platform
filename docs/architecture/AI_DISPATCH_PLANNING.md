# AI Dispatch Planner — Order-to-Delivery Planning MVP

Referensi: AODP Waluyo — AI Order-to-Delivery Planning MVP Gate (2026-07-16).
Modul: `apps/web/src/lib/dispatch/`. Migration: `20260721000001_dispatch_planning.sql`.

## 1. Prinsip

AI adalah default operator untuk keputusan yang dapat ditentukan dari Business
Policy + Operational Data. Human hanya override ketika AI tidak punya
confidence atau ada operational exception. "AI" di modul ini adalah
**deterministic rule engine** (`planDispatch()` di `lib/dispatch/service.ts`),
bukan panggilan LLM — konsisten dengan pola yang sudah ada di
`lib/delivery/service.ts` (`computeInvoiceEligibility`, `requiresOwnerAlert`).
`confidence_score` merefleksikan kelengkapan data & kedekatan ke threshold
tenant policy, bukan probabilitas model statistik.

Workflow yang diimplementasikan:

```
Sales Order (confirmed)
        ↓
AI Dispatch Planner (planDispatch)
        ↓
  Bersih -> SCHEDULED                    Conflict -> WAITING_STOCK /
                                          CUSTOMER_REQUESTED_DELAY /
                                          ROUTE_CONFLICT -> Human Override
        ↓                                             ↓
        └──────────────── SCHEDULED ────────────────┘
                        ↓
              READY_FOR_DELIVERY
                        ↓
     (existing) createDeliveryAction -> Delivery Verification
```

## 2. Batas modul yang penting

- Dispatch Planning **berhenti** di status `ready_for_delivery`. Eksekusi
  pengiriman sesungguhnya (dispatch fisik, evidence, rekonsiliasi quantity)
  tetap sepenuhnya milik modul Delivery Verification yang sudah ada
  (`deliveries`/`delivery_items`, PASS). `dispatch_plans` TIDAK menduplikasi
  `deliveries.status` atau `sales_orders.status` — ini lapisan perencanaan
  yang terpisah dan feed ke modul yang sudah ada, bukan menggantikannya.
- Faktur dan Surat Jalan **belum ada implementasinya** di codebase (hanya
  `docs/document-engine/constitution/*` — standar/spesifikasi, tanpa kode).
  MVP ini memakai `sales_orders.status = 'confirmed'` sebagai sinyal
  "document ready" pengganti sementara. Ini asumsi eksplisit, bukan
  implementasi Document Engine — lihat Known Limitations di laporan gate.
- Tidak ada RPC/`SECURITY DEFINER` baru. Idempotency dijamin murni oleh
  `UNIQUE(company_id, sales_order_id)` di `dispatch_plans` — tidak ada
  aggregate cross-row invariant seperti delivery quantity yang memerlukan
  row-locked function, sehingga tidak menambah kelas risiko yang diaudit di
  Global SQL Routine Exposure Gate.

## 3. Planning Rules (prioritas evaluasi)

Satu order = satu alasan keputusan (tidak overload satu status):

1. **Customer Requested Delivery Date** — bila `sales_orders.requested_delivery_date`
   berbeda dari tanggal kandidat yang sedang dievaluasi, AI **menghormati**
   tanggal customer (bukan memaksa tanggal lain). Status: `customer_requested_delay`,
   confidence tinggi (bukan uncertainty, murni instruksi eksplisit).
2. **Available To Promise** — `System Stock (products.stock_quantity) - Reserved
   (agregat dispatch_plans aktif lain) + Expected Incoming (belum ada sumber
   data, default 0)`. Kurang dari qty dipesan -> `waiting_stock`.
3. **Tonase / Route Conflict** — hanya dicek bila tenant menetapkan
   `dispatch_planning.max_tonnage_per_route_kg` di `settings`. Produk tanpa
   `weight_kg` dikecualikan dari cek (bukan dianggap 0kg), menurunkan
   confidence score.
4. Bersih -> `scheduled`, grouping `delivery_group_key = "{area}|{date}"`
   (grouping sederhana, BUKAN route optimization/GPS — phase berikutnya).

Actor assignment: `dispatch_planning.default_actor_strategy` (`settings`,
per-tenant) — `"order_salesperson"` (auto-assign salesperson pemilik order,
model tenant Waluyo: salesman = order actor + delivery actor) atau
`"unassigned"` (default aman, human assign manual — model tenant dengan
driver terpisah). **Tidak pernah di-hardcode global** — lihat Waluyo
Discovery Calibration Report v2.0 §E.

## 4. Human Override & Learning

`overrideDispatchPlan()` — satu fungsi generik untuk kelima aksi manusia
(reschedule/regroup/reassign_actor/hold/force_dispatch). Alasan **wajib**
(non-empty, divalidasi). Setiap override:

- diaudit di `dispatch_plan_events` (`is_ai_decision = false`);
- menjadi `knowledge_candidates` (`candidate_type = 'dispatch_planning_override'`,
  status `pending` — **tidak otomatis dipelajari**, menunggu review manusia,
  pola identik koreksi "UBAH" pada sales order Telegram).

## 5. Stock Model

Dipisahkan secara konsep sesuai insight Waluyo — **tidak memakai satu angka
stok**:

| Konsep | Sumber MVP ini |
|---|---|
| System Stock | `products.stock_quantity` (sudah ada) |
| Physical Stock | **Belum ada** — tidak ada cycle-count/stock-take. System Stock dipakai sebagai satu-satunya sumber, Known Limitation eksplisit. |
| Reserved Stock | Dihitung on-the-fly dari `sales_order_items` milik `dispatch_plans` lain yang masih aktif (bukan tabel reservasi persisten) |
| Expected Incoming | Field input planner (`expectedIncomingByProduct`) — arsitektur siap menerima, **belum ada sumber data** (tidak ada modul purchase-order/incoming-shipment) — default `{}` |
| Available To Promise | `System Stock - Reserved + Expected Incoming` |

## 6. Tenant Policy (`settings`, key/value JSONB, mekanisme sudah ada)

- `dispatch_planning.max_tonnage_per_route_kg`
- `dispatch_planning.min_order_value_for_same_day`
- `dispatch_planning.default_actor_strategy`

Tidak ada kolom skema formal baru untuk policy ini — reuse `settings` yang
sudah ada, sesuai rekomendasi Waluyo Discovery Calibration Report v2.0 §I.
