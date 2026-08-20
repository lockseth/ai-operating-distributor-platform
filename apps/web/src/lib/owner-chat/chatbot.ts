// =============================================================================
// Milestone 3 (fondasi chatbot bisnis Owner) -- wiring ke packages/ai.
// SATU-SATUNYA titik di apps/web yang benar-benar memanggil packages/ai
// (sebelumnya belum pernah dipakai sama sekali, lihat TRACKER Backlog #8).
//
// Registrasi provider dari env var OPENAI_API_KEY/ANTHROPIC_API_KEY --
// KODE ini bisa ditulis & di-review tanpa API key, tapi TIDAK bisa
// benar-benar dites tanpa salah satu key tersedia. Kalau belum ada key
// sama sekali, askOwnerChatbot() mengembalikan error yang jelas ("belum
// aktif"), TIDAK pernah pura-pura menjawab dengan data karangan.
// =============================================================================

import {
  registerProvider,
  getFirstAvailableProvider,
  complete,
  OpenAIProvider,
  AnthropicProvider,
  type AIProviderName,
  type ConversationMessage,
} from "@flowsales/ai";
import { buildOwnerChatContext } from "./context-builder";
import type { OwnerBusinessSnapshot } from "./snapshot";

let providersRegistered = false;

/** Idempotent -- aman dipanggil berkali-kali (mis. tiap request di dev/hot-reload). */
function ensureProvidersRegistered(): void {
  if (providersRegistered) return;
  providersRegistered = true;

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) registerProvider(new AnthropicProvider(anthropicKey));

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) registerProvider(new OpenAIProvider(openaiKey));
}

const SYSTEM_INSTRUCTIONS =
  "Kamu adalah asisten AI untuk Owner sebuah distributor, bagian dari AODP " +
  "(AI Operating Distributor Platform). Jawab pertanyaan Owner tentang " +
  "bisnisnya HANYA berdasarkan data ringkasan di bawah ini -- JANGAN " +
  "mengarang angka yang tidak ada di situ. Kalau data yang tersedia tidak " +
  "cukup untuk menjawab, katakan terus terang bahwa datanya belum ada, " +
  "jangan menebak. Jawab singkat, langsung ke inti, dalam Bahasa Indonesia.";

export interface AskOwnerChatbotResult {
  ok: boolean;
  answer?: string;
  error?: string;
}

export async function askOwnerChatbot(
  question: string,
  history: ConversationMessage[],
  snapshot: OwnerBusinessSnapshot,
): Promise<AskOwnerChatbotResult> {
  ensureProvidersRegistered();

  let providerName: AIProviderName;
  try {
    providerName = getFirstAvailableProvider(["anthropic", "openai"]).name;
  } catch {
    return {
      ok: false,
      error:
        "Chatbot AI belum aktif -- menunggu API key provider (OpenAI atau Anthropic) dikonfigurasi. " +
        "Fondasi datanya sudah siap, tinggal sambungkan provider.",
    };
  }

  const context = buildOwnerChatContext(snapshot);
  const systemPrompt = `${SYSTEM_INSTRUCTIONS}\n\n${context}`;
  const messages: ConversationMessage[] = [...history, { role: "user", content: question }];

  try {
    const response = await complete(
      { prompt: question, systemPrompt, messages, maxTokens: 600, temperature: 0.3 },
      providerName,
    );
    return { ok: true, answer: response.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Gagal menghubungi AI provider." };
  }
}
