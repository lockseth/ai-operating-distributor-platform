import { describe, expect, it } from "vitest";
import { RecordingTelegramSender } from "@/lib/telegram/client";
import { InMemoryCustomerPicRepository } from "@/lib/customer-pic/repository";
import { InMemoryStorePicConversationRepository } from "@/lib/customer-pic/conversation";
import type { ResolvedIdentity } from "@/lib/sales-orders/repository";
import { startAddStoreFlow } from "./add-store";

const IDENTITY: ResolvedIdentity = {
  identityId: "identity-1",
  companyId: "waluyo",
  userId: "sales-1",
  userFullName: "Budi",
};

describe("Tambah Toko -- launcher tipis ke processAddStoreMessage yang sudah ada", () => {
  it("dengan coverage area -> masuk step store_name (persis jalur trigger kata kunci)", async () => {
    const repository = new InMemoryCustomerPicRepository();
    repository.seedSalesmanCoverage("waluyo", "sales-1", ["Utara"]);
    const conversationRepository = new InMemoryStorePicConversationRepository();
    const sender = new RecordingTelegramSender();

    await startAddStoreFlow(12345, IDENTITY, { repository, conversationRepository, sender });

    const state = await conversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("store_name");
    expect(sender.sent.at(-1)!.text.length).toBeGreaterThan(0);
  });

  it("tanpa coverage area -> ditolak jujur (rule existing, tidak dikarang di sini)", async () => {
    const repository = new InMemoryCustomerPicRepository();
    const conversationRepository = new InMemoryStorePicConversationRepository();
    const sender = new RecordingTelegramSender();

    await startAddStoreFlow(12345, IDENTITY, { repository, conversationRepository, sender });

    const state = await conversationRepository.getState(IDENTITY.identityId);
    expect(state.awaiting).toBe("none");
  });
});
