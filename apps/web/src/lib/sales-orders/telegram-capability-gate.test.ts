// =============================================================================
// Test — Gate 3E-D1-R1: capability separation setelah generalisasi Telegram
// identity pairing ke {owner, admin, sales}. Pairing (identity aktif) TIDAK
// LAGI berarti eligible untuk workflow Sales Order/Delivery/Dispute/Menu --
// hanya capability 'sales.order.telegram' (role sales) yang boleh masuk.
// =============================================================================

import { describe, it, expect } from "vitest";
import { processTelegramUpdate, type WorkflowDeps } from "./workflow";
import { InMemorySalesOrderRepository } from "./repository";
import { InMemoryKnowledgeProvider } from "./knowledge-provider";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/client";
import { InMemoryDeliveryRepository } from "@/lib/delivery/repository";
import { InMemoryTelegramEnrollmentRepository } from "@/lib/telegram-enrollment/repository";

const COMPANY_ID = "company-1";
const CHAT_ID = 9001;

function makeDeps(): WorkflowDeps & {
  repository: InMemorySalesOrderRepository;
  sender: RecordingTelegramSender;
} {
  const repository = new InMemorySalesOrderRepository();
  return {
    repository,
    knowledgeProvider: new InMemoryKnowledgeProvider(),
    sender: new RecordingTelegramSender(),
    deliveryRepository: new InMemoryDeliveryRepository(),
    enrollmentRepository: new InMemoryTelegramEnrollmentRepository(),
  };
}

function textUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: CHAT_ID },
      from: { id: 5555, username: "owner_or_admin" },
    },
  };
}

describe("Gate 3E-D1-R1: sales.order.telegram capability gate", () => {
  it("identity owner ter-pairing (paska generalisasi) ditolak dari workflow Sales Order -- balasan sama dengan unregistered", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(CHAT_ID, {
      identityId: "identity-owner",
      companyId: COMPANY_ID,
      userId: "owner-1",
      userFullName: "Owner Waluyo",
    });
    deps.repository.seedSalesOrderCapability(
      "owner-1",
      COMPANY_ID,
      false,
    );

    const result = await processTelegramUpdate(
      textUpdate(1, "2 dus indomie ke toko sinar jaya"),
      deps,
    );

    expect(result).toEqual({ outcome: "unregistered" });
    expect(deps.sender.sent).toHaveLength(1);
    expect(deps.sender.sent[0].chatId).toBe(CHAT_ID);

    const event = deps.repository.getEventRecord(1);
    expect(event).toBeDefined();
    expect(event?.rejectionReason).toBe(
      "capability_denied_sales_order_telegram",
    );
    expect(event?.rawPayload).toBeNull();
  });

  it("identity admin ter-pairing ditolak dengan cara yang sama (fail-closed, bukan hanya owner)", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(CHAT_ID, {
      identityId: "identity-admin",
      companyId: COMPANY_ID,
      userId: "admin-1",
      userFullName: "Admin Waluyo",
    });
    deps.repository.seedSalesOrderCapability("admin-1", COMPANY_ID, false);

    const result = await processTelegramUpdate(
      textUpdate(2, "1 dus indomie ke toko sinar jaya"),
      deps,
    );

    expect(result).toEqual({ outcome: "unregistered" });
  });

  it("identity sales tetap lolos seperti sebelumnya (default capability tidak berubah, tidak perlu seed eksplisit)", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(CHAT_ID, {
      identityId: "identity-sales",
      companyId: COMPANY_ID,
      userId: "sales-1",
      userFullName: "Andri",
    });
    // Tidak memanggil seedSalesOrderCapability -- default InMemory tetap
    // true, meniru perilaku sebelum Gate 3E-D1-R1 untuk seluruh fixture yang
    // sudah ada.

    const result = await processTelegramUpdate(
      textUpdate(3, "halo"),
      deps,
    );

    expect(result).not.toEqual({ outcome: "unregistered" });
  });

  it("hasSalesOrderCapability dicek ulang dari state SAAT INI, bukan disimpulkan dari resolveIdentity", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(CHAT_ID, {
      identityId: "identity-owner-2",
      companyId: COMPANY_ID,
      userId: "owner-2",
      userFullName: "Owner Lain",
    });

    // Sebelum di-deny eksplisit: default true (lolos gate).
    const before = await processTelegramUpdate(textUpdate(4, "halo"), deps);
    expect(before).not.toEqual({ outcome: "unregistered" });

    // Role berubah / dicabut capability-nya setelah pairing -- permintaan
    // berikutnya harus langsung fail-closed.
    deps.repository.seedSalesOrderCapability("owner-2", COMPANY_ID, false);
    const after = await processTelegramUpdate(textUpdate(5, "halo lagi"), deps);
    expect(after).toEqual({ outcome: "unregistered" });
  });
});
