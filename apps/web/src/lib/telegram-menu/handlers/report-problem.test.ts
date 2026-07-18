import { describe, expect, it } from "vitest";
import { InMemoryProblemReportRepository, handleReportProblemNote, startReportProblemFlow } from "./report-problem";

const COMPANY = "waluyo";
const SALES_1 = "sales-1";
const IDENTITY_ID = "identity-1";

describe("Laporkan Masalah -- scope minimal (satu catatan -> satu baris audit, tanpa tabel baru)", () => {
  it("startReportProblemFlow menanyakan catatan, set awaiting=report_problem_note", () => {
    const result = startReportProblemFlow();
    expect(result.message).toContain("masalah");
    expect(result.nextState.awaiting).toBe("report_problem_note");
  });

  it("catatan valid -> tercatat satu kali di ProblemReportRepository", async () => {
    const repo = new InMemoryProblemReportRepository();
    const result = await handleReportProblemNote(
      "Aplikasi lambat saat kirim foto bukti pengiriman",
      { companyId: COMPANY, identityId: IDENTITY_ID, salesmanId: SALES_1 },
      { problemReportRepository: repo },
    );
    expect(result.nextState.awaiting).toBe("none");
    expect(repo.reports).toHaveLength(1);
    expect(repo.reports[0]!.note).toContain("lambat");
    expect(repo.reports[0]!.companyId).toBe(COMPANY);
    expect(repo.reports[0]!.userId).toBe(SALES_1);
  });

  it("catatan terlalu pendek -> ditolak, tidak tercatat", async () => {
    const repo = new InMemoryProblemReportRepository();
    const result = await handleReportProblemNote(
      "ok",
      { companyId: COMPANY, identityId: IDENTITY_ID, salesmanId: SALES_1 },
      { problemReportRepository: repo },
    );
    expect(result.nextState.awaiting).toBe("report_problem_note");
    expect(repo.reports).toHaveLength(0);
  });
});
