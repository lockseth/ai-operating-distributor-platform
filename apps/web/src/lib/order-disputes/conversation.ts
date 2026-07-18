// =============================================================================
// State machine percakapan Telegram "Batalkan atau Sengketakan Order" —
// terpisah dari conversation state sales-orders/delivery (lihat migration
// order_dispute_conversation_state).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContactSource, RequestType } from "./types";

export type DisputeAwaiting =
  | "none"
  | "type_selection"
  | "pic_name"
  | "contact_source"
  | "reason_selection"
  | "notes"
  | "final_confirmation";

export interface DisputeDraft {
  requestType?: RequestType;
  picName?: string;
  contactSource?: ContactSource;
  reasonCode?: string;
  notes?: string | null;
  conversationStartedAt?: string;
  // Snapshot order (diambil sekali saat lookup awal) supaya langkah
  // berikutnya tidak perlu lookup ulang by-number.
  orderNumber?: string;
  customerName?: string;
  customerId?: string | null;
  finalAmount?: number;
}

export interface DisputeConversationState {
  awaiting: DisputeAwaiting;
  pendingSalesOrderId: string | null;
  draft: DisputeDraft;
}

const EMPTY_STATE: DisputeConversationState = { awaiting: "none", pendingSalesOrderId: null, draft: {} };

export interface DisputeConversationRepository {
  getState(identityId: string): Promise<DisputeConversationState>;
  setState(identityId: string, companyId: string, state: DisputeConversationState): Promise<void>;
}

export class SupabaseDisputeConversationRepository implements DisputeConversationRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async getState(identityId: string): Promise<DisputeConversationState> {
    const { data } = await this.supabase
      .from("order_dispute_conversation_state")
      .select("awaiting, pending_sales_order_id, draft_state")
      .eq("telegram_identity_id", identityId)
      .maybeSingle();
    if (!data) return { ...EMPTY_STATE };
    const row = data as { awaiting: DisputeAwaiting; pending_sales_order_id: string | null; draft_state: DisputeDraft };
    return { awaiting: row.awaiting, pendingSalesOrderId: row.pending_sales_order_id, draft: row.draft_state ?? {} };
  }

  async setState(identityId: string, companyId: string, state: DisputeConversationState): Promise<void> {
    await this.supabase.from("order_dispute_conversation_state").upsert({
      telegram_identity_id: identityId,
      company_id: companyId,
      awaiting: state.awaiting,
      pending_sales_order_id: state.pendingSalesOrderId,
      draft_state: state.draft,
    });
  }
}

export class InMemoryDisputeConversationRepository implements DisputeConversationRepository {
  private states = new Map<string, DisputeConversationState>();

  async getState(identityId: string): Promise<DisputeConversationState> {
    return this.states.get(identityId) ?? { ...EMPTY_STATE };
  }

  async setState(identityId: string, _companyId: string, state: DisputeConversationState): Promise<void> {
    this.states.set(identityId, state);
  }
}

// ---------------------------------------------------------------------------
// Parsing murni (tanpa I/O) — deteksi trigger & pilihan bernomor.
// ---------------------------------------------------------------------------

const TRIGGER_PATTERN = /\b(batalkan|batal|sengketa|dispute)\b/i;
/** Nomor order = token yang mengandung digit, biasanya format SO-XXXX. */
const ORDER_NUMBER_PATTERN = /\b([A-Z]{2,}-?\d{3,})\b/i;

export function detectDisputeTrigger(text: string): { isTrigger: boolean; orderNumber: string | null } {
  const isTrigger = TRIGGER_PATTERN.test(text);
  if (!isTrigger) return { isTrigger: false, orderNumber: null };
  const match = text.match(ORDER_NUMBER_PATTERN);
  return { isTrigger: true, orderNumber: match ? match[1]!.toUpperCase() : null };
}

export function parseNumberedChoice(text: string, maxOption: number): number | null {
  const trimmed = text.trim();
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1 || n > maxOption || String(n) !== trimmed) return null;
  return n;
}
