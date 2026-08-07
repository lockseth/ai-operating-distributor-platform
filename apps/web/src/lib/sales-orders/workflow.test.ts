// =============================================================================
// Test — Telegram Sales Order Entry workflow.
// Menutup 10 skenario DoD + UBAH/knowledge_candidate + discount policy,
// seluruhnya tanpa Supabase/Telegram sungguhan (in-memory fakes).
// =============================================================================

import { describe, it, expect } from "vitest";
import { processTelegramUpdate, type WorkflowDeps } from "./workflow";
import { InMemorySalesOrderRepository, DuplicateUpdateEventError } from "./repository";
import { InMemoryKnowledgeProvider } from "./knowledge-provider";
import type { KnowledgeProvider } from "./knowledge-provider";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/client";
import type { KnowledgeContext } from "./types";
import { InMemoryDeliveryRepository } from "@/lib/delivery/repository";
import { InMemoryTelegramEnrollmentRepository } from "@/lib/telegram-enrollment/repository";
import { hashEnrollmentToken } from "@/lib/telegram-enrollment/token";

const COMPANY_ID = "company-1";
const USER_ID = "user-1";
const CHAT_ID = 1001;

function makeDeps(seed: Partial<KnowledgeContext> = {}): WorkflowDeps & {
  repository: InMemorySalesOrderRepository;
  knowledgeProvider: InMemoryKnowledgeProvider;
  sender: RecordingTelegramSender;
  deliveryRepository: InMemoryDeliveryRepository;
  enrollmentRepository: InMemoryTelegramEnrollmentRepository;
} {
  const repository = new InMemorySalesOrderRepository();
  const knowledgeProvider = new InMemoryKnowledgeProvider(seed);
  const sender = new RecordingTelegramSender();
  const deliveryRepository = new InMemoryDeliveryRepository();
  const enrollmentRepository = new InMemoryTelegramEnrollmentRepository();
  return {
    repository,
    knowledgeProvider,
    sender,
    deliveryRepository,
    enrollmentRepository,
  };
}

function registerSales(
  repository: InMemorySalesOrderRepository,
  chatId = CHAT_ID,
) {
  repository.seedIdentity(chatId, {
    identityId: "identity-1",
    companyId: COMPANY_ID,
    userId: USER_ID,
    userFullName: "Andri",
  });
}

function textUpdate(
  updateId: number,
  text: string,
  chatId = CHAT_ID,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: chatId },
      from: { id: 5555, username: "andri" },
    },
  };
}

/**
 * Gate 3E-D4-C7: sejak harga master WAJIB (product_id harus resolve ke satu
 * produk aktif berharga > 0, lihat pricing.ts/repository.ts), sebagian besar
 * skenario "draft_created" di bawah butuh alias + harga master di-seed --
 * bukan lagi cukup teks bebas seperti sebelum gate ini. Helper ini
 * menghasilkan productAliases (aliasText = nama persis di pesan, supaya
 * matched) + products (katalog kanonik/harga master) untuk di-spread ke
 * makeDeps(seed).
 */
function productKnowledge(
  entries: { name: string; id: string; price: number; active?: boolean }[],
): Pick<KnowledgeContext, "productAliases" | "products"> {
  return {
    productAliases: entries.map((e) => ({
      aliasText: e.name,
      productId: e.id,
      productName: e.name,
      productCode: null,
      updatedAt: "2026-01-01T00:00:00Z",
    })),
    products: entries.map((e) => ({
      productId: e.id,
      productName: e.name,
      productCode: null,
      price: e.price,
      isActive: e.active ?? true,
    })),
  };
}

/**
 * Gate 3E-D4-C7 (Temuan #4): sejak customer text yang tidak resolve ke satu
 * customer pasti kini DITOLAK (invalid_customer, zero writes -- lihat
 * repository.ts/migration 20260929000001), skenario "draft_created" yang
 * MENYEBUTKAN nama toko butuh alias + katalog kanonik customer di-seed juga
 * -- pasangan productKnowledge di atas.
 */
function customerKnowledge(
  entries: { name: string; id: string; active?: boolean }[],
): Pick<KnowledgeContext, "customerAliases" | "customers"> {
  return {
    customerAliases: entries.map((e) => ({
      aliasText: e.name,
      customerId: e.id,
      customerName: e.name,
      customerCode: null,
      updatedAt: "2026-01-01T00:00:00Z",
    })),
    customers: entries.map((e) => ({
      customerId: e.id,
      customerName: e.name,
      customerCode: null,
      isActive: e.active ?? true,
    })),
  };
}

/** Gate 3E-D4-C7 (Temuan #4): seed sisi repository.customers (validasi tenant/aktif) -- lihat customerKnowledge di atas untuk sisi alias/katalog Knowledge Pack. */
function seedCustomers(
  repository: InMemorySalesOrderRepository,
  entries: { name: string; id: string; active?: boolean; companyId?: string }[],
): void {
  for (const e of entries) {
    repository.seedCustomer(e.id, { companyId: e.companyId ?? COMPANY_ID, isActive: e.active ?? true });
  }
}

/** Gate 3E-D4-C7: seed sisi repository.products (validasi tenant/aktif/harga) -- lihat productKnowledge di atas untuk sisi alias/harga Knowledge Pack. */
function seedProducts(
  repository: InMemorySalesOrderRepository,
  entries: { name: string; id: string; price: number; active?: boolean; companyId?: string }[],
): void {
  for (const e of entries) {
    repository.seedProduct(e.id, { companyId: e.companyId ?? COMPANY_ID, isActive: e.active ?? true, price: e.price });
  }
}

