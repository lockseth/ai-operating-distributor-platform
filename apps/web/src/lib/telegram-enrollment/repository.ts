import type { SupabaseClient } from "@supabase/supabase-js";

export type EnrollmentClaimOutcome =
  | "claimed"
  | "invalid_or_expired"
  | "not_eligible"
  | "chat_in_use"
  | "user_already_linked";

export interface ClaimedTelegramIdentity {
  identityId: string;
  companyId: string;
  userId: string;
  userFullName: string;
}

export type EnrollmentClaimResult =
  | { outcome: "claimed"; identity: ClaimedTelegramIdentity }
  | { outcome: Exclude<EnrollmentClaimOutcome, "claimed"> };

export interface TelegramEnrollmentRepository {
  claimByTokenHash(input: {
    tokenHash: string;
    telegramChatId: number;
    telegramUserId: number;
    telegramUsername: string | null;
  }): Promise<EnrollmentClaimResult>;
}

type ClaimRpcRow = {
  result_outcome: EnrollmentClaimOutcome;
  telegram_identity_id: string | null;
  result_company_id: string | null;
  result_user_id: string | null;
  result_user_full_name: string | null;
};

export class SupabaseTelegramEnrollmentRepository implements TelegramEnrollmentRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async claimByTokenHash(input: {
    tokenHash: string;
    telegramChatId: number;
    telegramUserId: number;
    telegramUsername: string | null;
  }): Promise<EnrollmentClaimResult> {
    const { data, error } = await this.supabase.rpc(
      "claim_telegram_salesman_identity",
      {
        p_token_hash: input.tokenHash,
        p_telegram_chat_id: input.telegramChatId,
        p_telegram_user_id: input.telegramUserId,
        p_telegram_username: input.telegramUsername,
      },
    );

    if (error) {
      throw new Error(`claim Telegram enrollment failed: ${error.message}`);
    }

    const row = ((data ?? []) as ClaimRpcRow[])[0];
    if (!row || row.result_outcome !== "claimed") {
      return {
        outcome:
          row?.result_outcome === "not_eligible" ||
          row?.result_outcome === "chat_in_use" ||
          row?.result_outcome === "user_already_linked"
            ? row.result_outcome
            : "invalid_or_expired",
      };
    }

    if (
      !row.telegram_identity_id ||
      !row.result_company_id ||
      !row.result_user_id ||
      !row.result_user_full_name
    ) {
      throw new Error("claim Telegram enrollment returned incomplete identity");
    }

    return {
      outcome: "claimed",
      identity: {
        identityId: row.telegram_identity_id,
        companyId: row.result_company_id,
        userId: row.result_user_id,
        userFullName: row.result_user_full_name,
      },
    };
  }
}

interface InMemoryToken {
  tokenHash: string;
  identity: ClaimedTelegramIdentity;
  expiresAt: Date;
  claimed: boolean;
  claimedChatId: number | null;
  claimedUserId: number | null;
  revoked: boolean;
}

export class InMemoryTelegramEnrollmentRepository implements TelegramEnrollmentRepository {
  private readonly tokens = new Map<string, InMemoryToken>();
  private readonly chatOwners = new Map<number, string>();
  private readonly activeChatByUser = new Map<string, number>();

  seedToken(input: {
    tokenHash: string;
    identity: ClaimedTelegramIdentity;
    expiresAt?: Date;
    revoked?: boolean;
  }): void {
    this.tokens.set(input.tokenHash, {
      tokenHash: input.tokenHash,
      identity: input.identity,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60_000),
      claimed: false,
      claimedChatId: null,
      claimedUserId: null,
      revoked: input.revoked ?? false,
    });
  }

  seedChatOwner(chatId: number, userId: string): void {
    this.chatOwners.set(chatId, userId);
  }

  seedActiveUserChat(userId: string, chatId: number): void {
    this.activeChatByUser.set(userId, chatId);
  }

  async claimByTokenHash(input: {
    tokenHash: string;
    telegramChatId: number;
    telegramUserId: number;
    telegramUsername: string | null;
  }): Promise<EnrollmentClaimResult> {
    const token = this.tokens.get(input.tokenHash);
    if (!token || token.revoked || token.expiresAt.getTime() <= Date.now()) {
      return { outcome: "invalid_or_expired" };
    }

    if (token.claimed) {
      if (
        token.claimedChatId === input.telegramChatId &&
        token.claimedUserId === input.telegramUserId
      ) {
        return { outcome: "claimed", identity: token.identity };
      }
      return { outcome: "invalid_or_expired" };
    }

    const chatOwner = this.chatOwners.get(input.telegramChatId);
    if (chatOwner && chatOwner !== token.identity.userId) {
      return { outcome: "chat_in_use" };
    }

    const activeChat = this.activeChatByUser.get(token.identity.userId);
    if (activeChat !== undefined && activeChat !== input.telegramChatId) {
      return { outcome: "user_already_linked" };
    }

    token.claimed = true;
    token.claimedChatId = input.telegramChatId;
    token.claimedUserId = input.telegramUserId;
    this.chatOwners.set(input.telegramChatId, token.identity.userId);
    this.activeChatByUser.set(token.identity.userId, input.telegramChatId);
    return { outcome: "claimed", identity: token.identity };
  }
}
