// =============================================================================
// Morning Brief on-demand (/start, /menu) -- memakai composeMorningBriefForSalesman
// yang SAMA dengan jalur proaktif n8n cron (lib/n8n-automation/morning-brief.ts).
// Ditambah baris status hari (NOT_STARTED/ACTIVE/CLOSED) dari daily-session --
// bukan bagian dari Morning Brief KPI, murni informasi lifecycle hari ini.
// Tidak menulis ke automation_outbox -- balasan sinkron langsung, bukan job
// terjadwal, sehingga tidak bentrok dengan idempotency key cron.
// =============================================================================

import { composeMorningBriefForSalesman } from "@/lib/n8n-automation/morning-brief";
import type { SalesKpiRepository } from "@/lib/sales-kpi/repository";
import type { DailySessionRepository } from "@/lib/daily-session/repository";
import type { DailySessionStatus } from "@/lib/daily-session/types";

export interface BuildOnDemandBriefInput {
  companyId: string;
  actorId: string;
  salesmanId: string;
  salesmanFullName: string;
  coverageAreas: string[];
  tenantName: string;
  businessDate: string;
}

function dayStatusLabel(status: DailySessionStatus | "NOT_STARTED"): string {
  switch (status) {
    case "ACTIVE":
      return "Hari ini SUDAH dimulai (ACTIVE).";
    case "CLOSED":
      return "Hari ini SUDAH ditutup (CLOSED).";
    default:
      return "Hari ini BELUM dimulai. Pilih \"Mulai Hari\" untuk memulai.";
  }
}

export async function buildOnDemandBrief(
  input: BuildOnDemandBriefInput,
  deps: { salesKpiRepository: SalesKpiRepository; dailySessionRepository: DailySessionRepository },
): Promise<string> {
  const content = await composeMorningBriefForSalesman(
    { salesKpiRepository: deps.salesKpiRepository },
    input.companyId,
    input.actorId,
    { userId: input.salesmanId, fullName: input.salesmanFullName, coverageAreas: input.coverageAreas },
    input.tenantName,
    input.businessDate,
  );

  const session = await deps.dailySessionRepository.findForBusinessDate(
    input.companyId,
    input.salesmanId,
    input.businessDate,
  );

  return [content.text, "", dayStatusLabel(session?.status ?? "NOT_STARTED")].join("\n");
}
