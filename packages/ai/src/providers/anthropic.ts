// =============================================================================
// Anthropic (Claude) Provider
// Aktif jika ANTHROPIC_API_KEY tersedia di environment.
// =============================================================================

import type { AIProvider, CompletionRequest, CompletionResponse, EmbeddingRequest, EmbeddingResponse } from "../provider";

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.anthropic.com/v1";
  private readonly defaultModel = "claude-haiku-4-5-20251001";
  private readonly apiVersion = "2023-06-01";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isAvailable(): boolean {
    return this.apiKey.length > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      max_tokens: request.maxTokens ?? 500,
      temperature: request.temperature ?? 0.3,
      messages: [{ role: "user", content: request.prompt }],
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.apiVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${error}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
    };

    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    return {
      text,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      model: data.model,
      provider: "anthropic",
    };
  }

  async embed(_request: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw new Error("Anthropic does not support embeddings. Use OpenAI or another provider.");
  }
}
