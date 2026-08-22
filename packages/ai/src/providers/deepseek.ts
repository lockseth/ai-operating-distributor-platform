// =============================================================================
// DeepSeek Provider
// Aktif jika DEEPSEEK_API_KEY tersedia di environment. Kontrak API DeepSeek
// sengaja dibuat kompatibel format OpenAI (chat/completions, choices[].message,
// usage.prompt_tokens/completion_tokens) -- lihat OpenAIProvider untuk pola
// yang sama persis, cuma beda base URL + model default.
// =============================================================================

import type { AIProvider, CompletionRequest, CompletionResponse, EmbeddingRequest, EmbeddingResponse } from "../provider";

export class DeepSeekProvider implements AIProvider {
  readonly name = "deepseek" as const;
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.deepseek.com/v1";
  private readonly defaultModel = "deepseek-chat";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    if (request.messages && request.messages.length > 0) {
      messages.push(...request.messages.map((m) => ({ role: m.role, content: m.content })));
    } else {
      messages.push({ role: "user", content: request.prompt });
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model ?? this.defaultModel,
        messages,
        max_tokens: request.maxTokens ?? 500,
        temperature: request.temperature ?? 0.3,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    return {
      text: data.choices[0]?.message?.content ?? "",
      usage: {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      },
      model: data.model,
      provider: "deepseek",
    };
  }

  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("DeepSeek does not offer an embeddings API. Use OpenAI or another provider.");
  }
}
