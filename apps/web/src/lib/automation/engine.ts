// =============================================================================
// Automation Engine
// Evaluasi rule, eksekusi actions, dan log hasil ke automation_logs.
// Selalu menggunakan service role client untuk bypass RLS.
// =============================================================================

import { getAdminClient } from "@/lib/supabase/admin";
import type {
  AutomationEvent,
  AutomationRule,
  AutomationAction,
  ActionResult,
  RuleExecutionResult,
} from "./types";
import { callN8nWebhook } from "./n8n-client";

// Fetch active rules for a given trigger type + company
async function fetchMatchingRules(
  companyId: string,
  triggerType: string
): Promise<AutomationRule[]> {
  const supabase = getAdminClient();
  const { data } = await supabase
    .from("automation_rules")
    .select("*")
    .eq("company_id", companyId)
    .eq("trigger_type", triggerType)
    .eq("is_active", true)
    .order("priority", { ascending: false });

  return (data ?? []) as unknown as AutomationRule[];
}

// Evaluate conditions against event data
function evaluateConditions(
  conditions: AutomationRule["conditions"],
  eventData: Record<string, unknown>
): boolean {
  for (const cond of conditions) {
    const fieldValue = eventData[cond.field];
    let pass = false;

    switch (cond.operator) {
      case "eq":    pass = fieldValue === cond.value; break;
      case "neq":   pass = fieldValue !== cond.value; break;
      case "gt":    pass = (fieldValue as number) > (cond.value as number); break;
      case "lt":    pass = (fieldValue as number) < (cond.value as number); break;
      case "gte":   pass = (fieldValue as number) >= (cond.value as number); break;
      case "lte":   pass = (fieldValue as number) <= (cond.value as number); break;
      case "in":    pass = Array.isArray(cond.value) && (cond.value as unknown[]).includes(fieldValue); break;
      case "contains": pass = typeof fieldValue === "string" && fieldValue.includes(String(cond.value)); break;
    }

    if (!pass) return false;
  }
  return true;
}

// Execute a single action
async function executeAction(
  action: AutomationAction,
  event: AutomationEvent,
  rule: AutomationRule
): Promise<ActionResult> {
  const start = Date.now();

  try {
    switch (action.type) {
      case "log": {
        if (process.env.NODE_ENV !== "production") {
          console.log(`[Automation] ${rule.name}: ${action.message ?? "Rule triggered"}`, {
            trigger_type: event.trigger_type,
            company_id: event.company_id,
          });
        }
        return { type: "log", status: "success", message: action.message, duration_ms: Date.now() - start };
      }

      case "call_n8n": {
        // Fetch registered webhooks for this event type
        const supabase = getAdminClient();
        const eventType = action.event ?? event.trigger_type;
        const { data: webhooks } = await supabase
          .from("n8n_webhooks")
          .select("*")
          .eq("company_id", event.company_id)
          .eq("event_type", eventType)
          .eq("is_active", true);

        if (!webhooks || webhooks.length === 0) {
          return {
            type: "call_n8n",
            status: "skipped",
            message: `Tidak ada webhook terdaftar untuk event '${eventType}'. Daftarkan URL webhook n8n di Pengaturan > Automation.`,
            duration_ms: Date.now() - start,
          };
        }

        const results: string[] = [];
        for (const webhook of webhooks as Array<{ id: string; webhook_url: string; name: string }>) {
          const success = await callN8nWebhook({
            webhookUrl: webhook.webhook_url,
            event: {
              event_type: eventType,
              company_id: event.company_id,
              rule_name: rule.name,
              fired_at: event.fired_at,
              data: event.data,
            },
            timeoutMs: 5000,
          });

          // Update last_called_at + call_count
          await supabase
            .from("n8n_webhooks")
            .update({
              last_called_at: new Date().toISOString(),
              last_error: success ? null : "Call failed",
            })
            .eq("id", webhook.id);

          results.push(`${webhook.name}: ${success ? "OK" : "FAILED"}`);
        }

        return {
          type: "call_n8n",
          status: "success",
          message: results.join(", "),
          duration_ms: Date.now() - start,
        };
      }

      case "generate_ai_summary": {
        return {
          type: "generate_ai_summary",
          status: "skipped",
          message: `Fitur generate_ai_summary (${action.feature ?? "summary"}) belum tersedia — gunakan halaman AI Intelligence untuk analisis manual.`,
          duration_ms: Date.now() - start,
        };
      }

      case "mark_customer_flag": {
        const customerId = event.data.customer_id as string;
        if (!customerId) return { type: "mark_customer_flag", status: "skipped", message: "No customer_id in event", duration_ms: Date.now() - start };
        const flag = action.flag ?? "flagged";
        const supabase = getAdminClient();
        const { data: existing } = await supabase
          .from("customers")
          .select("custom_fields")
          .eq("id", customerId)
          .eq("company_id", event.company_id)
          .maybeSingle();
        const currentFields = (existing?.custom_fields as Record<string, unknown>) ?? {};
        await supabase
          .from("customers")
          .update({ custom_fields: { ...currentFields, automation_flag: flag, flagged_at: new Date().toISOString() } })
          .eq("id", customerId)
          .eq("company_id", event.company_id)
          .throwOnError();
        return { type: "mark_customer_flag", status: "success", message: `Customer ${customerId} flagged as '${flag}'`, duration_ms: Date.now() - start };
      }

      default:
        return { type: action.type, status: "skipped", message: "Unknown action type" };
    }
  } catch (err) {
    return {
      type: action.type,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };
  }
}

