// =============================================================================
// Test — Gate 3E-D4-C6: kill switch global telegram_sales_orders di
// processTelegramUpdate (jalur "direct processing path").
//
// Dibuktikan dengan DUA identity Sales yang sama sekali berbeda (user id,
// nama, chat id, company) supaya jelas mekanismenya generik -- bukan
// allowlist/pengecualian untuk satu aktor tertentu (mis. Salma). Salma
// adalah aktor supervised UAT saja, tidak pernah disebut di sini.
// =============================================================================

import { describe, it, expect } from "vitest";
import { processTelegramUpdate, type WorkflowDeps } from "./workflow";
import { InMemorySalesOrderRepository } from "./repository";
import { InMemoryKnowledgeProvider } from "./knowledge-provider";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import type { TelegramUpdate } from "@/lib/telegram/client";
import { InMemoryDeliveryRepository } from "@/lib/delivery/repository";
import { InMemoryTelegramEnrollmentRepository } from "@/lib/telegram-enrollment/repository";

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

function textUpdate(updateId: number, chatId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      text,
      chat: { id: chatId },
      from: { id: chatId, username: `user_${chatId}` },
    },
  };
}

// Dua identity Sales yang benar-benar berbeda: user id, nama, chat id,
// DAN company_id (tenant) berbeda -- bukti mekanisme tidak menyentuh
// identitas/tenant tertentu secara khusus.
const IDENTITY_ONE = {
  chatId: 7001,
  identityId: "identity-sales-one",
  companyId: "company-alpha",
  userId: "sales-user-one",
  userFullName: "Rina",
};
const IDENTITY_TWO = {
  chatId: 7002,
  identityId: "identity-sales-two",
  companyId: "company-beta",
  userId: "sales-user-two",
  userFullName: "Joko",
};

describe("Gate 3E-D4-C6: kill switch global telegram_sales_orders (dua identity Sales berbeda)", () => {
  it("flag OFF -> KEDUA identity Sales ditolak dengan cara identik (outcome unregistered, rejection reason sama)", async () => {
    for (const identity of [IDENTITY_ONE, IDENTITY_TWO]) {
      const deps = makeDeps();
      deps.repository.seedIdentity(identity.chatId, {
        identityId: identity.identityId,
        companyId: identity.companyId,
        userId: identity.userId,
        userFullName: identity.userFullName,
      });
      deps.repository.seedTelegramSalesOrdersFlag(false);

      const result = await processTelegramUpdate(
        textUpdate(1, identity.chatId, "2 dus indomie ke toko sinar jaya"),
        deps,
      );

      expect(result).toEqual({ outcome: "unregistered" });
      const event = deps.repository.getEventRecord(1);
      expect(event?.rejectionReason).toBe("capability_denied_sales_order_telegram");
      expect(event?.rawPayload).toBeNull();
    }
  });

  it("flag ON + role sales -> KEDUA identity Sales lolos gate secara identik (tidak ada allowlist per-user)", async () => {
    for (const identity of [IDENTITY_ONE, IDENTITY_TWO]) {
      const deps = makeDeps();
      deps.repository.seedIdentity(identity.chatId, {
        identityId: identity.identityId,
        companyId: identity.companyId,
        userId: identity.userId,
        userFullName: identity.userFullName,
      });
      deps.repository.seedTelegramSalesOrdersFlag(true);
      // Tidak memanggil seedSalesOrderCapability -- default InMemory role
      // sales tetap true, konsisten dengan fixture existing.

      const result = await processTelegramUpdate(
        textUpdate(2, identity.chatId, "halo"),
        deps,
      );

      expect(result).not.toEqual({ outcome: "unregistered" });
    }
  });

  it("flag di-nonaktifkan SETELAH sempat ON -- permintaan berikutnya untuk identity KEDUA langsung fail-closed (dicek ulang dari state saat ini, bukan cache)", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(IDENTITY_TWO.chatId, {
      identityId: IDENTITY_TWO.identityId,
      companyId: IDENTITY_TWO.companyId,
      userId: IDENTITY_TWO.userId,
      userFullName: IDENTITY_TWO.userFullName,
    });

    deps.repository.seedTelegramSalesOrdersFlag(true);
    const before = await processTelegramUpdate(
      textUpdate(3, IDENTITY_TWO.chatId, "halo"),
      deps,
    );
    expect(before).not.toEqual({ outcome: "unregistered" });

    deps.repository.seedTelegramSalesOrdersFlag(false);
    const after = await processTelegramUpdate(
      textUpdate(4, IDENTITY_TWO.chatId, "halo lagi"),
      deps,
    );
    expect(after).toEqual({ outcome: "unregistered" });
  });

  it("flag ON tapi capability role dicabut (bukan sales) -- identity pertama tetap ditolak walau flag ON (dua syarat independen)", async () => {
    const deps = makeDeps();
    deps.repository.seedIdentity(IDENTITY_ONE.chatId, {
      identityId: IDENTITY_ONE.identityId,
      companyId: IDENTITY_ONE.companyId,
      userId: IDENTITY_ONE.userId,
      userFullName: IDENTITY_ONE.userFullName,
    });
    deps.repository.seedTelegramSalesOrdersFlag(true);
    deps.repository.seedSalesOrderCapability(IDENTITY_ONE.userId, IDENTITY_ONE.companyId, false);

    const result = await processTelegramUpdate(
      textUpdate(5, IDENTITY_ONE.chatId, "halo"),
      deps,
    );

    expect(result).toEqual({ outcome: "unregistered" });
  });
});
