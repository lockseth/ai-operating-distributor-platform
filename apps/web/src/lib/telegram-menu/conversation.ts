// =============================================================================
// State machine percakapan Telegram "Menu Utama" Waluyo Daily Operating Loop —
// terpisah dari conversation state domain lain (sales-order, delivery,
// dispute, store-pic). Lihat migration telegram_menu_conversation_state.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export type MenuAwaiting =
  | "none"
  | "main_menu"
  | "visit_store_select"
  | "visit_pic_select"
  | "visit_outcome_notes"
  | "visit_order_link_confirm"
  | "order_intake_store_select"
  | "order_intake_pic_select"
  | "order_intake_awaiting_text"
  | "delivery_select"
  | "report_problem_note";

export interface MenuDraft {
  customerId?: string;
  customerName?: string;
  picId?: string | null;
  picName?: string | null;
  outcomeNotes?: string;
  orderSource?: "CUSTOMER_WHATSAPP" | "CUSTOMER_PHONE";
  deliveryId?: string;
  [key: string]: unknown;
}

export interface MenuConversationState {
  awaiting: MenuAwaiting;
  draft: MenuDraft;
}

const EMPTY_STATE: MenuConversationState = { awaiting: "none", draft: {} };

export interface MenuConversationRepository {
  getState(identityId: string): Promise<MenuConversationState>;
  setState(identityId: string, companyId: string, state: MenuConversationState): Promise<void>;
}

export class SupabaseMenuConversationRepository implements MenuConversationRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async getState(identityId: string): Promise<MenuConversationState> {
    const { data } = await this.supabase
      .from("telegram_menu_conversation_state")
      .select("awaiting, draft_state")
      .eq("telegram_identity_id", identityId)
      .maybeSingle();
    if (!data) return { ...EMPTY_STATE };
    const row = data as { awaiting: MenuAwaiting; draft_state: MenuDraft };
    return { awaiting: row.awaiting, draft: row.draft_state ?? {} };
  }

  async setState(
    identityId: string,
    companyId: string,
    state: MenuConversationState,
  ): Promise<void> {
    await this.supabase.from("telegram_menu_conversation_state").upsert({
      telegram_identity_id: identityId,
      company_id: companyId,
      awaiting: state.awaiting,
      draft_state: state.draft,
    });
  }
}

export class InMemoryMenuConversationRepository implements MenuConversationRepository {
  private states = new Map<string, MenuConversationState>();

  async getState(identityId: string): Promise<MenuConversationState> {
    return this.states.get(identityId) ?? { ...EMPTY_STATE };
  }

  async setState(
    identityId: string,
    _companyId: string,
    state: MenuConversationState,
  ): Promise<void> {
    this.states.set(identityId, state);
  }
}

// ---------------------------------------------------------------------------
// Parsing murni (tanpa I/O) — deteksi trigger menu & pilihan bernomor/callback.
// ---------------------------------------------------------------------------

const MENU_TRIGGER_PATTERN = /^\/(start|menu)\b/i;

export function detectMenuTrigger(text: string): boolean {
  return MENU_TRIGGER_PATTERN.test(text.trim());
}

export function parseNumberedChoice(text: string, maxOption: number): number | null {
  const trimmed = text.trim();
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1 || n > maxOption || String(n) !== trimmed) return null;
  return n;
}

/** callback_data konvensi: "menu:{action}:{arg1}:{arg2}" (Telegram limit 64 byte). */
export function parseMenuCallbackData(
  data: string,
): { action: string; args: string[] } | null {
  const parts = data.split(":");
  if (parts[0] !== "menu" || !parts[1]) return null;
  return { action: parts[1], args: parts.slice(2) };
}

export function buildMenuCallbackData(action: string, ...args: string[]): string {
  return ["menu", action, ...args].join(":");
}
