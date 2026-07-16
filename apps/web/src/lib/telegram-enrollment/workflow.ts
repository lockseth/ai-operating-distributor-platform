import type { TelegramUpdate } from "@/lib/telegram/client";
import { extractEnrollmentToken, hashEnrollmentToken } from "./token";
import type {
  EnrollmentClaimResult,
  TelegramEnrollmentRepository,
} from "./repository";

export type TelegramEnrollmentProcessResult =
  | { outcome: "not_enrollment" }
  | { outcome: "rejected"; reason: "private_chat_required" }
  | {
      outcome: "rejected";
      reason: Exclude<EnrollmentClaimResult["outcome"], "claimed">;
    }
  | {
      outcome: "claimed";
      identity: {
        identityId: string;
        companyId: string;
        userId: string;
        userFullName: string;
      };
    };

export async function processTelegramEnrollment(
  message: NonNullable<TelegramUpdate["message"]>,
  repository: TelegramEnrollmentRepository,
): Promise<TelegramEnrollmentProcessResult> {
  const token = extractEnrollmentToken(message.text);
  if (!token) return { outcome: "not_enrollment" };

  // Telegram enrollment is intentionally private-chat only. In a private
  // chat Telegram guarantees chat.id is the sender's user id; verifying both
  // prevents a group member from enrolling a shared group chat.
  if (
    message.chat.type !== "private" ||
    message.from?.id === undefined ||
    message.chat.id !== message.from.id
  ) {
    return { outcome: "rejected", reason: "private_chat_required" };
  }

  const claim = await repository.claimByTokenHash({
    tokenHash: hashEnrollmentToken(token),
    telegramChatId: message.chat.id,
    telegramUserId: message.from.id,
    telegramUsername: message.from.username ?? null,
  });

  if (claim.outcome !== "claimed") {
    return { outcome: "rejected", reason: claim.outcome };
  }

  return { outcome: "claimed", identity: claim.identity };
}

export function buildEnrollmentReply(
  result: Exclude<
    TelegramEnrollmentProcessResult,
    { outcome: "not_enrollment" }
  >,
): string {
  if (result.outcome === "claimed") {
    return [
      `Telegram berhasil terhubung ke akun Salesman ${result.identity.userFullName}.`,
      "",
      "Mulai sekarang Anda dapat mengirim order melalui chat pribadi ini.",
    ].join("\n");
  }

  if (result.reason === "private_chat_required") {
    return "Pendaftaran hanya dapat dilakukan melalui chat pribadi dengan bot. Buka bot secara langsung lalu gunakan kembali tautan dari admin.";
  }

  if (result.reason === "chat_in_use") {
    return "Akun Telegram ini sudah terhubung ke pengguna lain. Hubungi admin/owner distributor Anda.";
  }

  if (result.reason === "user_already_linked") {
    return "Akun Salesman tersebut sudah terhubung ke Telegram lain. Minta admin memutuskan koneksi lama terlebih dahulu.";
  }

  if (result.reason === "not_eligible") {
    return "Pendaftaran tidak dapat diselesaikan karena akun Salesman sudah tidak aktif atau tidak memenuhi syarat. Hubungi admin/owner distributor Anda.";
  }

  return "Kode pendaftaran tidak valid, sudah digunakan, atau kedaluwarsa. Minta kode baru kepada admin/owner distributor Anda.";
}
