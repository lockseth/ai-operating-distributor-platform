// =============================================================================
// OpenAI Provider
// Aktif jika OPENAI_API_KEY tersedia di environment.
// =============================================================================

import type { AIProvider, CompletionRequest, CompletionResponse, EmbeddingRequest, EmbeddingResponse } from "../provider";

export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.openai.com/v1";
  private readonly defaultModel = "gpt-4o-mini";
  private readonly defaultEmbeddingModel = "text-embedding-3-small";

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
      throw new Error(`OpenAI API error ${response.status}: ${error}`);
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
      provider: "openai",
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const input = Array.isArray(request.text) ? request.text : [request.text];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model ?? this.defaultEmbeddingModel,
        input,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI Embeddings API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
      model: string;
    };

    return {
      embeddings: data.data.map((d) => d.embedding),
      usage: { totalTokens: data.usage.total_tokens },
      model: data.model,
      provider: "openai",
    };
  }
}
