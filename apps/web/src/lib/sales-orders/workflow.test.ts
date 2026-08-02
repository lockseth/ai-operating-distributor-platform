// =============================================================================
// Test — Telegram Sales Order Entry workflow.
// Menutup 10 skenario DoD + UBAH/knowledge_candidate + discount policy,
// seluruhnya tanpa Supabase/Telegram sungguhan (in-memory fakes).
// =============================================================================

import { describe, it, expect } from "vitest";
import { processTelegramUpdate, type WorkflowDeps } from "./workflow";
import { InMemorySalesOrderRepository } from "./repository";
import { InMemoryKnowledgeProvider } from "./knowledge-provider";
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

describe("Telegram Sales Order workflow", () => {
  it("1. pesan order lengkap -> draft dibuat, total & diskon terhitung benar", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
    const text = "Order Toko F:\nBarang Z 2 dus harga 10000";

    const first = await processTelegramUpdate(textUpdate(8, text), deps);
    expect(first.outcome).toBe("draft_created");
    const sentCountAfterFirst = deps.sender.sent.length;

    const second = await processTelegramUpdate(textUpdate(8, text), deps); // update_id sama
    expect(second.outcome).toBe("duplicate_update");
    expect(deps.sender.sent.length).toBe(sentCountAfterFirst); // tidak ada balasan tambahan
  });

  it("9. KONFIRMASI berulang tidak membuat transaksi ganda", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);

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
    const deps = makeDeps({
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
    const deps = makeDeps(); // tidak ada discount policy sama sekali
    registerSales(deps.repository);

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
    const deps = makeDeps();
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
    const text = "Order Toko Abadi:\nGula 10 dus harga 250 ribu";

    const result = await processTelegramUpdate(textUpdate(16, text), deps);
    expect(result.outcome).toBe("draft_created");
    if (result.outcome !== "draft_created") throw new Error("unexpected outcome");

    const order = await deps.repository.getOrder(result.orderId);
    expect(order?.orderSource).toBe("OTHER");
    expect(order?.status).toBe("draft");
  });

  it("17. UBAH lalu koreksi -> order source ikut diperbarui sesuai teks koreksi terbaru", async () => {
    const deps = makeDeps();
    registerSales(deps.repository);

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
    const deps = makeDeps();
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
    const deps = makeDeps();
    registerSales(deps.repository);
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
    });
    registerSales(deps.repository);
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
    });
    registerSales(deps.repository);
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
    const deps = makeDeps();
    registerSales(deps.repository);
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
});
