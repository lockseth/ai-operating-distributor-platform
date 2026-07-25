import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/get-user";
import { hasPermission } from "@/lib/auth/permissions";
import { IMPORT_TYPES, type ImportType } from "@/lib/imports/types";
import { buildImportTemplateCSV, buildImportTemplateXlsx, importTemplateFilename } from "@/lib/imports/templates";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";

// 60 request/menit per IP -- konsisten dengan endpoint lain (lihat webhooks/telegram, webhooks/n8n).
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function GET(req: Request, { params }: { params: Promise<{ type: string }> }) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`imports-templates:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.success) return buildRateLimitResponse(rl.resetAt);

  const user = await getAuthUser();
  if (!hasPermission(user.permissions, "imports.view")) {
    return NextResponse.json({ error: "Tidak berwenang." }, { status: 403 });
  }

  const { type } = await params;
  if (!IMPORT_TYPES.includes(type as ImportType)) {
    return NextResponse.json({ error: "Jenis import tidak dikenal." }, { status: 400 });
  }

  const format = new URL(req.url).searchParams.get("format") === "xlsx" ? "xlsx" : "csv";

  if (format === "xlsx") {
    const buf = await buildImportTemplateXlsx(type as ImportType);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${importTemplateFilename(type as ImportType, "xlsx")}"`,
      },
    });
  }

  const csv = buildImportTemplateCSV(type as ImportType);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${importTemplateFilename(type as ImportType, "csv")}"`,
    },
  });
}
