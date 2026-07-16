// =============================================================================
// insertKnowledgeCandidate — satu-satunya jalur resmi menulis
// knowledge_candidates (AI Decision Kernel Foundation Gate).
//
// Sebelum ini ada dua implementasi terpisah (sales-orders/knowledge-provider.ts
// dan dispatch/repository.ts) dengan field mapping yang tidak konsisten —
// dispatch tidak mengisi source_order_id. Helper ini menutup drift itu:
// status SELALU 'pending' (governance: koreksi domain tidak boleh langsung
// mempublikasikan Knowledge), dan seluruh field dipetakan dari satu kontrak
// (KnowledgeCandidateInput, @flowsales/types).
//
// Ditempatkan di @flowsales/database (bukan @flowsales/shared) karena
// menyentuh Supabase langsung — @flowsales/shared sengaja bebas I/O.
// =============================================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeCandidateInput } from "@flowsales/types";

export async function insertKnowledgeCandidate(
  supabase: SupabaseClient,
  input: KnowledgeCandidateInput
): Promise<void> {
  const { error } = await supabase.from("knowledge_candidates").insert({
    company_id: input.companyId,
    candidate_type: input.candidateType,
    raw_text: input.rawText,
    suggested_value: input.suggestedValue,
    source_order_id: input.sourceOrderId ?? null,
    submitted_by: input.submittedBy,
    status: "pending",
  });
  if (error) {
    throw new Error(`Gagal insert knowledge_candidates: ${error.message}`);
  }
}
