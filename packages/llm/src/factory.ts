import { BadRequestError } from "@everdict/contracts";
import OpenAI, { type ClientOptions } from "openai";
import { AnthropicTransport } from "./anthropic-transport.js";
import { OpenAiTransport } from "./openai-transport.js";
import type { LlmTransport } from "./transport.js";

export interface TransportConfig {
  // The registered model's provider. "openai-compatible" routes custom OpenAI-shaped endpoints (vLLM, a LiteLLM proxy)
  // through the OpenAI transport with a custom baseUrl — an explicit escape hatch, never the default.
  provider: string;
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  // Injectable fetch (tests / a proxy). Anthropic uses it directly; OpenAI passes it to the SDK's `fetch` option.
  fetchImpl?: typeof fetch;
}

// Select the provider-native transport for a resolved model. The host resolves the model↔secret binding and passes the
// coordinates; this never reads env.
export function transportFor(config: TransportConfig): LlmTransport {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicTransport({
        apiKey: config.apiKey,
        ...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
        ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      });
    case "openai":
    case "openai-compatible":
      return new OpenAiTransport(buildOpenAiClient(config));
    default:
      throw new BadRequestError(
        "BAD_REQUEST",
        { provider: config.provider },
        `Unsupported model provider: ${config.provider}`,
      );
  }
}

function buildOpenAiClient(config: TransportConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl !== undefined ? { baseURL: config.baseUrl } : {}),
    // The SDK's Fetch type is narrower than the global fetch signature but runtime-compatible — pass it through.
    ...(config.fetchImpl !== undefined ? { fetch: config.fetchImpl as unknown as ClientOptions["fetch"] } : {}),
    timeout: config.timeoutMs ?? 120_000,
  });
}
