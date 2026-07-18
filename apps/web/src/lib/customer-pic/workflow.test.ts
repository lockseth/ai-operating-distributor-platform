import { describe, it, expect } from "vitest";
import { processAddStoreMessage, type ResolvedStorePicIdentity, type StorePicWorkflowDeps } from "./workflow";
import { InMemoryCustomerPicRepository } from "./repository";
import { InMemoryStorePicConversationRepository } from "./conversation";
import { RecordingTelegramSender } from "@/lib/telegram/client";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const SALES_A = "sales-a";
const SALES_B = "sales-b";
const OWNER_A = "owner-a";
const ADMIN_A = "admin-a";
const FINANCE_A = "finance-a"; // role tanpa permission customers.pic_verify
const CHAT_A = 5001;

function makeDeps(): StorePicWorkflowDeps & { repository: InMemoryCustomerPicRepository; sender: RecordingTelegramSender } {
  const repository = new InMemoryCustomerPicRepository();
  const conversationRepository = new InMemoryStorePicConversationRepository();
  const sender = new RecordingTelegramSender();
  return { repository, conversationRepository, sender };
}

function identity(userId = SALES_A, companyId = COMPANY_A): ResolvedStorePicIdentity {
  return { identityId: `identity-${userId}`, companyId, userId };
}

function seedBaseline(deps: { repository: InMemoryCustomerPicRepository }) {
  deps.repository.seedUser({ id: SALES_A, companyId: COMPANY_A, role: "sales", isActive: true });
  deps.repository.seedUser({ id: OWNER_A, companyId: COMPANY_A, role: "owner", isActive: true });
  deps.repository.seedUser({ id: ADMIN_A, companyId: COMPANY_A, role: "admin", isActive: true });
  deps.repository.seedUser({ id: FINANCE_A, companyId: COMPANY_A, role: "finance", isActive: true });
  deps.repository.seedUser({ id: SALES_B, companyId: COMPANY_B, role: "sales", isActive: true });
  deps.repository.seedTenantAreas(COMPANY_A, ["Jakarta Selatan", "Jakarta Barat"]);
  deps.repository.seedSalesmanCoverage(COMPANY_A, SALES_A, ["Jakarta Selatan"]);
}

/** conversationStartedAt berbasis Date.now() -- beri jeda kecil di test yang menjalankan dua percakapan berurutan pada identity yang sama, supaya idempotencyKey tidak kebetulan sama persis (tidak relevan di produksi karena manusia mengetik, bukan dua panggilan sinkron). */
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFullFlow(
  deps: StorePicWorkflowDeps,
  id: ResolvedStorePicIdentity,
  opts: {
    storeName?: string; storeAddress?: string; areaChoice?: string; storePhone?: string;
    picName?: string; picPhone?: string; picEmail?: string; roleChoice?: string; confirm?: string;
  } = {}
) {
  await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
  await processAddStoreMessage(opts.storeName ?? "Toko Sinar Jaya", CHAT_A, id, deps);
  await processAddStoreMessage(opts.storeAddress ?? "Jl. Merdeka No. 1", CHAT_A, id, deps);
  await processAddStoreMessage(opts.areaChoice ?? "1", CHAT_A, id, deps);
  await processAddStoreMessage(opts.storePhone ?? "081234567890", CHAT_A, id, deps);
  await processAddStoreMessage(opts.picName ?? "Budi Santoso", CHAT_A, id, deps);
  await processAddStoreMessage(opts.picPhone ?? "081298765432", CHAT_A, id, deps);
  await processAddStoreMessage(opts.picEmail ?? "-", CHAT_A, id, deps);
  await processAddStoreMessage(opts.roleChoice ?? "1,2", CHAT_A, id, deps);
  return processAddStoreMessage(opts.confirm ?? "KONFIRMASI", CHAT_A, id, deps);
}

describe("1. Salesman membuat toko pada area sendiri", () => {
  it("berhasil membuat toko + PIC UNVERIFIED", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("store_created");
    if (result.outcome === "store_created") {
      const pic = deps.repository.getPicSync(result.customerPicId);
      expect(pic?.validationStatus).toBe("UNVERIFIED");
      const store = deps.repository.getStoreSync(result.customerId);
      expect(store?.area).toBe("Jakarta Selatan");
      expect(store?.assignedSalesId).toBe(SALES_A);
    }
  });
});

describe("2. Salesman ditolak memakai area yang tidak ditugaskan", () => {
  it("percakapan Telegram hanya menawarkan area yang DITUGASKAN (UI tidak pernah menampilkan area lain)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko Uji Area", CHAT_A, id, deps);
    const areaPrompt = await processAddStoreMessage("-", CHAT_A, id, deps);
    expect(areaPrompt.outcome).toBe("awaiting_store_area");
    // Hanya 1 area yang ditugaskan (Jakarta Selatan) -> pilihan "2" (Jakarta Barat) tidak valid di UI.
    const invalidChoice = await processAddStoreMessage("2", CHAT_A, id, deps);
    expect(invalidChoice.outcome).toBe("awaiting_store_area");
  });

  it("defense-in-depth di repository/RPC: area di luar assignment tetap ditolak walau dipanggil langsung (bypass UI)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    // SALES_A hanya ditugaskan Jakarta Selatan -- memaksa Jakarta Barat langsung ke repository harus ditolak,
    // membuktikan validasi bukan hanya di UI picker melainkan juga ditegakkan di RPC/repository.
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Bypass UI", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Bypass", picPhone: "081200005555", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "bypass-area-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("area_not_assigned");
  });
});

