import { describe, expect, it } from "vitest";
import type { TelegramUpdate } from "@/lib/telegram/client";
import {
  InMemoryTelegramEnrollmentRepository,
  type ClaimedTelegramIdentity,
} from "./repository";
import { buildEnrollmentReply, processTelegramEnrollment } from "./workflow";
import {
  buildEnrollmentCommand,
  buildEnrollmentDeepLink,
  extractEnrollmentToken,
  generateEnrollmentToken,
  hashEnrollmentToken,
} from "./token";

const RAW_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const CHAT_ID = 81234567;
const IDENTITY: ClaimedTelegramIdentity = {
  identityId: "identity-1",
  companyId: "company-1",
  userId: "sales-1",
  userFullName: "Andri",
};

function enrollmentMessage(
  text = buildEnrollmentCommand(RAW_TOKEN),
  options: {
    chatId?: number;
    userId?: number;
    chatType?: "private" | "group" | "supergroup" | "channel";
  } = {},
): NonNullable<TelegramUpdate["message"]> {
  const chatId = options.chatId ?? CHAT_ID;
  return {
    message_id: 1,
    text,
    chat: { id: chatId, type: options.chatType ?? "private" },
    from: {
      id: options.userId ?? chatId,
      username: "andri_sales",
    },
  };
}

describe("Telegram Salesman Identity Enrollment", () => {
  it("menghasilkan token 192-bit dan hanya hash SHA-256 yang siap disimpan", () => {
    const token = generateEnrollmentToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(hashEnrollmentToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEnrollmentToken(token)).not.toContain(token);
  });

  it("mengenali deep-link /start dan command /enroll, menolak format lain", () => {
    expect(extractEnrollmentToken(`/start enroll_${RAW_TOKEN}`)).toBe(
      RAW_TOKEN,
    );
    expect(extractEnrollmentToken(`/start@AODPBot enroll_${RAW_TOKEN}`)).toBe(
      RAW_TOKEN,
    );
    expect(extractEnrollmentToken(`/enroll ${RAW_TOKEN}`)).toBe(RAW_TOKEN);
    expect(extractEnrollmentToken("/start enroll_short")).toBeNull();
    expect(extractEnrollmentToken(`Order Toko A ${RAW_TOKEN}`)).toBeNull();
  });

  it("klaim valid menghubungkan chat privat ke identity dari token", async () => {
    const repository = new InMemoryTelegramEnrollmentRepository();
    repository.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
    });

    const result = await processTelegramEnrollment(
      enrollmentMessage(),
      repository,
    );

    expect(result).toEqual({ outcome: "claimed", identity: IDENTITY });
    if (result.outcome !== "claimed") throw new Error("unexpected outcome");
    const reply = buildEnrollmentReply(result);
    expect(reply).toContain("Salesman Andri");
    expect(reply).not.toContain(RAW_TOKEN);
    expect(reply).not.toContain("company-1");
  });

  it("retry claimant yang sama idempotent; token tidak dapat dipakai chat lain", async () => {
    const repository = new InMemoryTelegramEnrollmentRepository();
    repository.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
    });

    expect(
      (await processTelegramEnrollment(enrollmentMessage(), repository))
        .outcome,
    ).toBe("claimed");
    const sameClaimantRetry = await processTelegramEnrollment(
      enrollmentMessage(),
      repository,
    );
    expect(sameClaimantRetry).toEqual({
      outcome: "claimed",
      identity: IDENTITY,
    });

    const differentChat = await processTelegramEnrollment(
      enrollmentMessage(undefined, {
        chatId: CHAT_ID + 1,
        userId: CHAT_ID + 1,
      }),
      repository,
    );
    expect(differentChat).toEqual({
      outcome: "rejected",
      reason: "invalid_or_expired",
    });
  });

  it("token kedaluwarsa dan token revoked sama-sama fail closed", async () => {
    const expired = new InMemoryTelegramEnrollmentRepository();
    expired.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
      expiresAt: new Date(Date.now() - 1),
    });
    expect(
      await processTelegramEnrollment(enrollmentMessage(), expired),
    ).toEqual({ outcome: "rejected", reason: "invalid_or_expired" });

    const revoked = new InMemoryTelegramEnrollmentRepository();
    revoked.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
      revoked: true,
    });
    expect(
      await processTelegramEnrollment(enrollmentMessage(), revoked),
    ).toEqual({ outcome: "rejected", reason: "invalid_or_expired" });
  });

  it("group chat dan chat.id yang tidak sama dengan from.id ditolak", async () => {
    const repository = new InMemoryTelegramEnrollmentRepository();
    repository.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
    });

    expect(
      await processTelegramEnrollment(
        enrollmentMessage(undefined, { chatType: "group" }),
        repository,
      ),
    ).toEqual({ outcome: "rejected", reason: "private_chat_required" });

    expect(
      await processTelegramEnrollment(
        enrollmentMessage(undefined, { userId: CHAT_ID + 1 }),
        repository,
      ),
    ).toEqual({ outcome: "rejected", reason: "private_chat_required" });
  });

  it("chat milik user lain dan Salesman yang sudah linked tidak dapat diambil alih", async () => {
    const chatConflict = new InMemoryTelegramEnrollmentRepository();
    chatConflict.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
    });
    chatConflict.seedChatOwner(CHAT_ID, "sales-lain");
    expect(
      await processTelegramEnrollment(enrollmentMessage(), chatConflict),
    ).toEqual({ outcome: "rejected", reason: "chat_in_use" });

    const userConflict = new InMemoryTelegramEnrollmentRepository();
    userConflict.seedToken({
      tokenHash: hashEnrollmentToken(RAW_TOKEN),
      identity: IDENTITY,
    });
    userConflict.seedActiveUserChat(IDENTITY.userId, CHAT_ID + 99);
    expect(
      await processTelegramEnrollment(enrollmentMessage(), userConflict),
    ).toEqual({ outcome: "rejected", reason: "user_already_linked" });
  });

  it("deep link hanya dibuat untuk username bot yang valid", () => {
    expect(buildEnrollmentDeepLink("@AODP_WaluyoBot", RAW_TOKEN)).toBe(
      `https://t.me/AODP_WaluyoBot?start=enroll_${RAW_TOKEN}`,
    );
    expect(buildEnrollmentDeepLink("bad username", RAW_TOKEN)).toBeNull();
    expect(buildEnrollmentDeepLink(undefined, RAW_TOKEN)).toBeNull();
  });
});
