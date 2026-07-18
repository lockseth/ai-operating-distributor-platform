// =============================================================================
// Resolver: salesman aktif + Telegram identity + coverage area per tenant.
//
// Tidak ada fungsi gabungan seperti ini sebelumnya di repo (diverifikasi
// eksplisit) -- pola join-lalu-filter-di-app SAMA seperti
// dispatch/repository.ts:findSalesmenByCompany dan dashboard/kpi/page.tsx
// (komentar existing: "bukan filter PostgREST bersarang -- pola yang sudah
// terbukti bekerja di repo ini"). Hanya mengembalikan salesman yang BENAR
// aktif DAN punya telegram_identities.is_active=true -- salesman tanpa
// identity valid tidak pernah muncul di hasil (bukan di-filter belakangan).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export interface EligibleMorningBriefRecipient {
  userId: string;
  fullName: string;
  telegramChatId: string;
  coverageAreas: string[];
}

export interface SalesmanDirectory {
  listEligibleMorningBriefRecipients(
    companyId: string,
  ): Promise<EligibleMorningBriefRecipient[]>;
}

export class SupabaseSalesmanDirectory implements SalesmanDirectory {
  constructor(private readonly client: SupabaseClient) {}

  async listEligibleMorningBriefRecipients(
    companyId: string,
  ): Promise<EligibleMorningBriefRecipient[]> {
    const { data: roleRows } = await this.client
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active), role:roles!role_id(name)")
      .eq("company_id", companyId);

    const activeSalesmen = ((roleRows ?? []) as unknown as {
      user: { id: string; full_name: string; is_active: boolean } | null;
      role: { name: string } | null;
    }[])
      .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
      .map((r) => ({ id: r.user!.id, fullName: r.user!.full_name }));

    if (activeSalesmen.length === 0) return [];

    const { data: identityRows } = await this.client
      .from("telegram_identities")
      .select("user_id, telegram_chat_id")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in(
        "user_id",
        activeSalesmen.map((s) => s.id),
      );

    const chatIdByUser = new Map<string, string>();
    for (const row of (identityRows ?? []) as { user_id: string; telegram_chat_id: number }[]) {
      chatIdByUser.set(row.user_id, String(row.telegram_chat_id));
    }

    const { data: coverageRows } = await this.client
      .from("salesman_coverage_areas")
      .select("user_id, area")
      .eq("company_id", companyId)
      .in(
        "user_id",
        activeSalesmen.map((s) => s.id),
      );

    const areasByUser = new Map<string, string[]>();
    for (const row of (coverageRows ?? []) as { user_id: string; area: string }[]) {
      const list = areasByUser.get(row.user_id) ?? [];
      list.push(row.area);
      areasByUser.set(row.user_id, list);
    }

    return activeSalesmen
      .filter((s) => chatIdByUser.has(s.id))
      .map((s) => ({
        userId: s.id,
        fullName: s.fullName,
        telegramChatId: chatIdByUser.get(s.id)!,
        coverageAreas: areasByUser.get(s.id) ?? [],
      }));
  }
}

interface SeedSalesman {
  userId: string;
  companyId: string;
  fullName: string;
  isActive: boolean;
  telegramChatId: string | null;
  telegramActive: boolean;
  coverageAreas: string[];
}

export class InMemorySalesmanDirectory implements SalesmanDirectory {
  private readonly salesmen: SeedSalesman[] = [];

  seedSalesman(input: {
    userId: string;
    companyId: string;
    fullName: string;
    isActive?: boolean;
    telegramChatId?: string | null;
    telegramActive?: boolean;
    coverageAreas?: string[];
  }): void {
    this.salesmen.push({
      userId: input.userId,
      companyId: input.companyId,
      fullName: input.fullName,
      isActive: input.isActive ?? true,
      telegramChatId: input.telegramChatId ?? null,
      telegramActive: input.telegramActive ?? true,
      coverageAreas: input.coverageAreas ?? [],
    });
  }

  async listEligibleMorningBriefRecipients(
    companyId: string,
  ): Promise<EligibleMorningBriefRecipient[]> {
    return this.salesmen
      .filter(
        (s) =>
          s.companyId === companyId &&
          s.isActive &&
          s.telegramChatId !== null &&
          s.telegramActive,
      )
      .map((s) => ({
        userId: s.userId,
        fullName: s.fullName,
        telegramChatId: s.telegramChatId!,
        coverageAreas: s.coverageAreas,
      }));
  }
}