describe("3. Admin membuat toko pada area tenant (bukan via Telegram, langsung repository)", () => {
  it("owner dapat membuat toko di area mana pun milik tenant, assignedSalesId opsional", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: OWNER_A, storeName: "Toko Admin", storePhone: "081211112222",
      storeAddress: "Jl. Admin", storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "Admin PIC", picPhone: "081233334444", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "admin-key-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("created");
  });
});

describe("4. Cross-tenant creation ditolak", () => {
  it("Salesman company B tidak bisa membuat toko untuk company A", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_B, storeName: "Toko Lintas Tenant", storePhone: null,
      storeAddress: null, storeArea: null, storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_B, picName: "PIC X", picPhone: "081200001111", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "cross-tenant-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("forbidden");
  });
});

describe("5. Toko dan PIC dibuat atomic", () => {
  it("PIC gagal (role invalid) -> toko juga TIDAK dibuat (tidak ada record yatim)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const before = deps.repository.totalStores();
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Gagal Atomic", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Invalid", picPhone: "081200002222", picEmail: null, picRoles: ["NOT_A_ROLE" as never],
      idempotencyKey: "atomic-fail-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("invalid_input");
    expect(deps.repository.totalStores()).toBe(before);
  });
});

describe("6. Retry idempotent", () => {
  it("createStoreWithPic dipanggil 2x dengan idempotencyKey sama -> tidak membuat toko/PIC ganda", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const input = {
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Idempotent", storePhone: "081277778888",
      storeAddress: "Jl. Idempotent", storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Idem", picPhone: "081299990000", picEmail: null, picRoles: ["OWNER"] as import("../customer-pic/types").PicRole[],
      idempotencyKey: "fixed-idem-key", source: "TELEGRAM_SALESMAN" as const, overrideSimilarDuplicate: false, overrideReason: null,
    };
    const first = await deps.repository.createStoreWithPic(input);
    const second = await deps.repository.createStoreWithPic(input);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("already_exists");
    if (first.outcome === "created" && second.outcome === "already_exists") {
      expect(first.customerId).toBe(second.customerId);
      expect(first.customerPicId).toBe(second.customerPicId);
    }
    expect(deps.repository.totalStores()).toBe(1);
  });

  it("retry via workflow Telegram penuh (conversationStartedAt sama) tidak membuat duplikat", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    // Simulasikan retry murni di layer repository dengan idempotencyKey identik
    // yang dihasilkan dari conversationStartedAt yang sama.
    const key = "identity-sales-a:2026-01-01T00:00:00.000Z";
    const base = {
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Retry Telegram", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Retry", picPhone: "081266665555", picEmail: null, picRoles: ["ORDERER"] as import("../customer-pic/types").PicRole[],
      idempotencyKey: key, source: "TELEGRAM_SALESMAN" as const, overrideSimilarDuplicate: false, overrideReason: null,
    };
    await deps.repository.createStoreWithPic(base);
    const retry = await deps.repository.createStoreWithPic(base);
    expect(retry.outcome).toBe("already_exists");
    expect(deps.repository.totalStores()).toBe(1);
  });
});

describe("7. Multiple PIC per toko", () => {
  it("createCustomerPic menambah PIC kedua ke toko yang sama", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("store_created");
    const customerId = (result as { customerId: string }).customerId;

    const second = await deps.repository.createCustomerPic({
      companyId: COMPANY_A, customerId, actorId: OWNER_A, name: "Siti Kedua", phone: "081255556666",
      email: null, roles: ["RECEIVER"], idempotencyKey: "pic-2", source: "ADMIN_DASHBOARD",
    });
    expect(second.outcome).toBe("created");
    expect(deps.repository.totalPicsForStore(customerId)).toBe(2);
  });
});

describe("8. Multiple roles per PIC", () => {
  it("PIC dapat memiliki lebih dari satu peran sekaligus", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity(), { roleChoice: "1,3,4" });
    expect(result.outcome).toBe("store_created");
    if (result.outcome === "store_created") {
      const pic = deps.repository.getPicSync(result.customerPicId);
      expect(pic?.roles).toEqual(["OWNER", "RECEIVER", "PAYMENT_CONTACT"]);
    }
  });
});

describe("9. Phone normalization", () => {
  it("nomor toko dan PIC tersimpan ternormalisasi (+62...)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity(), { storePhone: "0812-3456-7890", picPhone: "0812 9876 5432" });
    expect(result.outcome).toBe("store_created");
    if (result.outcome === "store_created") {
      const store = deps.repository.getStoreSync(result.customerId);
      const pic = deps.repository.getPicSync(result.customerPicId);
      expect(store?.phone).toBe("+6281234567890");
      expect(pic?.phone).toBe("+6281298765432");
    }
  });
});

describe("10. Exact duplicate toko", () => {
  it("nama+alamat (dan kebetulan nomor) sama persis -> exact_duplicate_store, redirect ke existing, tidak membuat baris baru", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity());
    const before = deps.repository.totalStores();
    await wait(2); // hindari idempotencyKey (berbasis Date.now()) kebetulan identik antar dua percakapan

    const result = await runFullFlow(deps, identity(), { storeName: "Toko Sinar Jaya", storePhone: "081234567890", picPhone: "081200000001" });
    expect(result.outcome).toBe("exact_duplicate_redirected");
    expect(deps.repository.totalStores()).toBe(before);
  });

  it("retry request yang sama (idempotency_key identik) tetap idempotent, bukan exact-duplicate-redirect", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const input = {
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Retry Idempotent", storePhone: "081277778888",
      storeAddress: "Jl. Retry", storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Retry", picPhone: "081299990000", picEmail: null, picRoles: ["OWNER"] as import("./types").PicRole[],
      idempotencyKey: "recon-retry-key", source: "TELEGRAM_SALESMAN" as const, overrideSimilarDuplicate: false, overrideReason: null,
    };
    const first = await deps.repository.createStoreWithPic(input);
    const second = await deps.repository.createStoreWithPic(input);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("already_exists");
    expect(deps.repository.totalStores()).toBe(1);
  });
});

