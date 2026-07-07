// =============================================================================
// n8n Webhook Client
// Mengirim event ke n8n webhook URL dengan timeout, retry, dan HMAC signing.
// =============================================================================

import { createHmac } from "crypto";

export interface N8nWebhookPayload {
  event_type: string;
  company_id: string;
  rule_name: string;
  fired_at: string;
  data: Record<string, unknown>;
}

export interface N8nCallOptions {
  webhookUrl: string;
  event: N8nWebhookPayload;
  secretKey?: string;
  timeoutMs?: number;
  retries?: number;
  extraHeaders?: Record<string, string>;
}

export async function callN8nWebhook(options: N8nCallOptions): Promise<boolean> {
  const { webhookUrl, event, secretKey, timeoutMs = 5000, retries = 2, extraHeaders = {} } = options;

  const body = JSON.stringify(event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-FlowSales-Event": event.event_type,
    "X-FlowSales-Company": event.company_id,
    ...extraHeaders,
  };

  // HMAC-SHA256 signature for webhook verification
  if (secretKey) {
    const sig = createHmac("sha256", secretKey).update(body).digest("hex");
    headers["X-FlowSales-Signature"] = `sha256=${sig}`;
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(webhookUrl, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new Error(`n8n returned ${response.status}: ${text.slice(0, 200)}`);
        continue;
      }

      return true;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(`n8n webhook timeout after ${timeoutMs}ms`);
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  if (process.env.NODE_ENV !== "production") {
    console.error(`[n8n] Webhook call failed after ${retries + 1} attempts:`, lastError?.message);
  }
  return false;
}

// Build a standard payload untuk setiap event type
export function buildCustomerDormantPayload(customer: {
  id: string;
  name: string;
  code: string;
  area: string;
  last_order_at: string | null;
  days_inactive: number;
  sales_name: string;
}): Record<string, unknown> {
  return {
    customer_id: customer.id,
    customer_name: customer.name,
    customer_code: customer.code,
    area: customer.area,
    last_order_at: customer.last_order_at,
    days_inactive: customer.days_inactive,
    sales_pic: customer.sales_name,
    message: `Reseller ${customer.name} tidak order selama ${customer.days_inactive} hari`,
  };
}

export function buildLargeOrderPayload(order: {
  id: string;
  order_number: string;
  customer_name: string;
  sales_name: string;
  final_amount: number;
  created_at: string;
}): Record<string, unknown> {
  return {
    order_id: order.id,
    order_number: order.order_number,
    customer_name: order.customer_name,
    sales_name: order.sales_name,
    amount: order.final_amount,
    amount_formatted: new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" }).format(order.final_amount),
    created_at: order.created_at,
    message: `Order besar dari ${order.customer_name}: ${new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" }).format(order.final_amount)}`,
  };
}
