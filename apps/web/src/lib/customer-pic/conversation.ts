// =============================================================================
// State machine percakapan Telegram "Tambah Toko" — terpisah dari
// conversation state sales-orders/delivery/dispute (lihat migration
// store_pic_conversation_state). Punya expiry eksplisit (LANGKAH 6).
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PicRole, StoreSummary } from "./types";

export type StorePicAwaiting =
  | "none"
  | "store_name"
  | "store_address"
  | "store_area"
  | "store_phone"
  | "pic_name"
  | "pic_phone"
  | "pic_email"
  | "pic_roles"
  | "final_confirmation"
  | "similar_duplicate_confirmation"
  | "add_pic_store_search"
  | "add_pic_store_select"
  | "add_pic_name"
  | "add_pic_phone"
  | "add_pic_email"
  | "add_pic_roles"
  | "add_pic_confirm";

export interface StorePicDraft {
  storeName?: string;
  storeAddress?: string;
  storeArea?: string;
  storePhone?: string;
  picName?: string;
  picPhone?: string;
  picEmail?: string;
  picRoles?: PicRole[];
  conversationStartedAt?: string;
  /** Diisi saat similar_duplicate_warning -- dipakai untuk override konfirmasi. */
  similarDuplicateCustomerId?: string;
  similarDuplicateStoreName?: string;

  // -- Tambah PIC (PIC kedua dan seterusnya ke toko yang sudah ada) --
  addPicSearchResults?: StoreSummary[];
  addPicSelectedCustomerId?: string;
  addPicSelectedStoreName?: string;
  addPicName?: string;
  addPicPhone?: string;
  addPicEmail?: string;
  addPicRoles?: PicRole[];
}

export interface StorePicConversationState {
  awaiting: StorePicAwaiting;
  draft: StorePicDraft;
}

const EMPTY_STATE: StorePicConversationState = { awaiting: "none", draft: {} };
const CONVERSATION_TTL_MS = 30 * 60_000;

export interface StorePicConversationRepository {
  getState(identityId: string): Promise<StorePicConversationState>;
  setState(identityId: string, companyId: string, state: StorePicConversationState): Promise<void>;
}

export class SupabaseStorePicConversationRepository implements StorePicConversationRepository {
  constructor(private readonly supabase: SupabaseClient) {}

  async getState(identityId: string): Promise<StorePicConversationState> {
    const { data } = await this.supabase
      .from("store_pic_conversation_state")
      .select("awaiting, draft_state, expires_at")
      .eq("telegram_identity_id", identityId)
      .maybeSingle();
    if (!data) return { ...EMPTY_STATE };
    const row = data as { awaiting: StorePicAwaiting; draft_state: StorePicDraft; expires_at: string };
    if (new Date(row.expires_at).getTime() < Date.now()) return { ...EMPTY_STATE };
    return { awaiting: row.awaiting, draft: row.draft_state ?? {} };
  }

  async setState(identityId: string, companyId: string, state: StorePicConversationState): Promise<void> {
    await this.supabase.from("store_pic_conversation_state").upsert({
      telegram_identity_id: identityId,
      company_id: companyId,
      awaiting: state.awaiting,
      draft_state: state.draft,
      expires_at: new Date(Date.now() + CONVERSATION_TTL_MS).toISOString(),
    });
  }
}

export class InMemoryStorePicConversationRepository implements StorePicConversationRepository {
  private states = new Map<string, { state: StorePicConversationState; expiresAt: number }>();

  async getState(identityId: string): Promise<StorePicConversationState> {
    const entry = this.states.get(identityId);
    if (!entry) return { ...EMPTY_STATE };
    if (entry.expiresAt < Date.now()) return { ...EMPTY_STATE };
    return entry.state;
  }

  async setState(identityId: string, _companyId: string, state: StorePicConversationState): Promise<void> {
    this.states.set(identityId, { state, expiresAt: Date.now() + CONVERSATION_TTL_MS });
  }

  /** Test helper -- paksa expire tanpa menunggu 30 menit sungguhan. */
  forceExpire(identityId: string): void {
    const entry = this.states.get(identityId);
    if (entry) entry.expiresAt = 0;
  }
}

// ---------------------------------------------------------------------------
// Parsing murni (tanpa I/O).
// ---------------------------------------------------------------------------

const TRIGGER_PATTERN = /\btambah\s+toko\b/i;
const TRIGGER_PATTERN_ADD_PIC = /\btambah\s+pic\b/i;

export function detectAddStoreTrigger(text: string): boolean {
  return TRIGGER_PATTERN.test(text);
}

export function detectAddPicTrigger(text: string): boolean {
  return TRIGGER_PATTERN_ADD_PIC.test(text);
}

export function parseNumberedChoice(text: string, maxOption: number): number | null {
  const trimmed = text.trim();
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1 || n > maxOption || String(n) !== trimmed) return null;
  return n;
}

/** Multi-select: "1,3" atau "1 3" atau "1, 3, 4" -> [1,3] (unik, urut). */
export function parseMultipleChoices(text: string, maxOption: number): number[] | null {
  const parts = text
    .trim()
    .split(/[,\s]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 1 || n > maxOption || String(n) !== part) return null;
    if (!numbers.includes(n)) numbers.push(n);
  }
  return numbers.length > 0 ? numbers : null;
}