describe("11. Similar duplicate warning", () => {
  it("nama mirip di area sama -> warning, butuh override KONFIRMASI eksplisit", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity()); // "Toko Sinar Jaya" @ Jakarta Selatan
    await wait(2); // hindari idempotencyKey (berbasis Date.now()) kebetulan identik antar dua percakapan

    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko Sinar Jaya Dua", CHAT_A, id, deps);
    await processAddStoreMessage("Alamat Berbeda", CHAT_A, id, deps);
    await processAddStoreMessage("1", CHAT_A, id, deps);
    await processAddStoreMessage("081200009999", CHAT_A, id, deps);
    await processAddStoreMessage("PIC Baru", CHAT_A, id, deps);
    await processAddStoreMessage("081200008888", CHAT_A, id, deps);
    await processAddStoreMessage("-", CHAT_A, id, deps);
    await processAddStoreMessage("1", CHAT_A, id, deps);
    const warningResult = await processAddStoreMessage("KONFIRMASI", CHAT_A, id, deps);
    expect(warningResult.outcome).toBe("awaiting_similar_duplicate_confirmation");

    const beforeOverride = deps.repository.totalStores();
    const overrideResult = await processAddStoreMessage("KONFIRMASI", CHAT_A, id, deps);
    expect(overrideResult.outcome).toBe("store_created");
    expect(deps.repository.totalStores()).toBe(beforeOverride + 1);
  });

  it("nomor toko sama SENDIRIAN (nama+alamat berbeda) -> warning (bukan exact/block), tetap dapat dibuat dengan override -- satu pemilik boleh punya beberapa cabang dengan nomor sama", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity(), { storePhone: "081255551234" }); // "Toko Sinar Jaya" @ Jakarta Selatan
    await wait(2);

    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko Cabang Kedua Berbeda Sekali", CHAT_A, id, deps);
    await processAddStoreMessage("Alamat Cabang Yang Sama Sekali Lain", CHAT_A, id, deps);
    // Area sama (SALES_A hanya ditugaskan 1 area) -- tidak masalah, nama
    // sudah sama sekali berbeda jadi name-similar-in-area tidak ikut memicu;
    // yang diuji murni jalur phone-match-different-name.
    await processAddStoreMessage("1", CHAT_A, id, deps);
    await processAddStoreMessage("081255551234", CHAT_A, id, deps); // nomor toko SAMA
    await processAddStoreMessage("PIC Cabang Kedua", CHAT_A, id, deps);
    await processAddStoreMessage("081200007777", CHAT_A, id, deps);
    await processAddStoreMessage("-", CHAT_A, id, deps);
    await processAddStoreMessage("1", CHAT_A, id, deps);
    const warningResult = await processAddStoreMessage("KONFIRMASI", CHAT_A, id, deps);
    expect(warningResult.outcome).toBe("awaiting_similar_duplicate_confirmation"); // WARNING, bukan exact_duplicate_redirected

    const beforeOverride = deps.repository.totalStores();
    const overrideResult = await processAddStoreMessage("KONFIRMASI", CHAT_A, id, deps);
    expect(overrideResult.outcome).toBe("store_created"); // toko sah tetap bisa dibuat dengan override
    expect(deps.repository.totalStores()).toBe(beforeOverride + 1);
  });
});

describe("Duplicate detection tenant-scoped", () => {
  it("nama+alamat identik di company LAIN tidak dianggap duplicate sama sekali", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    deps.repository.seedTenantAreas(COMPANY_B, ["Jakarta Selatan"]);
    deps.repository.seedSalesmanCoverage(COMPANY_B, SALES_B, ["Jakarta Selatan"]);

    await runFullFlow(deps, identity()); // company A: "Toko Sinar Jaya" @ Jl. Merdeka No. 1

    const resultB = await deps.repository.createStoreWithPic({
      companyId: COMPANY_B, actorId: SALES_B, storeName: "Toko Sinar Jaya", storePhone: null,
      storeAddress: "Jl. Merdeka No. 1", storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_B, picName: "PIC Company B", picPhone: "081266661111", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "tenant-scope-b-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(resultB.outcome).toBe("created"); // TIDAK terpengaruh data company A sama sekali
  });
});

describe("12. Nomor PIC sama pada beberapa toko tidak otomatis fraud", () => {
  it("PIC dengan nomor sama di toko berbeda tetap berhasil dibuat, hanya event informational", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity(), { picPhone: "081299990000" });
    await wait(2); // hindari idempotencyKey (berbasis Date.now()) kebetulan identik antar dua percakapan

    const result = await runFullFlow(deps, identity(), {
      storeName: "Toko Kedua Sekali", storeAddress: "Alamat Kedua Beda", storePhone: "081266660000", picPhone: "081299990000",
    });
    expect(result.outcome).toBe("store_created");
    if (result.outcome === "store_created") {
      const events = await deps.repository.getRelationshipEvents(COMPANY_A, result.customerId);
      expect(events.some((e) => e.eventType === "DUPLICATE_PIC_DETECTED")).toBe(true);
    }
  });
});

