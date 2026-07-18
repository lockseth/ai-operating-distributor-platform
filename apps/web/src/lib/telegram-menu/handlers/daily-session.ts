// =============================================================================
// Handler Mulai Hari / Tutup Hari -- tipis, mendelegasikan sepenuhnya ke
// lib/daily-session/{repository,service}.ts (RPC start_daily_session/
// close_daily_session) dan lib/daily-session/eod-summary.ts untuk komposisi
// ringkasan. Ringkasan dihitung DULU, baru close_daily_session dipanggil --
// supaya angka yang dilihat salesman SAMA PERSIS dengan yang tersimpan di
// close_summary (compute-then-close, bukan close-then-compute).
// =============================================================================

import type { DailySessionRepository } from "@/lib/daily-session/repository";
import { dailySessionIdempotencyKey } from "@/lib/daily-session/service";
import { composeEndOfDaySummary, type EndOfDaySummaryDeps } from "@/lib/daily-session/eod-summary";

export interface DailySessionHandlerInput {
  companyId: string;
  actorId: string;
  salesmanId: string;
  businessDate: string;
}

export async function handleStartDay(
  input: DailySessionHandlerInput,
  deps: { dailySessionRepository: DailySessionRepository },
): Promise<string> {
  const result = await deps.dailySessionRepository.start({
    companyId: input.companyId,
    actorId: input.actorId,
    salesmanId: input.salesmanId,
    businessDate: input.businessDate,
    idempotencyKey: dailySessionIdempotencyKey(input.salesmanId, input.businessDate),
  });

  switch (result.outcome) {
    case "started":
      return `Hari ini (${input.businessDate}) dimulai. Semoga sukses!`;
    case "already_started":
      return `Hari ini (${input.businessDate}) sudah dimulai sebelumnya.`;
    case "salesperson_not_eligible":
      return "Akun Anda tidak terdaftar sebagai salesman aktif -- hubungi admin.";
    case "forbidden":
      return "Anda tidak berwenang memulai hari untuk akun ini.";
    case "invalid_date":
    case "idempotency_key_required":
      return "Tanggal bisnis tidak valid -- coba lagi.";
    default:
      return "Tidak dapat memulai hari saat ini. Coba lagi beberapa saat lagi.";
  }
}

export async function handleCloseDay(
  input: DailySessionHandlerInput,
  deps: { dailySessionRepository: DailySessionRepository } & EndOfDaySummaryDeps,
): Promise<string> {
  const session = await deps.dailySessionRepository.findForBusinessDate(
    input.companyId,
    input.salesmanId,
    input.businessDate,
  );
  if (!session) {
    return `Hari ini (${input.businessDate}) belum dimulai -- tidak ada yang bisa ditutup.`;
  }

  const { summary, text } = await composeEndOfDaySummary(input, deps);

  const result = await deps.dailySessionRepository.close({
    companyId: input.companyId,
    actorId: input.actorId,
    sessionId: session.id,
    closeSummary: summary,
  });

  switch (result.outcome) {
    case "closed":
      return text;
    case "already_closed":
      return `Hari ini (${input.businessDate}) sudah ditutup sebelumnya.`;
    case "blocked_open_visits":
      return "Belum bisa ditutup -- masih ada kunjungan yang belum selesai.";
    case "blocked_open_deliveries":
      return [
        "Belum bisa ditutup -- masih ada pengiriman yang belum selesai.",
        "Selesaikan pengiriman lewat menu \"Pengiriman Hari Ini\" terlebih dahulu.",
      ].join("\n");
    case "forbidden":
      return "Anda tidak berwenang menutup hari untuk akun ini.";
    case "session_not_found":
      return `Hari ini (${input.businessDate}) belum dimulai -- tidak ada yang bisa ditutup.`;
    default:
      return "Tidak dapat menutup hari saat ini. Coba lagi beberapa saat lagi.";
  }
}
