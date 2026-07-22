// =============================================================================
// Document Engine -- live repository adapter. SATU-SATUNYA lapisan yang boleh
// menyentuh repository/database sungguhan (po-builder.ts, invoice-builder.ts,
// PrintDocumentPage.tsx, print-view-model.ts TETAP murni, tidak berubah).
//
// Tiga tanggung jawab terpisah:
//   1. Pengambilan data lewat repository/service RESMI yang sudah ada
//      (DeliveryRepositoryInterface dari lib/delivery/repository.ts) --
//      tidak ada query database baru ditulis di sini.
//   2. Pemetaan Order/Delivery kanonik -> OrderSource/DeliverySource milik
//      Document Engine sendiri (types.ts).
//   3. Memanggil buildPurchaseOrderSnapshot/buildInvoiceSnapshot yang sudah
//      ada -- adapter ini TIDAK menghitung uang sendiri.
//
// Keputusan sumber data (lihat laporan gate untuk detail):
//   - SalesOrderTelegramRepository.getOrder() (lib/sales-orders/repository.ts)
//     TIDAK dipakai sebagai sumber live: query-nya tidak menyaring maupun
//     mengembalikan company_id (tidak bisa diverifikasi tenant), dan hasil
//     priced.items TIDAK menyertakan sales_order_items.id (tidak ada kunci
//     baris yang stabil untuk dicocokkan dengan delivery_items.sales_order_item_id).
//     Ini bukan bypass -- ini alasan untuk TIDAK memakainya.
//   - DeliveryRepositoryInterface.getConfirmedOrder(salesOrderId, companyId)
//     DIPAKAI sebagai sumber Order: query-nya sudah menyaring company_id dan
//     item-nya membawa sales_order_items.id asli (dipakai sebagai orderLineId).
//     Sejak Repository & Persistence Closure Gate, repository ini JUGA
//     menyediakan orderDate (sales_orders.confirmed_at), customerId
//     (sales_orders.customer_id), salesmanId/salesmanName
//     (sales_orders.sales_id -> users.full_name, dijaga tenant-safe di
//     SupabaseDeliveryRepository), dan discountAmount per baris
//     (sales_order_items.discount_amount) -- lihat ConfirmedOrderSnapshot di
//     lib/delivery/repository.ts. Repository ini MASIH TIDAK menyediakan:
//     alamat toko dan PIC (customerAddress/picName tetap null, keduanya
//     opsional pada OrderSource) dan payment terms -- field ini tetap
//     dipetakan null dan TIDAK menyebabkan ORDER_SOURCE_INCOMPLETE karena
//     keduanya opsional pada kontrak dokumen, BUKAN diisi nilai karangan.
//   - DeliveryRepositoryInterface.getDelivery(deliveryId) DIPAKAI sebagai
//     sumber Delivery -- companyId ada langsung pada DeliveryRecord sehingga
//     bisa diverifikasi pasca-fetch tanpa mengubah repository.
//   - computeInvoiceEligibility()/isTerminalStatus() (lib/delivery/service.ts,
//     lib/delivery/types.ts) dipakai APA ADANYA (fungsi murni, bukan query)
//     supaya semantik verifiedQuantity/billingStatus tidak diimplementasikan
//     ulang secara terpisah di sini.
// =============================================================================

import { computeInvoiceEligibility } from "@/lib/delivery/service";
import { isTerminalStatus } from "@/lib/delivery/types";
import type { DeliveryRepositoryInterface } from "@/lib/delivery/repository";
import { DocumentSourceError } from "./errors";
import type { DeliveryBillingStatus, DeliveryLineSource, DeliverySource, OrderLineSource, OrderSource } from "./types";

// ---------------------------------------------------------------------------
// Reader contracts -- interface minimum yang dibutuhkan Document Engine, BUKAN
// duplikasi seluruh DeliveryRepositoryInterface. Bentuk record di sini SENGAJA
// mengizinkan null pada field yang repository sumber saat ini TIDAK sediakan,
// supaya fungsi pemetaan bisa menolak eksplisit lewat *_SOURCE_INCOMPLETE
// alih-alih diam-diam mengisi nilai palsu.
// ---------------------------------------------------------------------------

export interface OrderReaderLine {
  /** WAJIB berupa kunci baris order yang stabil (mis. sales_order_items.id). */
  orderLineId: string;
  productCode: string | null;
  productName: string;
  productType: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  /** null bila repository sumber belum menyediakan data diskon untuk baris ini. */
  discountAmount: number | null;
}

export interface OrderReaderRecord {
  orderId: string;
  companyId: string;
  orderNumber: string;
  orderDate: string | null;
  customerId: string | null;
  customerName: string | null;
  customerAddress: string | null;
  picName: string | null;
  salesmanId: string | null;
  salesmanName: string | null;
  paymentTermsDays: number | null;
  lines: OrderReaderLine[];
}