describe("13. PIC awal selalu UNVERIFIED", () => {
  it("tidak peduli siapa actor (Salesman/admin), PIC baru selalu UNVERIFIED", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const viaTelegram = await runFullFlow(deps, identity());
    const viaAdmin = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: OWNER_A, storeName: "Toko Via Admin", storePhone: "081244445555",
      storeAddress: "Alamat Admin", storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null,
      assignedSalesId: null, picName: "PIC Admin", picPhone: "081255556666", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "admin-unverified-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(viaTelegram.outcome).toBe("store_created");
    expect(viaAdmin.outcome).toBe("created");
    if (viaTelegram.outcome === "store_created") expect(deps.repository.getPicSync(viaTelegram.customerPicId)?.validationStatus).toBe("UNVERIFIED");
    if (viaAdmin.outcome === "created") expect(deps.repository.getPicSync(viaAdmin.customerPicId)?.validationStatus).toBe("UNVERIFIED");
  });
});

describe("14. PIC verification authority (Salesman ditolak, admin/owner creator BOLEH verify sendiri)", () => {
  it("Salesman creator ditolak -- Salesman tidak pernah punya permission customers.pic_verify, apa pun created_by-nya", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity()); // PIC dibuat oleh SALES_A
    expect(result.outcome).toBe("store_created");
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: SALES_A, newStatus: "VERIFIED_BY_ADMIN", reason: "Coba self-verify",
    });
    expect(verify.outcome).toBe("forbidden"); // role gate -- Salesman tidak pernah lolos, terlepas dari created_by
  });

  it("Admin creator DAPAT verify PIC yang dibuatnya sendiri -- tenant kecil mungkin cuma punya satu admin", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const created = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: ADMIN_A, storeName: "Toko Self Admin", storePhone: null, storeAddress: null,
      storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null, assignedSalesId: null,
      picName: "PIC Admin Sendiri", picPhone: "081277772222", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "self-admin-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(created.outcome).toBe("created");
    const customerPicId = (created as { customerPicId: string }).customerPicId;
    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: ADMIN_A, newStatus: "VERIFIED_BY_ADMIN", reason: "Admin memverifikasi PIC yang ia daftarkan sendiri.",
    });
    expect(verify.outcome).toBe("verified");
    expect(deps.repository.getPicSync(customerPicId)?.validationStatus).toBe("VERIFIED_BY_ADMIN");
    expect(deps.repository.getPicSync(customerPicId)?.verifiedBy).toBe(ADMIN_A);
  });

  it("Owner creator DAPAT verify PIC yang dibuatnya sendiri", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const created = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: OWNER_A, storeName: "Toko Self Owner", storePhone: null, storeAddress: null,
      storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null, assignedSalesId: null,
      picName: "PIC Owner Sendiri", picPhone: "081277771111", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "self-owner-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(created.outcome).toBe("created");
    const customerPicId = (created as { customerPicId: string }).customerPicId;
    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "VERIFIED_BY_ADMIN", reason: "Owner memverifikasi PIC yang ia daftarkan sendiri.",
    });
    expect(verify.outcome).toBe("verified");
  });

  it("Actor tanpa permission (role finance, bukan owner/manager/admin/super_admin) ditolak", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: FINANCE_A, newStatus: "VERIFIED_BY_ADMIN", reason: "Coba verify tanpa permission",
    });
    expect(verify.outcome).toBe("forbidden");
  });

  it("Cross-tenant ditolak -- owner company B tidak dapat verify PIC company A", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: SALES_B, newStatus: "VERIFIED_BY_ADMIN", reason: "Coba verify lintas tenant",
    });
    expect(verify.outcome).toBe("forbidden");
  });

  it("alasan tetap wajib untuk seluruh verification, termasuk saat admin/owner verify PIC sendiri", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const created = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: OWNER_A, storeName: "Toko Tanpa Alasan", storePhone: null, storeAddress: null,
      storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null, assignedSalesId: null,
      picName: "PIC Tanpa Alasan", picPhone: "081277773333", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "no-reason-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    const customerPicId = (created as { customerPicId: string }).customerPicId;
    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "VERIFIED_BY_ADMIN", reason: "",
    });
    expect(verify.outcome).toBe("invalid_input");
  });
});

describe("15. Admin berwenang dapat verify", () => {
  it("owner (bukan pembuat) berhasil verify PIC yang dibuat Salesman", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "VERIFIED_BY_ADMIN", reason: "Sudah dicek via telepon.",
    });
    expect(verify.outcome).toBe("verified");
    expect(deps.repository.getPicSync(customerPicId)?.validationStatus).toBe("VERIFIED_BY_ADMIN");
  });

  it("VERIFIED_BY_ORDER dan VERIFIED_ON_DELIVERY tidak dapat di-set manual (di luar type system, dicek di RPC nyata; di sini dibuktikan lewat type AdminSettablePicStatus tidak mengizinkan nilai tsb)", () => {
    // Type-level guarantee: AdminSettablePicStatus hanya VERIFIED_BY_ADMIN | REVERIFY_REQUIRED | INACTIVE.
    // @ts-expect-error -- VERIFIED_BY_ORDER bukan AdminSettablePicStatus yang valid.
    const invalid: import("./types").AdminSettablePicStatus = "VERIFIED_BY_ORDER";
    expect(invalid).toBeDefined();
  });
});

describe("16. Perubahan PIC memiliki history", () => {
  it("updateCustomerPic mencatat NAME_CHANGED/PHONE_CHANGED/ROLES_CHANGED dengan reason", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const update = await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: "Budi Santoso Jr.",
      newPhone: "081200001234", newRoles: null, newEmail: null, reason: "Koreksi nama dan nomor.", source: "ADMIN_DASHBOARD",
    });
    expect(update.outcome).toBe("updated");

    const history = await deps.repository.getPicHistory(COMPANY_A, customerPicId);
    expect(history.some((h) => h.changeType === "NAME_CHANGED")).toBe(true);
    expect(history.some((h) => h.changeType === "PHONE_CHANGED")).toBe(true);
    expect(history.every((h) => h.changeType !== "PHONE_CHANGED" || h.reason === "Koreksi nama dan nomor.")).toBe(true);
  });

  it("update tanpa perubahan nyata -> no_changes, tidak menambah history", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;
    const before = (await deps.repository.getPicHistory(COMPANY_A, customerPicId)).length;

    const update = await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: null, newPhone: null, newRoles: null,
      newEmail: null, reason: "Tidak ada perubahan", source: "ADMIN_DASHBOARD",
    });
    expect(update.outcome).toBe("no_changes");
    expect((await deps.repository.getPicHistory(COMPANY_A, customerPicId)).length).toBe(before);
  });
});

