"use server";

// =============================================================================
// Server action buat Chat UI (Milestone 2) memanggil wiring chatbot
// (Milestone 3). Akses dibatasi owner/manager/super_admin -- sama dengan
// halaman Risk Alert & Executive Intelligence (fitur yang ditujukan buat
// pengambil keputusan, bukan operasional harian sales).
// =============================================================================

import { getAuthUser } from "@/lib/auth/get-user";
import type { ConversationMessage } from "@flowsales/ai";
import { getOwnerBusinessSnapshot } from "./snapshot";
import { askOwnerChatbot, type AskOwnerChatbotResult } from "./chatbot";

const OWNER_CHAT_ROLES = ["owner", "manager", "super_admin"];
const SNAPSHOT_LOOKBACK_DAYS = 30;

export async function askOwnerChatAction(
  question: string,
  history: ConversationMessage[],
): Promise<AskOwnerChatbotResult> {
  const user = await getAuthUser();

  if (!OWNER_CHAT_ROLES.some((role) => user.roles.includes(role))) {
    return { ok: false, error: "Tidak punya akses ke fitur ini." };
  }

  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    return { ok: false, error: "Pertanyaan tidak boleh kosong." };
  }

  const now = new Date();
  const from = new Date(now.getTime() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000);

  let snapshot;
  try {
    snapshot = await getOwnerBusinessSnapshot(user.company_id, { from, to: now });
  } catch {
    return { ok: false, error: "Gagal mengambil data bisnis. Coba lagi sesaat lagi." };
  }

  return askOwnerChatbot(trimmedQuestion, history, snapshot);
}