export interface OrderReader {
  /**
   * WAJIB menyaring/memfilter milik companyId ini di sisi implementasi --
   * mengembalikan null bila order tidak ditemukan ATAU bukan milik companyId.
   */
  getOrderForDocument(companyId: string, orderId: string): Promise<OrderReaderRecord | null>;
}

export interface DeliveryReaderLine {
  deliveryLineId: string;
  /** WAJIB merujuk OrderReaderLine.orderLineId order yang sama. */
  orderLineId: string;
  productCode: string | null;
  productName: string;
  productType: string | null;
  unit: string | null;
  orderedQuantity: number;
  verifiedQuantity: number;
  unitPrice: number;
}

export interface DeliveryReaderRecord {
  deliveryId: string;
  companyId: string;
  orderId: string;
  deliveryNumber: string | null;
  deliveryDate: string | null;
  billingStatus: DeliveryBillingStatus;
  lines: DeliveryReaderLine[];
}

export interface DeliveryReader {
  /** WAJIB menyaring/memfilter milik companyId ini -- null bila tidak ditemukan/bukan milik company. */
  getDeliveryForDocument(companyId: string, deliveryId: string): Promise<DeliveryReaderRecord | null>;
}

// ---------------------------------------------------------------------------
// Orkestrasi: Reader -> OrderSource/DeliverySource. Fungsi ini murni terhadap
// reader yang diberikan (dependency injection) -- tidak tahu apakah reader
// diimplementasikan lewat Supabase asli atau fake in-memory untuk test.
// ---------------------------------------------------------------------------

export interface LoadPurchaseOrderSourceParams {
  companyId: string;
  orderId: string;
}

function assertOrderComplete(record: OrderReaderRecord): asserts record is OrderReaderRecord & {
  orderDate: string;
  customerId: string;
  customerName: string;
  salesmanId: string;
  salesmanName: string;
} {
  const missing: string[] = [];
  if (!record.orderDate) missing.push("orderDate");
  if (!record.customerId) missing.push("store.customerId");
  if (!record.customerName) missing.push("store.storeName");
  if (!record.salesmanId) missing.push("salesman.salesmanId");
  if (!record.salesmanName) missing.push("salesman.salesmanName");
  if (record.lines.length === 0) missing.push("lines");
  for (const line of record.lines) {
    if (line.discountAmount === null) {
      missing.push(`lines[${line.orderLineId}].discountAmount`);
    }
  }

  if (missing.length > 0) {
    throw new DocumentSourceError(
      "ORDER_SOURCE_INCOMPLETE",
      `Order ${record.orderId} belum memiliki data lengkap untuk dokumen: ${missing.join(", ")}.`,
    );
  }
}

/**
 * Mengambil SATU order milik companyId yang terautentikasi lewat OrderReader
 * resmi, memverifikasi kepemilikan tenant, lalu memetakannya ke OrderSource.
 * orderId/companyId adalah SATU-SATUNYA input identitas -- tidak ada parameter
 * lain untuk menimpa customerId/customerCode/dll secara manual.
 */
export async function loadPurchaseOrderSource(
  reader: OrderReader,
  params: LoadPurchaseOrderSourceParams,
): Promise<OrderSource> {
  const record = await reader.getOrderForDocument(params.companyId, params.orderId);
  if (!record) {
    throw new DocumentSourceError(
      "ORDER_NOT_FOUND",
      `Order tidak ditemukan untuk company yang terautentikasi.`,
    );
  }
  if (record.companyId !== params.companyId) {
    // Jaga-jaga ganda -- OrderReader seharusnya sudah menyaring company_id
    // sendiri; baris ini tidak pernah tercapai pada implementasi yang benar,
    // tapi tetap menolak eksplisit alih-alih mempercayai reader secara buta.
    throw new DocumentSourceError(
      "TENANT_CONTEXT_MISMATCH",
      `Order ${record.orderId} bukan milik company yang terautentikasi.`,
    );
  }

  assertOrderComplete(record);

  const lines: OrderLineSource[] = record.lines.map((line) => ({
    orderLineId: line.orderLineId,
    productCode: line.productCode,
    productName: line.productName,
    productType: line.productType,
    unit: line.unit,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    discountAmount: line.discountAmount as number,
  }));

  return {
    orderId: record.orderId,
    companyId: record.companyId,
    orderNumber: record.orderNumber,
    orderDate: record.orderDate,
    store: {
      customerId: record.customerId,
      storeName: record.customerName,
      storeAddress: record.customerAddress,
      picName: record.picName,
    },
    salesman: {
      salesmanId: record.salesmanId,
      salesmanName: record.salesmanName,
    },
    lines,
    paymentTermsDays: record.paymentTermsDays,
  };
}