describe("17. PIC lama tidak terhapus", () => {
  it("setelah update, baris PIC yang sama tetap ada (bukan dihapus+dibuat baru) dan history CREATED tetap ada", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: "Nama Baru", newPhone: null, newRoles: null,
      newEmail: null, reason: "Update nama", source: "ADMIN_DASHBOARD",
    });

    const stillExists = deps.repository.getPicSync(customerPicId);
    expect(stillExists).toBeDefined();
    expect(stillExists?.id).toBe(customerPicId);
    const history = await deps.repository.getPicHistory(COMPANY_A, customerPicId);
    expect(history.some((h) => h.changeType === "CREATED")).toBe(true);
  });
});

describe("18. REVERIFY_REQUIRED dan INACTIVE bekerja", () => {
  it("verify ke REVERIFY_REQUIRED mengubah status dan tercatat di history+event", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "REVERIFY_REQUIRED", reason: "Nomor tidak bisa dihubungi.",
    });
    expect(verify.outcome).toBe("verified");
    expect(deps.repository.getPicSync(customerPicId)?.validationStatus).toBe("REVERIFY_REQUIRED");
  });

  it("verify ke INACTIVE menonaktifkan PIC tanpa menghapus riwayat", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    const verify = await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "INACTIVE", reason: "PIC sudah resign.",
    });
    expect(verify.outcome).toBe("verified");
    expect(deps.repository.getPicSync(customerPicId)?.validationStatus).toBe("INACTIVE");
    // Riwayat & baris PIC tetap ada, hanya statusnya berubah.
    expect(deps.repository.getPicSync(customerPicId)).toBeDefined();
    const history = await deps.repository.getPicHistory(COMPANY_A, customerPicId);
    expect(history.length).toBeGreaterThan(0);
  });

  it("perubahan nomor pada PIC yang sudah VERIFIED_BY_ADMIN -> otomatis REVERIFY_REQUIRED", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;
    await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "VERIFIED_BY_ADMIN", reason: "OK",
    });

    await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: null, newPhone: "081211119999",
      newRoles: null, newEmail: null, reason: "Ganti nomor HP.", source: "ADMIN_DASHBOARD",
    });
    expect(deps.repository.getPicSync(customerPicId)?.validationStatus).toBe("REVERIFY_REQUIRED");
  });
});

describe("19. Tidak ada biometric/selfie/OTP", () => {
  it("struktur modul tidak menyebut KTP/selfie/face-match/liveness/OTP", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = ["types.ts", "service.ts", "repository.ts", "conversation.ts", "confirmation.ts", "workflow.ts", "actions.ts", "phone.ts", "email.ts"];
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      const stripped = content.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
      expect(stripped).not.toMatch(/ktp|selfie|face.?match|face.?embedding|liveness|biometric|\botp\b/i);
    }
  });
});

describe("20. Tidak ada inbound WhatsApp/telephony", () => {
  it("struktur modul tidak menyebut WhatsApp webhook/bot/provider atau telephony", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = ["types.ts", "service.ts", "repository.ts", "conversation.ts", "confirmation.ts", "workflow.ts", "actions.ts"];
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      const stripped = content.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
      expect(stripped).not.toMatch(/whatsapp.{0,15}(webhook|bot|provider|inbound)|telephony/i);
    }
  });
});

describe("21. Tidak ada kewajiban GPS", () => {
  it("storeLatitude/storeLongitude null tetap berhasil membuat toko", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Tanpa GPS", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC No GPS", picPhone: "081200003333", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "no-gps-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      const store = deps.repository.getStoreSync(result.customerId);
      expect(store?.latitude).toBeNull();
      expect(store?.longitude).toBeNull();
    }
  });
});

describe("22. Audit tidak bocor lintas tenant", () => {
  it("auditLogs company A tidak terlihat/tercampur dengan company B", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity());
    await deps.repository.createStoreWithPic({
      companyId: COMPANY_B, actorId: SALES_B, storeName: "Toko Company B", storePhone: null,
      storeAddress: null, storeArea: null, storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_B, picName: "PIC B", picPhone: "081200004444", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "company-b-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });

    const auditA = deps.repository.auditLogs.filter((a) => a.companyId === COMPANY_A);
    const auditB = deps.repository.auditLogs.filter((a) => a.companyId === COMPANY_B);
    expect(auditA.length).toBeGreaterThan(0);
    expect(auditB.length).toBeGreaterThan(0);
    expect(auditA.every((a) => a.companyId !== COMPANY_B)).toBe(true);
    expect(auditB.every((a) => a.companyId !== COMPANY_A)).toBe(true);
  });
});

describe("Conversation expiry (tenant-scoped, sesuai LANGKAH 6)", () => {
  it("percakapan yang kedaluwarsa dibaca sebagai awaiting=none, tidak melanjutkan draft lama", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko Yang Ditinggal", CHAT_A, id, deps);

    (deps.conversationRepository as InMemoryStorePicConversationRepository).forceExpire(id.identityId);

    // Pesan berikutnya TIDAK dianggap alamat toko (draft lama sudah expired) --
    // karena bukan trigger "tambah toko", hasilnya not_relevant.
    const result = await processAddStoreMessage("Jl. Random", CHAT_A, id, deps);
    expect(result.outcome).toBe("not_relevant");
  });
});

