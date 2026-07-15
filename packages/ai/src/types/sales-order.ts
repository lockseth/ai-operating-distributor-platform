// =============================================================================
// Structured AI Output Contract — Sales Order Extraction
// Kontrak lintas-channel (Telegram, dan nanti WhatsApp) untuk hasil ekstraksi
// order dari teks bebas. Implementasi ekstraksi TIDAK tinggal di sini —
// lihat apps/web/src/lib/sales-orders/extraction.ts. File ini hanya
// mendefinisikan bentuk output terstruktur, konsisten dengan aturan:
// "Setiap fungsi AI wajib mengembalikan output terstruktur (JSON)".
// =============================================================================

export type DiscountType = "percentage" | "nominal";

export interface ExtractedSalesOrderItem {
  productName: string;
  productCode: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  discountType: DiscountType | null;
  discountValue: number | null;
  subtotal: number | null;
}

export interface ExtractedSalesOrder {
  customer: {
    name: string | null;
    code: string | null;
  };
  items: ExtractedSalesOrderItem[];
  deliveryNote: string | null;
  missingFields: string[];
  confidence: number;
}
