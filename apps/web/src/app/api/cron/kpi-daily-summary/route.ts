// =============================================================================
// Vercel Cron trigger -- KPI Daily Summary (08:00 WIB, lihat vercel.json).
// Gate P4.14: menggantikan n8n sebagai penjadwal. Autentikasi via
// CRON_SECRET (Vercel resmi), lalu meneruskan panggilan ke endpoint
// generate+dispatch internal yang sudah ada (autentikasi terpisah, tidak
// berubah).
// =============================================================================

import { NextResponse } from "next/server";
import { verifyCronSecret, generateAndDispatch } from "@/lib/n8n-automation/cron";

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const result = await generateAndDispatch(request, "/api/internal/automation/kpi-daily-summary");
    return NextResponse.json(result);
  } catch (err) {
    console.error("[Cron /kpi-daily-summary]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