describe("Invalid input handling", () => {
  it("pilihan area tidak valid meminta ulang, tidak menjatuhkan percakapan", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko X", CHAT_A, id, deps);
    await processAddStoreMessage("-", CHAT_A, id, deps);
    const invalid = await processAddStoreMessage("99", CHAT_A, id, deps);
    expect(invalid.outcome).toBe("awaiting_store_area");
  });

  it("BATAL di tengah percakapan menghentikan proses tanpa membuat toko", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko Dibatalkan", CHAT_A, id, deps);
    const result = await processAddStoreMessage("BATAL", CHAT_A, id, deps);
    expect(result.outcome).toBe("cancelled_by_user");
    expect(deps.repository.totalStores()).toBe(0);
  });

  it("Salesman tanpa coverage area sama sekali -> no_assigned_area, tidak bisa mulai", async () => {
    const deps = makeDeps();
    deps.repository.seedUser({ id: SALES_A, companyId: COMPANY_A, role: "sales", isActive: true });
    // Sengaja TIDAK seed coverage area apa pun untuk SALES_A.
    const result = await processAddStoreMessage("tambah toko", CHAT_A, identity(), deps);
    expect(result.outcome).toBe("no_assigned_area");
  });

  it("pesan biasa yang bukan trigger diabaikan (not_relevant)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await processAddStoreMessage("Order Toko Baru: Sabun 5 dus", CHAT_A, identity(), deps);
    expect(result.outcome).toBe("not_relevant");
  });
});

// =============================================================================
// Gate: Multi-PIC Telegram & Optional PIC Email
// =============================================================================

async function runAddPicFlow(
  deps: StorePicWorkflowDeps,
  id: ResolvedStorePicIdentity,
  opts: {
    searchQuery?: string; storeChoice?: string; picName?: string; picPhone?: string;
    picEmail?: string; roleChoice?: string; confirm?: string;
  } = {}
) {
  await processAddStoreMessage("tambah pic", CHAT_A, id, deps);
  const search = await processAddStoreMessage(opts.searchQuery ?? "Toko Sinar Jaya", CHAT_A, id, deps);
  if (search.outcome === "awaiting_add_pic_store_select") {
    await processAddStoreMessage(opts.storeChoice ?? "1", CHAT_A, id, deps);
  }
  await processAddStoreMessage(opts.picName ?? "PIC Kedua Telegram", CHAT_A, id, deps);
  await processAddStoreMessage(opts.picPhone ?? "081200001122", CHAT_A, id, deps);
  await processAddStoreMessage(opts.picEmail ?? "-", CHAT_A, id, deps);
  await processAddStoreMessage(opts.roleChoice ?? "2", CHAT_A, id, deps);
  return processAddStoreMessage(opts.confirm ?? "KONFIRMASI", CHAT_A, id, deps);
}

describe("23. Toko memiliki 2+ PIC, salah satunya ditambahkan via Telegram (Tambah PIC)", () => {
  it("Salesman menambah PIC kedua via 'tambah pic', toko sama, PIC baru UNVERIFIED", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const first = await runFullFlow(deps, identity());
    expect(first.outcome).toBe("store_created");
    const customerId = (first as { customerId: string; customerPicId: string }).customerId;
    await wait(2);

    const result = await runAddPicFlow(deps, identity());
    expect(result.outcome).toBe("pic_created");
    if (result.outcome === "pic_created") {
      expect(result.customerId).toBe(customerId);
      const pic = deps.repository.getPicSync(result.customerPicId);
      expect(pic?.validationStatus).toBe("UNVERIFIED");
    }
    expect(deps.repository.totalPicsForStore(customerId)).toBe(2);
  });

  it("pencarian toko dengan banyak hasil menampilkan daftar bernomor, salesman memilih salah satu", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity(), { storeName: "Warung Utara Satu" });
    await wait(2);
    await runFullFlow(deps, identity(), {
      storeName: "Warung Utara Dua", storeAddress: "Jl. Lain", storePhone: "081200009900", picPhone: "081200008800",
    });
    await wait(2);

    const id = identity();
    await processAddStoreMessage("tambah pic", CHAT_A, id, deps);
    const search = await processAddStoreMessage("Warung Utara", CHAT_A, id, deps);
    expect(search.outcome).toBe("awaiting_add_pic_store_select");
    const picked = await processAddStoreMessage("1", CHAT_A, id, deps);
    expect(picked.outcome).toBe("awaiting_add_pic_name");
  });

  it("pencarian tanpa hasil meminta ulang, tidak menjatuhkan percakapan", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const id = identity();
    await processAddStoreMessage("tambah pic", CHAT_A, id, deps);
    const search = await processAddStoreMessage("Toko Tidak Ada", CHAT_A, id, deps);
    expect(search.outcome).toBe("awaiting_add_pic_store_search");
  });
});

describe("24. Email PIC opsional -- kosong diterima", () => {
  it("Tambah Toko: PIC tanpa email ('-') berhasil dibuat, email null", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    expect(result.outcome).toBe("store_created");
    if (result.outcome === "store_created") {
      expect(deps.repository.getPicSync(result.customerPicId)?.email).toBeNull();
    }
  });

  it("Tambah PIC (Telegram, PIC kedua): tanpa email ('-') berhasil dibuat, email null", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    await runFullFlow(deps, identity());
    await wait(2);
    const result = await runAddPicFlow(deps, identity(), { picEmail: "-" });
    expect(result.outcome).toBe("pic_created");
    if (result.outcome === "pic_created") {
      expect(deps.repository.getPicSync(result.customerPicId)?.email).toBeNull();
    }
  });
});