export interface LoadInvoiceSourceParams {
  companyId: string;
  orderId: string;
  deliveryId: string;
}

export interface InvoiceSourceBundle {
  order: OrderSource;
  delivery: DeliverySource;
}

/**
 * Mengambil order (lewat loadPurchaseOrderSource) DAN delivery verification
 * yang diminta lewat OrderReader/DeliveryReader resmi, memverifikasi rantai
 * tenant + order<->delivery, lalu memetakan keduanya ke
 * { order: OrderSource, delivery: DeliverySource }. Order dan delivery HANYA
 * dibaca satu kali masing-masing -- panel cetak kedua memakai snapshot yang
 * sama, tidak membaca ulang.
 */
export async function loadInvoiceSource(
  readers: { orderReader: OrderReader; deliveryReader: DeliveryReader },
  params: LoadInvoiceSourceParams,
): Promise<InvoiceSourceBundle> {
  const order = await loadPurchaseOrderSource(readers.orderReader, {
    companyId: params.companyId,
    orderId: params.orderId,
  });

  const deliveryRecord = await readers.deliveryReader.getDeliveryForDocument(params.companyId, params.deliveryId);
  if (!deliveryRecord) {
    throw new DocumentSourceError(
      "DELIVERY_NOT_FOUND",
      `Delivery tidak ditemukan untuk company yang terautentikasi.`,
    );
  }
  if (deliveryRecord.companyId !== params.companyId) {
    throw new DocumentSourceError(
      "TENANT_CONTEXT_MISMATCH",
      `Delivery ${deliveryRecord.deliveryId} bukan milik company yang terautentikasi.`,
    );
  }
  if (deliveryRecord.orderId !== order.orderId) {
    throw new DocumentSourceError(
      "DELIVERY_ORDER_MISMATCH",
      `Delivery ${deliveryRecord.deliveryId} milik order ${deliveryRecord.orderId}, bukan order ${order.orderId}.`,
    );
  }

  const missing: string[] = [];
  if (!deliveryRecord.deliveryNumber) missing.push("deliveryNumber");
  if (!deliveryRecord.deliveryDate) missing.push("deliveryDate");
  if (missing.length > 0) {
    throw new DocumentSourceError(
      "DELIVERY_SOURCE_INCOMPLETE",
      `Delivery ${deliveryRecord.deliveryId} belum memiliki data lengkap untuk dokumen: ${missing.join(", ")}.`,
    );
  }

  const orderLineById = new Map(order.lines.map((line) => [line.orderLineId, line]));
  const lines: DeliveryLineSource[] = deliveryRecord.lines.map((deliveryLine) => {
    const orderLine = orderLineById.get(deliveryLine.orderLineId);
    if (!orderLine) {
      throw new DocumentSourceError(
        "DELIVERY_LINE_FOREIGN",
        `Delivery line ${deliveryLine.deliveryLineId} merujuk order line ${deliveryLine.orderLineId} yang bukan milik order ${order.orderId}.`,
      );
    }

    // Diskon proporsional untuk verifiedQuantity, bukan diskon atas
    // orderedQuantity penuh -- delivery repository tidak menyimpan diskon
    // sendiri, jadi diprorata dari diskon baris order kanonik yang sudah
    // diverifikasi tenant-nya lewat loadPurchaseOrderSource di atas.
    const discountAmount =
      deliveryLine.orderedQuantity > 0
        ? Math.round((orderLine.discountAmount * deliveryLine.verifiedQuantity) / deliveryLine.orderedQuantity)
        : 0;

    return {
      deliveryLineId: deliveryLine.deliveryLineId,
      orderLineId: deliveryLine.orderLineId,
      productCode: deliveryLine.productCode,
      productName: deliveryLine.productName,
      productType: deliveryLine.productType,
      unit: deliveryLine.unit,
      orderedQuantity: deliveryLine.orderedQuantity,
      verifiedQuantity: deliveryLine.verifiedQuantity,
      unitPrice: deliveryLine.unitPrice,
      discountAmount,
    };
  });

  const delivery: DeliverySource = {
    deliveryId: deliveryRecord.deliveryId,
    companyId: deliveryRecord.companyId,
    orderId: deliveryRecord.orderId,
    deliveryNumber: deliveryRecord.deliveryNumber as string,
    deliveryDate: deliveryRecord.deliveryDate as string,
    billingStatus: deliveryRecord.billingStatus,
    lines,
  };

  return { order, delivery };
}