// Log execution result to automation_logs
async function logExecution(
  event: AutomationEvent,
  rule: AutomationRule,
  result: RuleExecutionResult
): Promise<void> {
  try {
    const supabase = getAdminClient();
    await supabase.from("automation_logs").insert({
      company_id: event.company_id,
      rule_id: rule.id,
      rule_name: rule.name,
      trigger_type: event.trigger_type,
      trigger_data: event.data,
      status: result.status,
      actions_executed: result.actions_executed,
      error_msg: result.error_msg ?? null,
      duration_ms: result.total_duration_ms,
    });

    // Update rule run stats
    await supabase
      .from("automation_rules")
      .update({ run_count: rule.run_count + 1, last_run_at: new Date().toISOString() })
      .eq("id", rule.id);
  } catch {
    console.error("[Automation] Failed to log execution — continuing");
  }
}

// Main: process an automation event
export async function processAutomationEvent(event: AutomationEvent): Promise<RuleExecutionResult[]> {
  const rules = await fetchMatchingRules(event.company_id, event.trigger_type);
  const results: RuleExecutionResult[] = [];

  for (const rule of rules) {
    const start = Date.now();

    // Evaluate conditions
    if (rule.conditions.length > 0 && !evaluateConditions(rule.conditions, event.data)) {
      const result: RuleExecutionResult = {
        rule_id: rule.id,
        rule_name: rule.name,
        status: "skipped",
        actions_executed: [],
        total_duration_ms: Date.now() - start,
      };
      await logExecution(event, rule, result);
      results.push(result);
      continue;
    }

    // Execute actions sequentially
    const actionResults: ActionResult[] = [];
    let hasFailed = false;

    for (const action of rule.actions as AutomationAction[]) {
      const ar = await executeAction(action, event, rule);
      actionResults.push(ar);
      if (ar.status === "failed") { hasFailed = true; }
    }

    const result: RuleExecutionResult = {
      rule_id: rule.id,
      rule_name: rule.name,
      status: hasFailed ? "failed" : "success",
      actions_executed: actionResults,
      total_duration_ms: Date.now() - start,
    };

    await logExecution(event, rule, result);
    results.push(result);
  }

  return results;
}