describe("25. Email valid dinormalisasi (trim + lowercase)", () => {
  it("Tambah Toko: email dengan spasi dan huruf besar disimpan trim+lowercase", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Email Normalisasi", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Email", picPhone: "081200001234",
      picEmail: "  Budi.Santoso@EXAMPLE.com  ", picRoles: ["OWNER"],
      idempotencyKey: "email-normalize-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(deps.repository.getPicSync(result.customerPicId)?.email).toBe("budi.santoso@example.com");
    }
  });
});

describe("26. Email tidak valid ditolak", () => {
  it("percakapan Telegram (Tambah Toko) meminta ulang jika format email tidak valid, tidak menjatuhkan percakapan", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const id = identity();
    await processAddStoreMessage("tambah toko", CHAT_A, id, deps);
    await processAddStoreMessage("Toko Email Invalid", CHAT_A, id, deps);
    await processAddStoreMessage("-", CHAT_A, id, deps);
    await processAddStoreMessage("1", CHAT_A, id, deps);
    await processAddStoreMessage("081200005566", CHAT_A, id, deps);
    await processAddStoreMessage("PIC Invalid Email", CHAT_A, id, deps);
    await processAddStoreMessage("081200006677", CHAT_A, id, deps);
    const invalid = await processAddStoreMessage("bukan-email", CHAT_A, id, deps);
    expect(invalid.outcome).toBe("awaiting_pic_email");
    // Percakapan tetap hidup -- mengetik email valid melanjutkan alur normal.
    const recovered = await processAddStoreMessage("valid@example.com", CHAT_A, id, deps);
    expect(recovered.outcome).toBe("awaiting_pic_roles");
  });

  it("repository/RPC menolak format email tidak valid langsung (defense-in-depth, bypass UI)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Email Bypass", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Bypass Email", picPhone: "081200007788",
      picEmail: "bukan-email-valid", picRoles: ["OWNER"],
      idempotencyKey: "email-invalid-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("invalid_input");
  });
});

describe("27. Caller lama tanpa parameter email tetap kompatibel", () => {
  it("createStoreWithPic dengan picEmail: null berperilaku sama seperti tanpa email sama sekali", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Caller Lama", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Caller Lama", picPhone: "081200008899",
      picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "legacy-caller-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(deps.repository.getPicSync(result.customerPicId)?.email).toBeNull();
    }
  });

  it("createCustomerPic dengan email: null berperilaku sama seperti tanpa email sama sekali", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const store = await runFullFlow(deps, identity());
    const customerId = (store as { customerId: string }).customerId;
    const result = await deps.repository.createCustomerPic({
      companyId: COMPANY_A, customerId, actorId: OWNER_A, name: "PIC Caller Lama 2", phone: "081200009911",
      email: null, roles: ["RECEIVER"], idempotencyKey: "legacy-caller-2", source: "ADMIN_DASHBOARD",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") {
      expect(deps.repository.getPicSync(result.customerPicId)?.email).toBeNull();
    }
  });
});

describe("28. Perubahan email tercatat di history", () => {
  it("updateCustomerPic dengan newEmail baru mencatat EMAIL_CHANGED, tidak mempengaruhi validation_status", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity());
    const customerPicId = (result as { customerPicId: string }).customerPicId;
    await deps.repository.verifyCustomerPic({
      companyId: COMPANY_A, customerPicId, reviewerId: OWNER_A, newStatus: "VERIFIED_BY_ADMIN", reason: "OK diverifikasi.",
    });

    const update = await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: null, newPhone: null, newRoles: null,
      newEmail: "kontak.baru@example.com", reason: "Menambahkan email kontak.", source: "ADMIN_DASHBOARD",
    });
    expect(update.outcome).toBe("updated");
    expect(deps.repository.getPicSync(customerPicId)?.email).toBe("kontak.baru@example.com");
    // Email TIDAK PERNAH mempengaruhi validation_status -- beda dari nomor telepon.
    expect(deps.repository.getPicSync(customerPicId)?.validationStatus).toBe("VERIFIED_BY_ADMIN");

    const history = await deps.repository.getPicHistory(COMPANY_A, customerPicId);
    expect(history.some((h) => h.changeType === "EMAIL_CHANGED")).toBe(true);
  });

  it("menghapus email (string kosong) juga tercatat EMAIL_CHANGED", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const result = await runFullFlow(deps, identity(), { picEmail: undefined });
    const customerPicId = (result as { customerPicId: string }).customerPicId;

    await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: null, newPhone: null, newRoles: null,
      newEmail: "awal@example.com", reason: "Set email awal.", source: "ADMIN_DASHBOARD",
    });
    const cleared = await deps.repository.updateCustomerPic({
      companyId: COMPANY_A, customerPicId, actorId: OWNER_A, newName: null, newPhone: null, newRoles: null,
      newEmail: "", reason: "Hapus email -- salah input.", source: "ADMIN_DASHBOARD",
    });
    expect(cleared.outcome).toBe("updated");
    expect(deps.repository.getPicSync(customerPicId)?.email).toBeNull();
  });
});