// ---------------------------------------------------------------------------
// Production readers -- wrapper tipis di atas DeliveryRepositoryInterface
// (lib/delivery/repository.ts) yang SUDAH tenant-safe. TIDAK ada query
// database baru ditulis di sini; hanya memetakan hasil repository resmi ke
// bentuk OrderReaderRecord/DeliveryReaderRecord. Field yang belum tersedia
// pada repository ini dipetakan null secara eksplisit (lihat catatan modul
// di atas + LIMITATION pada laporan gate) -- BUKAN diisi nilai dummy.
// ---------------------------------------------------------------------------

/**
 * Membungkus DeliveryRepositoryInterface.getConfirmedOrder -- SATU-SATUNYA
 * pencarian order yang tenant-safe (menyaring DAN mengembalikan company_id)
 * yang ditemukan dalam scope pembacaan gate ini, dan satu-satunya yang
 * membawa sales_order_items.id asli sebagai kunci baris order yang stabil.
 */
export class ConfirmedOrderReader implements OrderReader {
  constructor(private readonly repository: Pick<DeliveryRepositoryInterface, "getConfirmedOrder">) {}

  async getOrderForDocument(companyId: string, orderId: string): Promise<OrderReaderRecord | null> {
    const confirmed = await this.repository.getConfirmedOrder(orderId, companyId);
    if (!confirmed) return null;

    return {
      orderId: confirmed.id,
      companyId: confirmed.companyId,
      orderNumber: confirmed.orderNumber,
      orderDate: confirmed.orderDate ?? null,
      customerId: confirmed.customerId ?? null,
      customerName: confirmed.customerName,
      // customerAddress dan picName masih tidak tersedia pada getConfirmedOrder
      // -- keduanya opsional pada OrderSource, jadi tetap null tanpa memicu
      // ORDER_SOURCE_INCOMPLETE (lihat StoreIdentity di types.ts).
      customerAddress: null,
      picName: null,
      salesmanId: confirmed.salesmanId ?? null,
      salesmanName: confirmed.salesmanName ?? null,
      // Payment terms masih tidak tersedia pada getConfirmedOrder -- opsional
      // pada OrderSource, tetap null tanpa memicu ORDER_SOURCE_INCOMPLETE.
      paymentTermsDays: null,
      lines: confirmed.items.map((item) => ({
        orderLineId: item.id,
        // productCode tidak tersedia pada getConfirmedOrder saat ini.
        // quantity di sini adalah OUTSTANDING (ordered dikurangi delivery
        // attempt sebelumnya), bukan ordered asli -- identik untuk order yang
        // belum pernah dikirim sebagian.
        productCode: null,
        productName: item.productName,
        productType: null,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount ?? null,
      })),
    };
  }
}

/**
 * Membungkus DeliveryRepositoryInterface.getDelivery. companyId ada langsung
 * pada DeliveryRecord sehingga bisa diverifikasi pasca-fetch tanpa mengubah
 * query repository (getDelivery sendiri tidak memfilter company_id, tapi
 * hasilnya membawa company_id asli untuk diverifikasi di sini).
 */
export class DeliveryVerificationReader implements DeliveryReader {
  constructor(private readonly repository: Pick<DeliveryRepositoryInterface, "getDelivery">) {}

  async getDeliveryForDocument(companyId: string, deliveryId: string): Promise<DeliveryReaderRecord | null> {
    const record = await this.repository.getDelivery(deliveryId);
    if (!record) return null;
    if (record.companyId !== companyId) return null;

    const eligibility = computeInvoiceEligibility(record);

    return {
      deliveryId: record.id,
      companyId: record.companyId,
      orderId: record.salesOrderId,
      // deliveryNumber/deliveryDate -- dialokasikan lewat issue_delivery_note()
      // (Target 2, migration 20260812000001) sebelum dispatch. Null bila belum
      // diterbitkan/historis -- loadInvoiceSource() di atas menolak eksplisit
      // (DELIVERY_SOURCE_INCOMPLETE) untuk kasus tsb, tidak fallback ke nilai lain.
      deliveryNumber: record.deliveryNumber,
      deliveryDate: record.deliveryDate,
      billingStatus: isTerminalStatus(record.status) ? "ELIGIBLE" : "NOT_YET_ELIGIBLE",
      lines: eligibility.items.map((eligibleItem) => {
        const original = record.items.find((i) => i.salesOrderItemId === eligibleItem.salesOrderItemId);
        return {
          deliveryLineId: eligibleItem.deliveryItemId,
          orderLineId: eligibleItem.salesOrderItemId,
          // productCode tidak tersedia pada delivery repository saat ini.
          productCode: null,
          productName: eligibleItem.productName,
          productType: null,
          unit: original?.unit ?? null,
          orderedQuantity: original?.orderedQuantity ?? 0,
          verifiedQuantity: eligibleItem.eligibleQuantity,
          unitPrice: eligibleItem.unitPrice,
        };
      }),
    };
  }
}
