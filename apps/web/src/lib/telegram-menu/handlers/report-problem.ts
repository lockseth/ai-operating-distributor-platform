// =============================================================================
// Laporkan Masalah -- scope MINIMAL disengaja (dikonfirmasi eksplisit dalam
// laporan implementasi): satu catatan bebas -> satu baris audit_logs
// (action='salesman.problem_reported'). TIDAK ada tabel baru, TIDAK ada
// status/resolution workflow, TIDAK ada notifikasi Owner (itu perlu kanal
// WhatsApp Owner yang eksplisit di luar scope phase ini). Kalau Founder
// ingin tracking yang lebih kaya, itu phase terpisah.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MenuConversationState } from "../conversation";

export interface ReportProblemInput {
  companyId: string;
  userId: string;
  identityId: string;
  note: string;
}

export interface ProblemReportRepository {
  reportProblem(input: ReportProblemInput): Promise<void>;
}

export class SupabaseProblemReportRepository implements ProblemReportRepository {
  constructor(private readonly client: SupabaseClient) {}

  async reportProblem(input: ReportProblemInput): Promise<void> {
    await this.client.from("audit_logs").insert({
      company_id: input.companyId,
      user_id: input.userId,
      action: "salesman.problem_reported",
      entity_type: "telegram_identity",
      entity_id: input.identityId,
      new_data: { note: input.note },
    });
  }
}

export class InMemoryProblemReportRepository implements ProblemReportRepository {
  public reports: (ReportProblemInput & { reportedAt: string })[] = [];

  async reportProblem(input: ReportProblemInput): Promise<void> {
    this.reports.push({ ...input, reportedAt: new Date().toISOString() });
  }
}

export interface ReportProblemHandlerContext {
  companyId: string;
  identityId: string;
  salesmanId: string;
}

export interface ReportProblemStepResult {
  message: string;
  nextState: MenuConversationState;
}

export function startReportProblemFlow(): ReportProblemStepResult {
  return {
    message: "Ceritakan masalah yang Anda alami (minimal 3 karakter):",
    nextState: { awaiting: "report_problem_note", draft: {} },
  };
}

export async function handleReportProblemNote(
  text: string,
  ctx: ReportProblemHandlerContext,
  deps: { problemReportRepository: ProblemReportRepository },
): Promise<ReportProblemStepResult> {
  const trimmed = text.trim();
  if (trimmed.length < 3) {
    return {
      message: "Catatan terlalu pendek (minimal 3 karakter). Coba lagi:",
      nextState: { awaiting: "report_problem_note", draft: {} },
    };
  }

  await deps.problemReportRepository.reportProblem({
    companyId: ctx.companyId,
    userId: ctx.salesmanId,
    identityId: ctx.identityId,
    note: trimmed,
  });

  return {
    message: "Terima kasih, masalah sudah dicatat dan akan ditinjau admin/manager.",
    nextState: { awaiting: "none", draft: {} },
  };
}
