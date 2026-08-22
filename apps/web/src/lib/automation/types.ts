// =============================================================================
// Automation Engine — Types
// =============================================================================

export type AutomationTriggerType =
  | "customer_dormant"
  | "churn_risk"
  | "repeat_order_due"
  | "large_order"
  | "new_order"
  | "low_stock"
  | "payment_overdue"
  | "new_customer"
  | "scheduled_daily"
  | "scheduled_weekly"
  | "manual"
  | "special_price_proposal_submitted"
  | "store_unlock_requested";

export type AutomationActionType =
  | "log"
  | "call_n8n"
  | "call_bablast"
  | "generate_ai_summary"
  | "mark_customer_flag";

export type AutomationStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface AutomationAction {
  type: AutomationActionType;
  webhook_id?: string;   // Untuk call_n8n: ID webhook di n8n_webhooks
  event?: string;        // Nama event yang dikirim ke n8n
  message?: string;      // Pesan log
  feature?: string;      // Untuk generate_ai_summary
  flag?: string;         // Untuk mark_customer_flag
  note?: string;         // Catatan informatif (tidak dieksekusi)
}

export interface AutomationCondition {
  field: string;
  operator: "eq" | "neq" | "gt" | "lt" | "gte" | "lte" | "in" | "contains";
  value: unknown;
}

export interface AutomationRule {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  trigger_type: AutomationTriggerType;
  trigger_config: Record<string, unknown>;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  is_active: boolean;
  priority: number;
  run_count: number;
  last_run_at: string | null;
}

export interface N8nWebhook {
  id: string;
  company_id: string;
  name: string;
  event_type: string;
  webhook_url: string;
  secret_key: string | null;
  headers: Record<string, string>;
  is_active: boolean;
  timeout_ms: number;
  retry_count: number;
}

export interface AutomationEvent {
  trigger_type: AutomationTriggerType;
  company_id: string;
  data: Record<string, unknown>;  // Event-specific payload
  fired_at: string;               // ISO timestamp
}

export interface ActionResult {
  type: AutomationActionType;
  status: "success" | "failed" | "skipped";
  message?: string;
  error?: string;
  duration_ms?: number;
}

export interface RuleExecutionResult {
  rule_id: string;
  rule_name: string;
  status: AutomationStatus;
  actions_executed: ActionResult[];
  total_duration_ms: number;
  error_msg?: string;
}
