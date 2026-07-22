import OpenAI from "openai";

export interface LlmClientOptions {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
}

// The kernel is a library — it never reads env. The host (apps/agent) resolves the workspace's model↔secret
// binding and injects the provider coordinates here. Any OpenAI-compatible endpoint works (LiteLLM, OpenAI, …).
export function createLlmClient(opts: LlmClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.apiKey,
    ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    timeout: opts.timeoutMs ?? 120_000,
  });
}
