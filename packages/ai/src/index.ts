export type {
  AIProvider,
  AIProviderName,
  CompletionRequest,
  CompletionResponse,
  ConversationMessage,
  EmbeddingRequest,
  EmbeddingResponse,
} from "./provider";
export {
  registerProvider,
  getProvider,
  getFirstAvailableProvider,
  complete,
} from "./provider";

export { OpenAIProvider }    from "./providers/openai";
export { AnthropicProvider } from "./providers/anthropic";
export { DeepSeekProvider }  from "./providers/deepseek";
export { MockAIProvider }    from "./providers/mock";

export type {
  DiscountType,
  ExtractedSalesOrder,
  ExtractedSalesOrderItem,
} from "./types/sales-order";
