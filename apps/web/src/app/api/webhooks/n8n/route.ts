// =============================================================================
// Inbound Webhook dari n8n → FlowSales
// n8n dapat mengirim event ke sini untuk memicu aksi di FlowSales.
// Autentikasi: HMAC-SHA256 signature di header X-FlowSales-Signature,
// atau Bearer token di Authorization header (legacy fallback).
// =============================================================================

import { NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/admin";
import { createHmac, timingSafeEqual } from "crypto";
import { checkRateLimit, getClientIp, buildRateLimitResponse } from "@/lib/rate-limit";

interface InboundN8nEvent {
  event_type: string;
  company_id: string;
  data: Record<string, unknown>;
}

function verifySignature(body: string, signatureHeader: string | null): boolean {
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!secret) {
    // Jika secret belum dikonfigurasi, tolak semua request untuk keamanan
    return false;
  }
  if (!signatureHeader) return false;

  // Format: "sha256=<hex>"
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;

  const receivedHex = signatureHeader.slice(prefix.length);
  const expectedHex = createHmac("sha256", secret).update(body).digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(receivedHex, "hex"),
      Buffer.from(expectedHex, "hex")
    );
  } catch {
    // Buffer length mismatch — signature tidak valid
    return false;
  }
}

// 60 req/menit per IP untuk mencegah flood dari n8n yang misconfigured
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const ip = getClientIp(request);
    const rl = checkRateLimit(`n8n:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!rl.success) return buildRateLimitResponse(rl.resetAt);

    // Baca raw body untuk signature verification sebelum parsing JSON
    const rawBody = await request.text();

    const signatureHeader = request.headers.get("X-FlowSales-Signature");
    if (!verifySignature(rawBody, signatureHeader)) {
      return NextResponse.json({ error: "Unauthorized: invalid or missing signature" }, { status: 401 });
    }

    let body: InboundN8nEvent;
    try {
      body = JSON.parse(rawBody) as InboundN8nEvent;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.event_type || !body.company_id) {
      return NextResponse.json({ error: "Missing event_type or company_id" }, { status: 400 });
    }

    // Verify company exists
    const supabase = getAdminClient();
    const { data: company } = await supabase
      .from("companies")
      .select("id, name")
      .eq("id", body.company_id)
      .single();

    if (!company) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    // Log inbound event
    await supabase.from("automation_logs").insert({
      company_id: body.company_id,
      rule_id: null,
      rule_name: "n8n Inbound",
      trigger_type: "manual",
      trigger_data: {
        source: "n8n",
        event_type: body.event_type,
        ...body.data,
      },
      status: "success",
      actions_executed: [{ type: "inbound_webhook", status: "success", message: `Event '${body.event_type}' diterima dari n8n` }],
    });

    return NextResponse.json({
      received: true,
      event_type: body.event_type,
      company: (company as { id: string; name: string }).name,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[Webhook /n8n]", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