describe("Telegram Sales Order workflow", () => {
  it("1. pesan order lengkap -> draft dibuat, total & diskon terhitung benar", async () => {
    const products = [
      { name: "Cat Mawar Putih", id: "prod-cat-mawar", price: 450_000 },
      { name: "Thinner Super", id: "prod-thinner", price: 175_000 },
    ];
    const customers = [{ name: "Toko Sinar Jaya", id: "cust-sinar-jaya-1" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = [
      "Order Toko Sinar Jaya:",
      "Cat Mawar Putih 20 dus harga 450 ribu diskon 5%",
      "Thinner Super 10 dus harga 175 ribu potongan 100 ribu",
      "Kirim Jumat pagi, jangan lewat jam 10.",
    ].join("\n");

    const result = await processTelegramUpdate(textUpdate(1, text), deps);
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.status).toBe("draft");
    expect(order?.priced.customerName).toBe("Toko Sinar Jaya");
    expect(order?.priced.items).toHaveLength(2);
    expect(order?.priced.items[0]!.amountAfterDiscount).toBe(8_550_000); // diskon 5%
    expect(order?.priced.items[1]!.amountAfterDiscount).toBe(1_650_000); // potongan nominal
    expect(order?.priced.estimatedTotal).toBe(10_200_000);

    const reply = deps.sender.sent[0]!.text;
    expect(reply).toContain(`Draft Order ${order!.orderNumber} — Toko Sinar Jaya`);
    expect(reply).toContain("Rp10.200.000");
    expect(reply).toContain("Balas KONFIRMASI");
  });

  it("2. order tanpa nama toko -> customer.name null, item tetap terekstrak", async () => {
    const products = [{ name: "Cat Mawar Putih", id: "prod-cat-mawar-2", price: 450_000 }];
    const deps = makeDeps(productKnowledge(products));
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    const text = "Cat Mawar Putih 5 dus harga 450 ribu";

    const result = await processTelegramUpdate(textUpdate(2, text), deps);
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.customerName).toBeNull();
    expect(order?.priced.items).toHaveLength(1);
    expect(order?.priced.items[0]!.productName).toBe("Cat Mawar Putih");
  });

  it("3. produk lebih dari satu -> semua item terekstrak dengan urutan benar", async () => {
    const products = [
      { name: "Produk A", id: "prod-a-3", price: 10000 },
      { name: "Produk B", id: "prod-b-3", price: 20000 },
      { name: "Produk C", id: "prod-c-3", price: 30000 },
    ];
    const customers = [{ name: "Toko Multi", id: "cust-multi-3" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = [
      "Order Toko Multi:",
      "Produk A 3 dus harga 10000",
      "Produk B 4 dus harga 20000",
      "Produk C 5 dus harga 30000",
    ].join("\n");

    const result = await processTelegramUpdate(textUpdate(3, text), deps);
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.items.map((i) => i.productName)).toEqual([
      "Produk A",
      "Produk B",
      "Produk C",
    ]);
    expect(order?.priced.estimatedTotal).toBe(
      3 * 10000 + 4 * 20000 + 5 * 30000,
    );
  });

  it("4. diskon persen dihitung benar", async () => {
    const products = [{ name: "Barang X", id: "prod-x-4", price: 100000 }];
    const customers = [{ name: "Toko D", id: "cust-d-4" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = "Order Toko D:\nBarang X 10 dus harga 100000 diskon 10%";

    const result = await processTelegramUpdate(textUpdate(4, text), deps);
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");
    const order = await deps.repository.getOrder(result.orderId);
    const item = order!.priced.items[0]!;
    expect(item.discountType).toBe("percentage");
    expect(item.discountValue).toBe(10);
    expect(item.amountBeforeDiscount).toBe(1_000_000);
    expect(item.amountAfterDiscount).toBe(900_000);
  });

  it("5. diskon nominal dihitung benar", async () => {
    const products = [{ name: "Barang Y", id: "prod-y-5", price: 100000 }];
    const customers = [{ name: "Toko E", id: "cust-e-5" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = "Order Toko E:\nBarang Y 10 dus harga 100000 potongan 50000";

    const result = await processTelegramUpdate(textUpdate(5, text), deps);
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");
    const order = await deps.repository.getOrder(result.orderId);
    const item = order!.priced.items[0]!;
    expect(item.discountType).toBe("nominal");
    expect(item.discountValue).toBe(50000);
    expect(item.amountAfterDiscount).toBe(950_000);
  });

  it("6. pesan bukan order -> tidak membuat draft, balasan ramah", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);

    const result = await processTelegramUpdate(
      textUpdate(6, "Halo, apa kabar hari ini?"),
      deps,
    );
    expect(result.outcome).toBe("not_order");
    expect(deps.sender.sent[0]!.text).toContain("belum bisa dikenali");
  });

  it("7. Telegram user tidak terdaftar -> ditolak tanpa membocorkan data internal", async () => {
    const deps = makeDeps(); // sengaja tidak registerSales()

    const result = await processTelegramUpdate(
      textUpdate(
        7,
        "Order Toko A:\nBarang 1 dus harga 10000, ini rahasia dagang pelanggan",
      ),
      deps,
    );
    expect(result.outcome).toBe("unregistered");
    const reply = deps.sender.sent[0]!.text;
    expect(reply).not.toMatch(/company|user_id|uuid|internal/i);

    // Hardening: chat yang belum terdaftar TIDAK boleh menyimpan isi pesan
    // (raw_payload) sama sekali — hanya metadata handshake minimum, supaya
    // pesan sensitif dari pengirim tak dikenal tidak ikut tersimpan.
    const record = deps.repository.getEventRecord(7);
    expect(record).toBeDefined();
    expect(record?.rawPayload).toBeNull();
    expect(record?.telegramChatId).toBe(CHAT_ID);
    expect(record?.telegramUserId).toBe(5555);
    expect(record?.telegramUsername).toBe("andri");
    expect(record?.rejectionReason).toBe("unregistered_chat");
    expect(JSON.stringify(record)).not.toContain("rahasia dagang");
  });

  it("8. duplicate update_id -> tidak diproses ulang, tidak ada pesan baru", async () => {
    const products = [{ name: "Barang Z", id: "prod-z-8", price: 10000 }];
    const customers = [{ name: "Toko F", id: "cust-f-8" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = "Order Toko F:\nBarang Z 2 dus harga 10000";

    const first = await processTelegramUpdate(textUpdate(8, text), deps);
    expect(first.outcome).toBe("draft_created");
    const sentCountAfterFirst = deps.sender.sent.length;

    const second = await processTelegramUpdate(textUpdate(8, text), deps); // update_id sama
    expect(second.outcome).toBe("duplicate_update");
    expect(deps.sender.sent.length).toBe(sentCountAfterFirst); // tidak ada balasan tambahan
  });

  it("9. KONFIRMASI berulang tidak membuat transaksi ganda", async () => {
    const products = [{ name: "Barang W", id: "prod-w-9", price: 50000 }];
    const customers = [{ name: "Toko G", id: "cust-g-9" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const created = await processTelegramUpdate(
      textUpdate(9, "Order Toko G:\nBarang W 1 dus harga 50000"),
      deps,
    );
    if (created.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const confirm1 = await processTelegramUpdate(
      textUpdate(10, "KONFIRMASI"),
      deps,
    );
    expect(confirm1.outcome).toBe("confirmed");
    if (confirm1.outcome !== "confirmed") throw new Error("unexpected outcome");
    expect(confirm1.alreadyConfirmed).toBe(false);

    const confirm2 = await processTelegramUpdate(
      textUpdate(11, "KONFIRMASI"),
      deps,
    );
    expect(confirm2.outcome).toBe("confirmed");
    if (confirm2.outcome !== "confirmed") throw new Error("unexpected outcome");
    expect(confirm2.alreadyConfirmed).toBe(true);
    expect(confirm2.orderId).toBe(confirm1.orderId); // order yang sama, tidak ada duplikat

    const order = await deps.repository.getOrder(created.orderId);
    expect(order?.status).toBe("confirmed");
  });

  it("10. voice note -> transcription_pending, tidak membuat draft order", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);
    const update: TelegramUpdate = {
      update_id: 20,
      message: {
        message_id: 1,
        voice: { file_id: "abc123", duration: 5 },
        chat: { id: CHAT_ID },
      },
    };

    const result = await processTelegramUpdate(update, deps);
    expect(result.outcome).toBe("voice_pending");
    expect(deps.sender.sent[0]!.text.toLowerCase()).toContain("transkripsi");
  });

  it("11. UBAH lalu koreksi -> draft yang sama diperbarui + knowledge_candidate tersimpan (pending)", async () => {
    // Gate 3E-D4-C7: "MW Putih" sekarang WAJIB resolve ke produk aktif
    // berharga valid juga (bukan lagi fallback raw-text yang diizinkan
    // Gate 3E-B) -- di-seed sebagai alias produk BERBEDA dari "Cat Mawar
    // Putih" supaya submitDiffAsCandidates (before/after productName beda)
    // tetap teruji apa adanya, hanya tanpa mengandalkan unmatched product.
    const products = [
      { name: "MW Putih", id: "prod-mw-putih-11", price: 450_000 },
      { name: "Cat Mawar Putih", id: "prod-cat-mawar-11", price: 450_000 },
    ];
    const customers = [{ name: "Toko H", id: "cust-h-11" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const created = await processTelegramUpdate(
      textUpdate(30, "Order Toko H:\nMW Putih 20 ds harga 450 ribu"),
      deps,
    );
    if (created.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const ubah = await processTelegramUpdate(textUpdate(31, "UBAH"), deps);
    expect(ubah.outcome).toBe("awaiting_correction");

    const corrected = await processTelegramUpdate(
      textUpdate(32, "Order Toko H:\nCat Mawar Putih 20 dus harga 450 ribu"),
      deps,
    );
    expect(corrected.outcome).toBe("corrected_draft_updated");
    if (corrected.outcome !== "corrected_draft_updated")
      throw new Error("unexpected outcome");

    // Draft yang SAMA diperbarui, bukan draft baru
    expect(corrected.orderId).toBe(created.orderId);

    const order = await deps.repository.getOrder(corrected.orderId);
    expect(order?.priced.items[0]!.productName).toBe("Cat Mawar Putih");

    // Koreksi tersimpan sebagai candidate, BELUM published, status pending
    expect(deps.knowledgeProvider.submittedCandidates.length).toBeGreaterThan(
      0,
    );
    const candidate = deps.knowledgeProvider.submittedCandidates.find(
      (c) => c.candidateType === "product_alias",
    );
    expect(candidate?.rawText).toBe("MW Putih");
    expect(
      (candidate?.suggestedValue as { canonicalName?: string })?.canonicalName,
    ).toBe("Cat Mawar Putih");
  });

  it("12. diskon melebihi discount policy -> discount_exception true, requires_discount_review true", async () => {
    const products = [{ name: "Barang V", id: "prod-v-12", price: 100000 }];
    const customers = [{ name: "Toko I", id: "cust-i-12" }];
    const deps = makeDeps({
      ...productKnowledge(products),
      ...customerKnowledge(customers),
      discountPolicies: [
        {
          scope: "global",
          productId: null,
          customerId: null,
          maxPercentage: 5,
          maxNominal: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const result = await processTelegramUpdate(
      textUpdate(40, "Order Toko I:\nBarang V 5 dus harga 100000 diskon 20%"),
      deps,
    );
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.items[0]!.discountException).toBe(true);
    expect(order?.priced.requiresDiscountReview).toBe(true);
    expect(deps.sender.sent[0]!.text).toContain("butuh review diskon");
  });

  it("13. diskon tanpa discount policy sama sekali -> requires_discount_review true, TANPA limit yang diarang", async () => {
    const products = [{ name: "Barang U", id: "prod-u-13", price: 100000 }];
    const customers = [{ name: "Toko J", id: "cust-j-13" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) }); // tidak ada discount policy sama sekali
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const result = await processTelegramUpdate(
      textUpdate(41, "Order Toko J:\nBarang U 5 dus harga 100000 diskon 3%"),
      deps,
    );
    if (result.outcome !== "draft_created")
      throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    // Limit tidak diketahui -> TIDAK dianggap exception (bukan mengarang limit), tapi wajib direview
    expect(order?.priced.items[0]!.discountException).toBe(false);
    expect(order?.priced.requiresDiscountReview).toBe(true);
  });

  it("14. enrollment command chat privat -> identity claimed, token tidak masuk event ledger", async () => {
    const deps = makeDeps();
    const token = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    deps.enrollmentRepository.seedToken({
      tokenHash: hashEnrollmentToken(token),
      identity: {
        identityId: "identity-enrolled",
        companyId: COMPANY_ID,
        userId: USER_ID,
        userFullName: "Andri",
      },
    });

    const update: TelegramUpdate = {
      update_id: 140,
      message: {
        message_id: 140,
        text: `/start enroll_${token}`,
        chat: { id: CHAT_ID, type: "private" },
        from: { id: CHAT_ID, username: "andri" },
      },
    };
    const result = await processTelegramUpdate(update, deps);

    expect(result.outcome).toBe("enrollment_claimed");
    expect(deps.sender.sent[0]!.text).toContain("berhasil terhubung");
    const record = deps.repository.getEventRecord(140);
    expect(record?.rawPayload).toBeNull();
    expect(JSON.stringify(record)).not.toContain(token);
  });

  it("15. order source terdeteksi dari teks dan tersimpan pada draft (WA)", async () => {
    const products = [{ name: "Sabun Cuci", id: "prod-sabun-15", price: 60_000 }];
    const customers = [{ name: "Toko Melati", id: "cust-melati-15" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = [
      "Order Toko Melati, dari WA toko:",
      "Sabun Cuci 5 dus harga 60 ribu",
    ].join("\n");

    const result = await processTelegramUpdate(textUpdate(15, text), deps);
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.orderSource).toBe("CUSTOMER_WHATSAPP");
  });

  it("16. order source default OTHER ketika tidak ada penanda, order tetap dibuat (tidak ditolak)", async () => {
    const products = [{ name: "Gula", id: "prod-gula-16", price: 250_000 }];
    const customers = [{ name: "Toko Abadi", id: "cust-abadi-16" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = "Order Toko Abadi:\nGula 10 dus harga 250 ribu";

    const result = await processTelegramUpdate(textUpdate(16, text), deps);
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.orderSource).toBe("OTHER");
    expect(order?.status).toBe("draft");
  });

  it("17. UBAH lalu koreksi -> order source ikut diperbarui sesuai teks koreksi terbaru", async () => {
    const products = [{ name: "Sapu", id: "prod-sapu-17", price: 20_000 }];
    const customers = [{ name: "Toko Baru", id: "cust-baru-17" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const first = await processTelegramUpdate(
      textUpdate(17, "Order Toko Baru:\nSapu 3 pcs harga 20 ribu"),
      deps,
    );
    if (first.outcome !== "draft_created") throw new Error("unexpected outcome");
    let order = await deps.repository.getOrder(first.orderId);
    expect(order?.orderSource).toBe("OTHER");

    await processTelegramUpdate(textUpdate(18, "UBAH"), deps);
    await processTelegramUpdate(
      textUpdate(19, "Order Toko Baru, repeat order:\nSapu 3 pcs harga 20 ribu"),
      deps,
    );

    order = await deps.repository.getOrder(first.orderId);
    expect(order?.orderSource).toBe("REPEAT_ORDER");
  });

  // ---------------------------------------------------------------------
  // Gate 3E-B — Telegram Sales Order Live Demo Readiness: skenario tambahan.
  // ---------------------------------------------------------------------

  it("18. dua sales berbeda -> masing-masing membuat order sendiri, tidak saling menyamar", async () => {
    const products = [
      { name: "Barang A", id: "prod-a-18", price: 10000 },
      { name: "Barang B", id: "prod-b-18", price: 20000 },
    ];
    const customers = [
      { name: "Toko Satu", id: "cust-satu-18" },
      { name: "Toko Dua", id: "cust-dua-18" },
    ];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const CHAT_ID_2 = 2002;
    registerSales(deps.repository, CHAT_ID); // sales 1
    deps.repository.seedIdentity(CHAT_ID_2, {
      identityId: "identity-2",
      companyId: COMPANY_ID,
      userId: "user-2",
      userFullName: "Budi",
    }); // sales 2

    const order1 = await processTelegramUpdate(
      textUpdate(50, "Order Toko Satu:\nBarang A 2 dus harga 10000", CHAT_ID),
      deps,
    );
    const order2 = await processTelegramUpdate(
      textUpdate(51, "Order Toko Dua:\nBarang B 3 dus harga 20000", CHAT_ID_2),
      deps,
    );
    if (order1.outcome !== "draft_created" || order2.outcome !== "draft_created") {
      throw new Error("unexpected outcome");
    }
    expect(order1.orderId).not.toBe(order2.orderId);

    // Sales 2 mengirim KONFIRMASI -> hanya order milik sales 2 yang berubah,
    // draft sales 1 tetap menunggu (conversation state per-identity, bukan
    // global/per-chat tunggal).
    const confirm2 = await processTelegramUpdate(textUpdate(52, "KONFIRMASI", CHAT_ID_2), deps);
    expect(confirm2.outcome).toBe("confirmed");
    if (confirm2.outcome !== "confirmed") throw new Error("unexpected outcome");
    expect(confirm2.orderId).toBe(order2.orderId);

    const order1Row = await deps.repository.getOrder(order1.orderId);
    expect(order1Row?.status).toBe("draft"); // tidak ikut ter-KONFIRMASI oleh sales 2
  });

  it("19. quantity ilegal (0) -> order ditolak, tidak ada draft tersimpan", async () => {
    // Produk WAJIB tetap resolve valid (Gate 3E-D4-C7) supaya penolakan yang
    // teruji di sini murni karena quantity, bukan tertutup oleh invalid_product.
    const products = [{ name: "Barang Kosong", id: "prod-kosong-19", price: 10000 }];
    const customers = [{ name: "Toko Nol", id: "cust-nol-19" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    // "0 dus" berhasil di-parse regex (bukan missing field) tapi ilegal secara bisnis.
    const text = "Order Toko Nol:\nBarang Kosong 0 dus harga 10000";

    const result = await processTelegramUpdate(textUpdate(60, text), deps);
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_quantity");
    expect(deps.sender.sent[0]!.text).toContain("Order tidak disimpan");
    expect(deps.sender.sent[0]!.text.toLowerCase()).toContain("quantity");

    // Tidak ada draft yang tersimpan sama sekali untuk update ini.
    const record = deps.repository.getEventRecord(60);
    expect(record?.status).toBe("not_order");
  });

  it("20. toko dikenali tapi nonaktif untuk tenant ini -> order ditolak", async () => {
    const deps = makeDeps({
      customerAliases: [
        {
          aliasText: "toko nonaktif",
          customerId: "customer-inactive",
          customerName: "Toko Nonaktif",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    deps.repository.seedCustomer("customer-inactive", { companyId: COMPANY_ID, isActive: false });

    const result = await processTelegramUpdate(
      textUpdate(61, "Order Toko Nonaktif:\nBarang C 2 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_customer");
    expect(deps.repository.getEventRecord(61)?.status).toBe("not_order");
  });

  it("21. toko dikenali tapi milik tenant lain -> order ditolak (tidak bocor lintas tenant)", async () => {
    const deps = makeDeps({
      customerAliases: [
        {
          aliasText: "toko tenant lain",
          customerId: "customer-foreign",
          customerName: "Toko Tenant Lain",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    deps.repository.seedCustomer("customer-foreign", { companyId: "company-OTHER", isActive: true });

    const result = await processTelegramUpdate(
      textUpdate(62, "Order Toko Tenant Lain:\nBarang D 2 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_customer");
  });

  it("22. produk dikenali tapi nonaktif -> order ditolak", async () => {
    const customers = [{ name: "Toko E", id: "cust-e-22" }];
    const deps = makeDeps({
      productAliases: [
        {
          aliasText: "produk nonaktif",
          productId: "product-inactive",
          productName: "Produk Nonaktif",
          productCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      ...customerKnowledge(customers),
    });
    registerSales(deps.repository);
    seedCustomers(deps.repository, customers);
    deps.repository.seedProduct("product-inactive", { companyId: COMPANY_ID, isActive: false });

    const result = await processTelegramUpdate(
      textUpdate(63, "Order Toko E:\nProduk Nonaktif 2 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_product");
  });

  it("23. produk dikenali tapi milik tenant lain -> order ditolak", async () => {
    const customers = [{ name: "Toko F", id: "cust-f-23" }];
    const deps = makeDeps({
      productAliases: [
        {
          aliasText: "produk tenant lain",
          productId: "product-foreign",
          productName: "Produk Tenant Lain",
          productCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      ...customerKnowledge(customers),
    });
    registerSales(deps.repository);
    seedCustomers(deps.repository, customers);
    deps.repository.seedProduct("product-foreign", { companyId: "company-OTHER", isActive: true });

    const result = await processTelegramUpdate(
      textUpdate(64, "Order Toko F:\nProduk Tenant Lain 2 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_product");
  });

  it("24. rollback saat satu item gagal -> order dua item TIDAK tersimpan sama sekali (bukan partial)", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);
    // Item pertama legal, item kedua quantity 0 -> seluruh order harus batal, bukan hanya item ke-2.
    const text = [
      "Order Toko G:",
      "Barang Legal 5 dus harga 10000",
      "Barang Ilegal 0 dus harga 20000",
    ].join("\n");

    const result = await processTelegramUpdate(textUpdate(65, text), deps);
    expect(result.outcome).toBe("order_rejected");

    // Tidak ada order APAPUN yang tersimpan akibat update ini (atomic all-or-nothing).
    const allEvents = deps.repository.getEventRecord(65);
    expect(allEvents?.status).toBe("not_order");
  });

  it("25. user Telegram sudah pernah dipasangkan tapi kini nonaktif -> ditolak seperti belum terdaftar", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(
      CHAT_ID,
      { identityId: "identity-1", companyId: COMPANY_ID, userId: USER_ID, userFullName: "Andri" },
      { isActive: false },
    );

    const result = await processTelegramUpdate(
      textUpdate(66, "Order Toko H:\nBarang 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("unregistered");
  });

  it("26. respons sukses menyebut nomor order, toko, ringkasan item, total, dan status review", async () => {
    const products = [{ name: "Barang Utuh", id: "prod-utuh-26", price: 50000 }];
    const customers = [{ name: "Toko Lengkap", id: "cust-lengkap-26" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = "Order Toko Lengkap:\nBarang Utuh 3 dus harga 50000 diskon 3%";

    const result = await processTelegramUpdate(textUpdate(67, text), deps);
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    const reply = deps.sender.sent[0]!.text;
    expect(reply).toContain(order!.orderNumber); // nomor order
    expect(reply).toContain("Toko Lengkap"); // toko
    expect(reply).toContain("Barang Utuh"); // ringkasan item
    expect(reply).toContain(`Rp${Math.round(order!.priced.estimatedTotal).toLocaleString("id-ID")}`); // total
    expect(reply).toContain("butuh review"); // status review (tidak ada discount policy -> requiresReview)
  });

  // ---------------------------------------------------------------------
  // Gate Parser Telegram P0 — idempotency hardening, ambiguitas, fail-closed.
  // ---------------------------------------------------------------------

  it("27. toko ambigu (dua customer nama sama persis) -> customerId null -> Gate 3E-D4-C7 Temuan #4: order DITOLAK (invalid_customer, zero writes) -- kontrak baru tidak lagi mengizinkan customer tidak cocok tepat satu lolos sebagai draft", async () => {
    const products = [{ name: "Barang S", id: "prod-s-27", price: 10000 }];
    const deps = makeDeps({
      ...productKnowledge(products),
      customerAliases: [
        { aliasText: "toko kembar-a", customerId: "cust-a", customerName: "Toko Kembar", customerCode: "CA", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "toko kembar-b", customerId: "cust-b", customerName: "Toko Kembar", customerCode: "CB", updatedAt: "2026-01-01T00:00:00Z" },
      ],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);

    const result = await processTelegramUpdate(
      textUpdate(110, "Order Toko Kembar:\nBarang S 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_customer");
    expect(deps.repository.getEventRecord(110)?.status).toBe("not_order");
    // Balasan meminta klarifikasi (nama lebih spesifik), bukan sekadar "tidak dikenali" generik.
    expect(deps.sender.sent[0]!.text).toContain("lebih spesifik");
  });

  it("28. produk ambigu (dua produk nama sama persis) -> productId null -> Gate 3E-D4-C7: order DITOLAK (invalid_product, zero writes) -- kontrak harga baru tidak lagi mengizinkan produk tidak cocok tepat satu lolos sebagai draft", async () => {
    const customers = [{ name: "Toko T", id: "cust-t-28" }];
    const deps = makeDeps({
      productAliases: [
        { aliasText: "cat kembar-a", productId: "prod-a", productName: "Cat Kembar", productCode: "PA", updatedAt: "2026-01-01T00:00:00Z" },
        { aliasText: "cat kembar-b", productId: "prod-b", productName: "Cat Kembar", productCode: "PB", updatedAt: "2026-01-01T00:00:00Z" },
      ],
      ...customerKnowledge(customers),
    });
    registerSales(deps.repository);
    seedCustomers(deps.repository, customers);

    const result = await processTelegramUpdate(
      textUpdate(111, "Order Toko T:\nCat Kembar 2 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_product");
    expect(deps.repository.getEventRecord(111)?.status).toBe("not_order");
  });

  it("29. duplicate concurrent (race) pada insertEvent -> request kedua ditolak di level 'DB' (unique constraint), bukan diam-diam menimpa event pertama", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);

    // Simulasikan dua request bersamaan yang SAMA-SAMA lolos pre-check
    // findEventByUpdateId (race) sebelum salah satu sempat insertEvent.
    const preCheck1 = await deps.repository.findEventByUpdateId(70);
    const preCheck2 = await deps.repository.findEventByUpdateId(70);
    expect(preCheck1).toBeNull();
    expect(preCheck2).toBeNull();

    const first = await deps.repository.insertEvent({
      telegramUpdateId: 70,
      companyId: COMPANY_ID,
      telegramIdentityId: "identity-1",
      messageType: "text",
      processingStatus: "received",
      rawPayload: { marker: "first" },
    });
    expect(first.id).toBeDefined();

    await expect(
      deps.repository.insertEvent({
        telegramUpdateId: 70,
        companyId: COMPANY_ID,
        telegramIdentityId: "identity-1",
        messageType: "text",
        processingStatus: "received",
        rawPayload: { marker: "second" },
      }),
    ).rejects.toThrow(DuplicateUpdateEventError);

    // Hanya SATU event kanonik yang tersimpan -- payload request pertama,
    // TIDAK tertimpa oleh request kedua yang kalah race.
    const record = deps.repository.getEventRecord(70);
    expect(record?.rawPayload).toEqual({ marker: "first" });
  });

  it("30. update_id sama dengan payload BERBEDA -> ditolak sebagai conflict (fail-closed), raw_payload asli TIDAK berubah, tidak ada order kedua", async () => {
    const products = [{ name: "Barang Q", id: "prod-q-30", price: 10000 }];
    const customers = [{ name: "Toko K", id: "cust-k-30" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const first = await processTelegramUpdate(
      textUpdate(80, "Order Toko K:\nBarang Q 1 dus harga 10000"),
      deps,
    );
    expect(first.outcome).toBe("draft_created");
    const originalRecord = deps.repository.getEventRecord(80);
    const originalPayload = originalRecord?.rawPayload;
    expect(originalPayload).not.toBeNull();

    // update_id SAMA (80) tapi isi pesan berbeda -- bukan retry sah (Telegram
    // tidak pernah mengubah isi update untuk update_id yang sama), harus
    // ditolak fail-closed, bukan diperlakukan sebagai duplicate biasa.
    const conflicting = await processTelegramUpdate(
      textUpdate(80, "Order Toko LAIN:\nBarang Beda 9 dus harga 99999"),
      deps,
    );
    expect(conflicting.outcome).toBe("duplicate_conflict");

    const afterRecord = deps.repository.getEventRecord(80);
    expect(afterRecord?.rawPayload).toEqual(originalPayload); // tidak diubah sama sekali
    expect(deps.sender.sent.length).toBe(1); // tidak ada balasan/order tambahan dari request konflik
  });

  it("31. Knowledge Pack provider gagal (mis. DB down) -> fail-closed: event ditandai error, TIDAK ADA order tercipta, pesan asli tetap tersimpan, balasan generik dikirim", async () => {
    class ThrowingKnowledgeProvider implements KnowledgeProvider {
      async getContext(): Promise<KnowledgeContext> {
        throw new Error("simulated provider/DB failure");
      }
      async submitCandidate(): Promise<void> {
        // no-op
      }
    }

    const repository = new InMemorySalesOrderRepository();
    const deps: WorkflowDeps = {
      repository,
      knowledgeProvider: new ThrowingKnowledgeProvider(),
      sender: new RecordingTelegramSender(),
      deliveryRepository: new InMemoryDeliveryRepository(),
      enrollmentRepository: new InMemoryTelegramEnrollmentRepository(),
    };
    registerSales(repository);

    const result = await processTelegramUpdate(
      textUpdate(90, "Order Toko M:\nBarang R 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("processing_error");

    const record = repository.getEventRecord(90);
    expect(record?.status).toBe("error");
    expect(record?.rawPayload).not.toBeNull(); // pesan asli tetap aman tersimpan
    expect((deps.sender as RecordingTelegramSender).sent[0]!.text).toContain("gangguan teknis");
  });

  it("32. pesan asli tersimpan byte-for-byte meski mengandung emoji/karakter khusus/typo", async () => {
    const products = [{ name: "Barang Ünïcödé — typo ringgan", id: "prod-emoji-32", price: 10000 }];
    const customers = [{ name: "Toko Emoji 🎉😀", id: "cust-emoji-32" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);
    const text = "Order Toko Emoji 🎉😀:\nBarang Ünïcödé — typo ringgan 2 dus harga 10000";

    const result = await processTelegramUpdate(textUpdate(100, text), deps);
    expect(result.outcome).toBe("draft_created");

    const record = deps.repository.getEventRecord(100);
    const storedPayload = record?.rawPayload as TelegramUpdate | null;
    expect(storedPayload?.message?.text).toBe(text);
  });

  // ---------------------------------------------------------------------
  // Gate 3E-D3-A -- Sales Auto-Attribution Enforcement (Telegram)
  // ---------------------------------------------------------------------

  it("33. toko dikenali dan milik Sales pemesan sendiri -> draft dibuat, attribution = Sales pemesan", async () => {
    const products = [{ name: "Barang A", id: "prod-a-33", price: 10000 }];
    const deps = makeDeps({
      ...productKnowledge(products),
      customerAliases: [
        {
          aliasText: "toko milik sendiri",
          customerId: "cust-own",
          customerName: "Toko Milik Sendiri",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    deps.repository.seedCustomer("cust-own", {
      companyId: COMPANY_ID,
      isActive: true,
      assignedSalesId: USER_ID,
    });

    const result = await processTelegramUpdate(
      textUpdate(101, "Order Toko Milik Sendiri:\nBarang A 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.customerId).toBe("cust-own");
    const audit = deps.repository.getAuditTrail();
    expect(audit.find((e) => e.entityId === result.orderId)?.actorId).toBe(USER_ID);
  });

  it("34. toko dikenali tapi milik Sales LAIN -> order ditolak (customer_not_owned), tidak ada draft tersimpan, balasan aman", async () => {
    const deps = makeDeps({
      customerAliases: [
        {
          aliasText: "toko sales lain",
          customerId: "cust-other-sales",
          customerName: "Toko Sales Lain",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    deps.repository.seedCustomer("cust-other-sales", {
      companyId: COMPANY_ID,
      isActive: true,
      assignedSalesId: "user-other-sales",
    });

    const result = await processTelegramUpdate(
      textUpdate(102, "Order Toko Sales Lain:\nBarang B 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("customer_not_owned");

    expect(deps.repository.getEventRecord(102)?.status).toBe("not_order");
    const reply = deps.sender.sent[0]!.text;
    expect(reply).toContain("Toko ini terdaftar milik Sales lain");
    // Tidak membocorkan identitas pemilik toko yang sebenarnya.
    expect(reply).not.toContain("user-other-sales");
  });

  it("35. toko dikenali tapi BELUM ter-attribute (assignedSalesId kosong) -> draft tetap dibuat (kontrak existing, bukan self-claim)", async () => {
    const products = [{ name: "Barang C", id: "prod-c-35", price: 10000 }];
    const deps = makeDeps({
      ...productKnowledge(products),
      customerAliases: [
        {
          aliasText: "toko belum ada sales",
          customerId: "cust-unassigned",
          customerName: "Toko Belum Ada Sales",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    deps.repository.seedCustomer("cust-unassigned", { companyId: COMPANY_ID, isActive: true });

    const result = await processTelegramUpdate(
      textUpdate(103, "Order Toko Belum Ada Sales:\nBarang C 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");
    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.customerId).toBe("cust-unassigned");
  });

  it("36. UBAH lalu koreksi mengarah ke toko milik Sales lain -> koreksi ditolak, draft ASLI tidak berubah (tidak ada mutasi parsial)", async () => {
    const products = [{ name: "Barang D", id: "prod-d-36", price: 10000 }];
    const deps = makeDeps({
      ...productKnowledge(products),
      customerAliases: [
        {
          aliasText: "toko lama",
          customerId: "cust-mine",
          customerName: "Toko Lama",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          aliasText: "toko sales lain koreksi",
          customerId: "cust-other-sales-2",
          customerName: "Toko Sales Lain Koreksi",
          customerCode: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    deps.repository.seedCustomer("cust-mine", {
      companyId: COMPANY_ID,
      isActive: true,
      assignedSalesId: USER_ID,
    });
    deps.repository.seedCustomer("cust-other-sales-2", {
      companyId: COMPANY_ID,
      isActive: true,
      assignedSalesId: "user-other-sales-2",
    });

    const created = await processTelegramUpdate(
      textUpdate(104, "Order Toko Lama:\nBarang D 1 dus harga 10000"),
      deps,
    );
    if (created.outcome !== "draft_created") throw new Error("unexpected outcome");

    const ubah = await processTelegramUpdate(textUpdate(105, "UBAH"), deps);
    expect(ubah.outcome).toBe("awaiting_correction");

    const corrected = await processTelegramUpdate(
      textUpdate(106, "Order Toko Sales Lain Koreksi:\nBarang D 1 dus harga 10000"),
      deps,
    );
    expect(corrected.outcome).toBe("order_rejected");
    if (corrected.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(corrected.reason).toBe("customer_not_owned");

    // Draft asli tidak berubah -- masih menunjuk toko semula, bukan toko yang ditolak.
    const order = await deps.repository.getOrder(created.orderId);
    expect(order?.priced.customerId).toBe("cust-mine");
  });

  // ---------------------------------------------------------------------
  // Gate 3E-D4-C7 -- Command KONFIRMASI toleran typo tunggal (bukti langsung
  // raw_payload SO-2608-0001, hosted mcbwgvtkhykrrtvbpeys: Salma mengetik
  // "Konfimasi", huruf 'r' hilang, GAGAL dikenali dan jatuh ke parser order
  // sebelum fix ini).
  // ---------------------------------------------------------------------

  it("37. draft menunggu konfirmasi + typo tunggal 'Konfimasi' (huruf hilang) -> TETAP dikenali sebagai KONFIRMASI, order confirmed, tidak diteruskan ke parser order", async () => {
    const products = [{ name: "Barang Typo", id: "prod-typo-37", price: 10000 }];
    const customers = [{ name: "Toko Typo", id: "cust-typo-37" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const created = await processTelegramUpdate(
      textUpdate(120, "Order Toko Typo:\nBarang Typo 1 dus harga 10000"),
      deps,
    );
    if (created.outcome !== "draft_created") throw new Error("unexpected outcome");

    // Reproduksi PERSIS input asli Salma (bukan skenario yang dikarang).
    const result = await processTelegramUpdate(textUpdate(121, "Konfimasi"), deps);
    expect(result.outcome).toBe("confirmed");
    if (result.outcome !== "confirmed") throw new Error("unexpected outcome");
    expect(result.orderId).toBe(created.orderId);

    const order = await deps.repository.getOrder(created.orderId);
    expect(order?.status).toBe("confirmed");
    // Command TIDAK PERNAH masuk parser order -- tidak ada draft/order baru
    // tercipta akibat "Konfimasi", event ditandai processed (bukan not_order).
    expect(deps.repository.getEventRecord(121)?.status).toBe("processed");
  });

  it("38. retry command typo yang sama ('Konfimasi' dua kali) -> idempotent, tidak ada efek KPI/order ganda", async () => {
    const products = [{ name: "Barang Typo Dua", id: "prod-typo-38", price: 10000 }];
    const customers = [{ name: "Toko Typo Dua", id: "cust-typo-38" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const created = await processTelegramUpdate(
      textUpdate(122, "Order Toko Typo Dua:\nBarang Typo Dua 1 dus harga 10000"),
      deps,
    );
    if (created.outcome !== "draft_created") throw new Error("unexpected outcome");

    const first = await processTelegramUpdate(textUpdate(123, "Konfimasi"), deps);
    expect(first.outcome).toBe("confirmed");
    if (first.outcome !== "confirmed") throw new Error("unexpected outcome");
    expect(first.alreadyConfirmed).toBe(false);

    const second = await processTelegramUpdate(textUpdate(124, "Konfimasi"), deps);
    expect(second.outcome).toBe("confirmed");
    if (second.outcome !== "confirmed") throw new Error("unexpected outcome");
    expect(second.alreadyConfirmed).toBe(true);
    expect(second.orderId).toBe(first.orderId);
  });

  it("39. toleransi typo TIDAK menyebabkan teks order baru yang mirip pendek salah dikenali sebagai KONFIRMASI (batas blast-radius: panjang teks jauh berbeda dari 10 huruf 'KONFIRMASI')", async () => {
    const products = [{ name: "Barang Aman", id: "prod-aman-39", price: 10000 }];
    const customers = [{ name: "Toko Aman", id: "cust-aman-39" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const created = await processTelegramUpdate(
      textUpdate(125, "Order Toko Aman:\nBarang Aman 1 dus harga 10000"),
      deps,
    );
    if (created.outcome !== "draft_created") throw new Error("unexpected outcome");

    // Pesan pendek TIDAK NYAMBUNG dengan "KONFIRMASI" (beda total, bukan
    // sekadar satu huruf hilang) -- harus tetap diperlakukan sebagai upaya
    // order baru (draft lama tidak berubah), bukan disalahartikan konfirmasi.
    const result = await processTelegramUpdate(textUpdate(126, "oke siap"), deps);
    expect(result.outcome).not.toBe("confirmed");

    const order = await deps.repository.getOrder(created.orderId);
    expect(order?.status).toBe("draft"); // draft asli TIDAK ikut ter-konfirmasi
  });

  // ---------------------------------------------------------------------
  // Gate 3E-D4-C7 Temuan #4 -- field-language parsing: variasi bahasa
  // lapangan Sales dipetakan via word-containment (bukan exact alias),
  // HANYA jika hasilnya unik; ambigu/tidak ditemukan -> zero writes.
  // ---------------------------------------------------------------------

  it("40. customer disingkat ('Warna Jaya' utk 'Toko Warna Jaya Bangunan') TANPA alias terpublikasi -> resolve via katalog kanonik langsung, draft dibuat dengan customerId yang benar", async () => {
    const products = [{ name: "Cat tembok exterior 20 kg", id: "prod-cat-ext-40", price: 125_000 }];
    const deps = makeDeps({
      ...productKnowledge(products),
      // SENGAJA tanpa customerAliases -- membuktikan fallback bekerja dari
      // katalog kanonik customers langsung, bukan hanya via alias terpublikasi.
      customers: [{ customerId: "cust-warna-jaya-40", customerName: "Toko Warna Jaya Bangunan", customerCode: null, isActive: true }],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    deps.repository.seedCustomer("cust-warna-jaya-40", { companyId: COMPANY_ID, isActive: true });

    const result = await processTelegramUpdate(
      textUpdate(130, "Order Warna Jaya:\nCat tembok exterior 20 kg 10 pail"),
      deps,
    );
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.customerId).toBe("cust-warna-jaya-40");
    expect(order?.priced.items[0]!.productId).toBe("prod-cat-ext-40");
    expect(order?.priced.items[0]!.unitPrice).toBe(125_000); // harga master, bukan 0
  });

  it("41. product name disingkat ('cat exterior' utk 'Cat Tembok Exterior 20 Kg') TANPA alias -> resolve via katalog kanonik, harga master benar (bukan Rp0)", async () => {
    const customers = [{ name: "Toko Cat Jaya", id: "cust-catjaya-41" }];
    const deps = makeDeps({
      ...customerKnowledge(customers),
      products: [{ productId: "prod-ext-41", productName: "Cat Tembok Exterior 20 Kg", productCode: null, price: 130_000, isActive: true }],
    });
    registerSales(deps.repository);
    seedCustomers(deps.repository, customers);
    deps.repository.seedProduct("prod-ext-41", { companyId: COMPANY_ID, isActive: true, price: 130_000 });

    const result = await processTelegramUpdate(
      textUpdate(131, "Order Toko Cat Jaya:\ncat exterior 10 pail"),
      deps,
    );
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.items[0]!.productId).toBe("prod-ext-41");
    expect(order?.priced.items[0]!.unitPrice).toBe(130_000);
    expect(order?.priced.estimatedTotal).toBe(1_300_000); // 10 x 130.000, BUKAN Rp0
  });

  it("42. product name via word-containment cocok LEBIH DARI SATU produk kanonik -> ambigu, order DITOLAK (invalid_product), TIDAK menebak salah satu", async () => {
    const customers = [{ name: "Toko Cat Ganda", id: "cust-catganda-42" }];
    const deps = makeDeps({
      ...customerKnowledge(customers),
      products: [
        { productId: "prod-ext-red-42", productName: "Cat Tembok Exterior Merah", productCode: null, price: 130_000, isActive: true },
        { productId: "prod-ext-blue-42", productName: "Cat Tembok Exterior Biru", productCode: null, price: 130_000, isActive: true },
      ],
    });
    registerSales(deps.repository);
    seedCustomers(deps.repository, customers);
    deps.repository.seedProduct("prod-ext-red-42", { companyId: COMPANY_ID, isActive: true, price: 130_000 });
    deps.repository.seedProduct("prod-ext-blue-42", { companyId: COMPANY_ID, isActive: true, price: 130_000 });

    const result = await processTelegramUpdate(
      textUpdate(132, "Order Toko Cat Ganda:\ncat tembok exterior 10 pail"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_product");
    expect(deps.repository.getEventRecord(132)?.status).toBe("not_order");
  });

  it("43. customer sama sekali TIDAK ditemukan di katalog manapun (bukan exact, bukan containment) -> order DITOLAK, zero writes, balasan meminta klarifikasi", async () => {
    const products = [{ name: "Barang Aneka", id: "prod-aneka-43", price: 10000 }];
    const deps = makeDeps({
      ...productKnowledge(products),
      customers: [{ customerId: "cust-lain-43", customerName: "Toko Sama Sekali Berbeda", customerCode: null, isActive: true }],
    });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    deps.repository.seedCustomer("cust-lain-43", { companyId: COMPANY_ID, isActive: true });

    const result = await processTelegramUpdate(
      textUpdate(133, "Order Toko Antah Berantah:\nBarang Aneka 1 dus harga 10000"),
      deps,
    );
    expect(result.outcome).toBe("order_rejected");
    if (result.outcome !== "order_rejected") throw new Error("unexpected outcome");
    expect(result.reason).toBe("invalid_customer");
    expect(deps.repository.getEventRecord(133)?.status).toBe("not_order");
    expect(deps.sender.sent[0]!.text).toContain("lebih spesifik");
  });

  it("44. satuan sinonim umum ('kilo') dinormalisasi ke bentuk kanonik ('kg') tanpa perlu alias tenant", async () => {
    const products = [{ name: "Beras Premium", id: "prod-beras-44", price: 15_000 }];
    const customers = [{ name: "Toko Sembako Jaya", id: "cust-sembako-44" }];
    const deps = makeDeps({ ...productKnowledge(products), ...customerKnowledge(customers) });
    registerSales(deps.repository);
    seedProducts(deps.repository, products);
    seedCustomers(deps.repository, customers);

    const result = await processTelegramUpdate(
      textUpdate(134, "Order Toko Sembako Jaya:\nBeras Premium 20 kilo harga 15000"),
      deps,
    );
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.priced.items[0]!.unit).toBe("kg");
  });
});
