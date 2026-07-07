// =============================================================================
// FlowSales AI — AI Provider Layer
// Abstract interface for all AI provider integrations.
// Business logic must NEVER call AI providers directly — always use this layer.
// ADR-002: docs/adr/ADR-002-ai-provider-layer.md
// =============================================================================

// ---------------------------------------------------------------------------
// Core Interfaces
// ---------------------------------------------------------------------------

export interface CompletionRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface CompletionResponse {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  provider: AIProviderName;
}

export interface EmbeddingRequest {
  text: string | string[];
  model?: string;
}

export interface EmbeddingResponse {
  embeddings: number[][];
  usage: {
    totalTokens: number;
  };
  model: string;
  provider: AIProviderName;
}

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

export type AIProviderName = "openai" | "anthropic" | "gemini" | "openrouter";

export interface AIProvider {
  name: AIProviderName;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  isAvailable(): boolean;
}

// ---------------------------------------------------------------------------
// Provider Registry (singleton-style factory)
// ---------------------------------------------------------------------------

const registry = new Map<AIProviderName, AIProvider>();

export function registerProvider(provider: AIProvider): void {
  registry.set(provider.name, provider);
}

export function getProvider(name: AIProviderName): AIProvider {
  const provider = registry.get(name);
  if (!provider) {
    throw new Error(
      `AI provider "${name}" is not registered. Register it before use.`
    );
  }
  if (!provider.isAvailable()) {
    throw new Error(
      `AI provider "${name}" is registered but not available (missing API key?).`
    );
  }
  return provider;
}

export function getFirstAvailableProvider(
  preferred: AIProviderName[] = ["openai", "anthropic", "gemini", "openrouter"]
): AIProvider {
  for (const name of preferred) {
    const provider = registry.get(name);
    if (provider?.isAvailable()) return provider;
  }
  throw new Error("No AI provider is available. Check your API keys.");
}

// ---------------------------------------------------------------------------
// Typed completion helper
// ---------------------------------------------------------------------------

export async function complete(
  request: CompletionRequest,
  providerName?: AIProviderName
): Promise<CompletionResponse> {
  const provider = providerName
    ? getProvider(providerName)
    : getFirstAvailableProvider();
  return provider.complete(request);
}
