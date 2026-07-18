// =============================================================================
// Tambah Toko -- menu ini murni LAUNCHER, sama pola dengan Pengiriman Hari
// Ini. Memanggil processAddStoreMessage (TERKUNCI, lib/customer-pic/
// workflow.ts) dengan teks yang cocok dengan detectAddStoreTrigger() supaya
// startAddStore() (private, tidak diekspor) berjalan lewat jalur publik yang
// SUDAH ADA -- bukan menduplikasi logic cek coverage area/prompt awal.
// =============================================================================

import type { TelegramSender } from "@/lib/telegram/client";
import type { ResolvedIdentity } from "@/lib/sales-orders/repository";
import type { CustomerPicRepository } from "@/lib/customer-pic/repository";
import type { StorePicConversationRepository } from "@/lib/customer-pic/conversation";
import { processAddStoreMessage } from "@/lib/customer-pic/workflow";

export interface AddStoreHandlerDeps {
  repository: CustomerPicRepository;
  conversationRepository: StorePicConversationRepository;
  sender: TelegramSender;
}

const ADD_STORE_TRIGGER_TEXT = "tambah toko";

export async function startAddStoreFlow(
  chatId: number,
  identity: ResolvedIdentity,
  deps: AddStoreHandlerDeps,
): Promise<void> {
  await processAddStoreMessage(ADD_STORE_TRIGGER_TEXT, chatId, identity, deps);
}
