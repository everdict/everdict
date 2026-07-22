import { createLlmClient } from "@everdict/agent-runtime";
import type { ModelRegistry, SecretStore } from "@everdict/application-control";
import { BadRequestError } from "@everdict/contracts";
import { modelApiKeySecretName } from "@everdict/domain";
import type OpenAI from "openai";
import type { Principal } from "./principal.js";

export interface ResolvedModel {
  client: OpenAI;
  model: string;
  temperature?: number;
}

export type ModelResolver = (principal: Principal) => Promise<ResolvedModel>;

// D3: the agent runs on the workspace's own registered model. Resolve (workspace, modelRef) → ModelSpec, read its
// API key from the workspace/user SecretStore, and build an OpenAI-compatible client (baseUrl = a LiteLLM/provider
// proxy). The key never leaves this process; it is used exactly like a dispatched job's injected model connection.
export function registryModelResolver(opts: {
  modelRegistry: ModelRegistry;
  secretStore: SecretStore;
  modelRef: string;
}): ModelResolver {
  return async (principal) => {
    const spec = await opts.modelRegistry.get(principal.workspace, opts.modelRef);
    const keyName = modelApiKeySecretName(spec);
    const scoped = await opts.secretStore.scopedEntries(principal.workspace, principal.subject);
    const apiKey = scoped.workspace[keyName] ?? scoped.user[keyName];
    if (apiKey === undefined && spec.baseUrl === undefined) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { keyName, modelRef: opts.modelRef },
        `The agent model "${opts.modelRef}" has no API key (secret ${keyName}) set and no baseUrl — cannot reach a provider.`,
      );
    }
    const client = createLlmClient({
      apiKey: apiKey ?? "",
      ...(spec.baseUrl !== undefined ? { baseURL: spec.baseUrl } : {}),
    });
    return {
      client,
      model: spec.model,
      ...(spec.params?.temperature !== undefined ? { temperature: spec.params.temperature } : {}),
    };
  };
}

// Dev fallback: an OpenAI-compatible endpoint from env (AGENT_LLM_*), used when no DB / registered model is present.
export function envModelResolver(opts: { baseURL?: string; apiKey: string; model: string }): ModelResolver {
  return async () => ({
    client: createLlmClient({ apiKey: opts.apiKey, ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}) }),
    model: opts.model,
  });
}