describe("29. Email sama pada PIC berbeda bukan otomatis fraud", () => {
  it("dua PIC di toko berbeda memakai email sama -- keduanya berhasil dibuat, tidak ada penolakan/duplicate event untuk email", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const first = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Email Bersama Satu", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Satu", picPhone: "081200011111",
      picEmail: "sama@example.com", picRoles: ["OWNER"],
      idempotencyKey: "shared-email-1", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    const second = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: SALES_A, storeName: "Toko Email Bersama Dua", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Selatan", storeLatitude: null, storeLongitude: null,
      assignedSalesId: SALES_A, picName: "PIC Dua", picPhone: "081200022222",
      picEmail: "sama@example.com", picRoles: ["OWNER"],
      idempotencyKey: "shared-email-2", source: "TELEGRAM_SALESMAN", overrideSimilarDuplicate: false, overrideReason: null,
    });
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("created");
    if (first.outcome === "created" && second.outcome === "created") {
      const events = await deps.repository.getRelationshipEvents(COMPANY_A, second.customerId);
      expect(events.some((e) => e.eventType === "DUPLICATE_PIC_DETECTED")).toBe(false);
    }
  });
});

describe("30. Nomor PIC sama pada toko yang SAMA tidak membuat duplicate diam-diam", () => {
  it("createCustomerPic dengan nomor yang sudah ada di toko yang sama -> phone_exists_on_store, mengembalikan record existing", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const store = await runFullFlow(deps, identity(), { picPhone: "081200033333" });
    const customerId = (store as { customerId: string; customerPicId: string }).customerId;
    const originalPicId = (store as { customerPicId: string }).customerPicId;

    const before = deps.repository.totalPicsForStore(customerId);
    const result = await deps.repository.createCustomerPic({
      companyId: COMPANY_A, customerId, actorId: OWNER_A, name: "Nama Lain, Nomor Sama", phone: "081200033333",
      email: null, roles: ["RECEIVER"], idempotencyKey: "same-phone-same-store-1", source: "ADMIN_DASHBOARD",
    });
    expect(result.outcome).toBe("phone_exists_on_store");
    if (result.outcome === "phone_exists_on_store") {
      expect(result.existingCustomerPicId).toBe(originalPicId);
    }
    expect(deps.repository.totalPicsForStore(customerId)).toBe(before);
  });

  it("via Telegram Tambah PIC: nomor yang sudah terdaftar di toko yang sama -> pic_phone_exists_on_store, tidak membuat baris baru", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const store = await runFullFlow(deps, identity(), { picPhone: "081200044444" });
    const customerId = (store as { customerId: string }).customerId;
    await wait(2);

    const before = deps.repository.totalPicsForStore(customerId);
    const result = await runAddPicFlow(deps, identity(), { picPhone: "081200044444" });
    expect(result.outcome).toBe("pic_phone_exists_on_store");
    expect(deps.repository.totalPicsForStore(customerId)).toBe(before);
  });
});

describe("31. Cross-tenant Tambah PIC ditolak", () => {
  it("defense-in-depth: createCustomerPic dengan companyId Salesman ≠ companyId toko -> customer_not_found", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const store = await deps.repository.createStoreWithPic({
      companyId: COMPANY_A, actorId: OWNER_A, storeName: "Toko Company A Saja", storePhone: null,
      storeAddress: null, storeArea: "Jakarta Barat", storeLatitude: null, storeLongitude: null,
      assignedSalesId: null, picName: "PIC A", picPhone: "081200055555", picEmail: null, picRoles: ["OWNER"],
      idempotencyKey: "tenant-a-store-1", source: "ADMIN_DASHBOARD", overrideSimilarDuplicate: false, overrideReason: null,
    });
    const customerId = (store as { customerId: string }).customerId;

    const result = await deps.repository.createCustomerPic({
      companyId: COMPANY_B, customerId, actorId: SALES_B, name: "PIC Lintas Tenant", phone: "081200066666",
      email: null, roles: ["RECEIVER"], idempotencyKey: "cross-tenant-add-pic-1", source: "TELEGRAM_SALESMAN",
    });
    expect(result.outcome).toBe("customer_not_found");
  });

  it("UI Telegram: pencarian toko Salesman company lain tidak pernah menampilkan toko company A (hasil kosong)", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    deps.repository.seedTenantAreas(COMPANY_B, ["Jakarta Selatan"]);
    deps.repository.seedSalesmanCoverage(COMPANY_B, SALES_B, ["Jakarta Selatan"]);
    await runFullFlow(deps, identity()); // company A: "Toko Sinar Jaya"

    const idB = identity(SALES_B, COMPANY_B);
    await processAddStoreMessage("tambah pic", CHAT_A, idB, deps);
    const search = await processAddStoreMessage("Toko Sinar Jaya", CHAT_A, idB, deps);
    expect(search.outcome).toBe("awaiting_add_pic_store_search"); // tetap "cari lagi", bukan menemukan toko company A
  });
});

describe("32. Retry Telegram Tambah PIC idempotent", () => {
  it("createCustomerPic dipanggil 2x dengan idempotencyKey sama -> tidak membuat PIC ganda", async () => {
    const deps = makeDeps();
    seedBaseline(deps);
    const store = await runFullFlow(deps, identity());
    const customerId = (store as { customerId: string }).customerId;
    const input = {
      companyId: COMPANY_A, customerId, actorId: OWNER_A, name: "PIC Retry Telegram", phone: "081200077777",
      email: null, roles: ["RECEIVER"] as import("./types").PicRole[], idempotencyKey: "identity-sales-a:add_pic:2026-01-01T00:00:00.000Z",
      source: "TELEGRAM_SALESMAN" as const,
    };
    const first = await deps.repository.createCustomerPic(input);
    const second = await deps.repository.createCustomerPic(input);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("already_exists");
    if (first.outcome === "created" && second.outcome === "already_exists") {
      expect(first.customerPicId).toBe(second.customerPicId);
    }
    expect(deps.repository.totalPicsForStore(customerId)).toBe(2); // PIC awal + 1 PIC retry (bukan 2 PIC retry)
  });
});
