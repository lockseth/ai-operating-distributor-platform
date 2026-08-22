// =============================================================================
// Resolver: salesman aktif + coverage area per tenant, plus identitas
// per-channel (Telegram chat id / nomor WhatsApp).
//
// Pola join-lalu-filter-di-app SAMA seperti dispatch/repository.ts:
// findSalesmenByCompany dan dashboard/kpi/page.tsx (komentar existing:
// "bukan filter PostgREST bersarang -- pola yang sudah terbukti bekerja di
// repo ini"). Salesman tanpa identity valid untuk channel yang diminta
// TIDAK PERNAH muncul di hasil (bukan di-filter belakangan).
//
// listEligibleMorningBriefRecipients (Telegram) masih dipakai 3 laporan
// WhatsApp Owner lain (KPI/Sore/Penagihan) sebagai "salesman mana yang
// layak jadi baris laporan" -- TIDAK terkait channel pengiriman Morning
// Brief itu sendiri, yang sejak Gate P4.15 pindah ke
// listEligibleWhatsAppRecipients (nomor telepon).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeIndonesianPhone } from "@/lib/integrations/bablast";

export interface EligibleMorningBriefRecipient {
  userId: string;
  fullName: string;
  telegramChatId: string;
  coverageAreas: string[];
}

export interface EligibleWhatsAppRecipient {
  userId: string;
  fullName: string;
  /** Sudah dinormalisasi ke format 62xxx (lib/integrations/bablast.ts). */
  phone: string;
  coverageAreas: string[];
}

export interface ActiveOwnerRecipient {
  userId: string;
  fullName: string;
  /** null kalau owner belum mengisi nomor telepon saat signup (field opsional) -- pemanggil wajib menangani ini, bukan asumsikan selalu ada. */
  phone: string | null;
}

export interface SalesmanDirectory {
  /**
   * Dipakai untuk laporan Telegram (Morning Brief) DAN untuk daftar baris
   * salesman di 3 laporan WhatsApp Owner (KPI/Sore/Penagihan) -- TIDAK
   * pernah dikaitkan langsung ke channel pengiriman, murni "salesman aktif
   * mana yang layak muncul". Nama historis ("MorningBrief") sengaja
   * dipertahankan apa adanya (dipakai 3 tempat lain, rename beresiko diff
   * besar tanpa manfaat fungsional).
   */
  listEligibleMorningBriefRecipients(
    companyId: string,
  ): Promise<EligibleMorningBriefRecipient[]>;
  /** Salesman aktif + punya nomor telepon valid -- penerima Morning Brief via WhatsApp (Gate P4.15). */
  listEligibleWhatsAppRecipients(companyId: string): Promise<EligibleWhatsAppRecipient[]>;
  /** Owner aktif pertama tenant -- penerima seluruh Executive WhatsApp Report (Gate P4.11/P4.12/P4.13). */
  findActiveOwnerRecipient(companyId: string): Promise<ActiveOwnerRecipient | null>;
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

  async listEligibleWhatsAppRecipients(companyId: string): Promise<EligibleWhatsAppRecipient[]> {
    const { data: roleRows } = await this.client
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active, phone), role:roles!role_id(name)")
      .eq("company_id", companyId);

    const activeSalesmen = ((roleRows ?? []) as unknown as {
      user: { id: string; full_name: string; is_active: boolean; phone: string | null } | null;
      role: { name: string } | null;
    }[])
      .filter((r) => r.role?.name === "sales" && r.user?.is_active === true)
      .map((r) => ({ id: r.user!.id, fullName: r.user!.full_name, phone: r.user!.phone }));

    if (activeSalesmen.length === 0) return [];

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

    const result: EligibleWhatsAppRecipient[] = [];
    for (const s of activeSalesmen) {
      const normalized = s.phone ? normalizeIndonesianPhone(s.phone) : null;
      if (!normalized) continue;
      result.push({ userId: s.id, fullName: s.fullName, phone: normalized, coverageAreas: areasByUser.get(s.id) ?? [] });
    }
    return result;
  }

  async findActiveOwnerRecipient(companyId: string): Promise<ActiveOwnerRecipient | null> {
    const { data: roleRows } = await this.client
      .from("user_roles")
      .select("user:users!user_id(id, full_name, is_active, phone), role:roles!role_id(name)")
      .eq("company_id", companyId);

    const owner = ((roleRows ?? []) as unknown as {
      user: { id: string; full_name: string; is_active: boolean; phone: string | null } | null;
      role: { name: string } | null;
    }[]).find((r) => r.role?.name === "owner" && r.user?.is_active === true)?.user;

    if (!owner) return null;
    return { userId: owner.id, fullName: owner.full_name, phone: owner.phone };
  }
}

interface SeedSalesman {
  userId: string;
  companyId: string;
  fullName: string;
  isActive: boolean;
  telegramChatId: string | null;
  telegramActive: boolean;
  phone: string | null;
  coverageAreas: string[];
}

interface SeedOwner {
  userId: string;
  companyId: string;
  fullName: string;
  isActive: boolean;
  phone: string | null;
}

export class InMemorySalesmanDirectory implements SalesmanDirectory {
  private readonly salesmen: SeedSalesman[] = [];
  private readonly owners: SeedOwner[] = [];

  seedOwner(input: { userId: string; companyId: string; fullName: string; isActive?: boolean; phone?: string | null }): void {
    this.owners.push({
      userId: input.userId,
      companyId: input.companyId,
      fullName: input.fullName,
      isActive: input.isActive ?? true,
      phone: input.phone ?? null,
    });
  }

  async findActiveOwnerRecipient(companyId: string): Promise<ActiveOwnerRecipient | null> {
    const owner = this.owners.find((o) => o.companyId === companyId && o.isActive);
    if (!owner) return null;
    return { userId: owner.userId, fullName: owner.fullName, phone: owner.phone };
  }

  seedSalesman(input: {
    userId: string;
    companyId: string;
    fullName: string;
    isActive?: boolean;
    telegramChatId?: string | null;
    telegramActive?: boolean;
    phone?: string | null;
    coverageAreas?: string[];
  }): void {
    this.salesmen.push({
      userId: input.userId,
      companyId: input.companyId,
      fullName: input.fullName,
      isActive: input.isActive ?? true,
      telegramChatId: input.telegramChatId ?? null,
      telegramActive: input.telegramActive ?? true,
      phone: input.phone ?? null,
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

  async listEligibleWhatsAppRecipients(companyId: string): Promise<EligibleWhatsAppRecipient[]> {
    const result: EligibleWhatsAppRecipient[] = [];
    for (const s of this.salesmen) {
      if (s.companyId !== companyId || !s.isActive) continue;
      const normalized = s.phone ? normalizeIndonesianPhone(s.phone) : null;
      if (!normalized) continue;
      result.push({ userId: s.userId, fullName: s.fullName, phone: normalized, coverageAreas: s.coverageAreas });
    }
    return result;
  }
}
