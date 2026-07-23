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
// Resolve an explicitly-named registered model (a workspace AgentSpec's model override) for this principal.
export type ModelByIdResolver = (principal: Principal, modelRef: string) => Promise<ResolvedModel>;

// D3 core: resolve (workspace, modelRef) → ModelSpec, read its API key from the workspace/user SecretStore, and build
// an OpenAI-compatible client (baseUrl = a LiteLLM/provider proxy). The key never leaves this process; it is used
// exactly like a dispatched job's injected model connection.
async function resolveRegisteredModel(
  modelRegistry: ModelRegistry,
  secretStore: SecretStore,
  principal: Principal,
  modelRef: string,
): Promise<ResolvedModel> {
  const spec = await modelRegistry.get(principal.workspace, modelRef);
  const keyName = modelApiKeySecretName(spec);
  const scoped = await secretStore.scopedEntries(principal.workspace, principal.subject);
  const apiKey = scoped.workspace[keyName] ?? scoped.user[keyName];
  if (apiKey === undefined && spec.baseUrl === undefined) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { keyName, modelRef },
      `The agent model "${modelRef}" has no API key (secret ${keyName}) set and no baseUrl — cannot reach a provider.`,
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
}

// D3: the agent runs on the workspace's own registered model (the server's default agent model).
export function registryModelResolver(opts: {
  modelRegistry: ModelRegistry;
  secretStore: SecretStore;
  modelRef: string;
}): ModelResolver {
  return (principal) => resolveRegisteredModel(opts.modelRegistry, opts.secretStore, principal, opts.modelRef);
}

// Resolve an arbitrary registered model by id — the channel a workspace AgentSpec.model override goes through.
export function registryModelByIdResolver(opts: {
  modelRegistry: ModelRegistry;
  secretStore: SecretStore;
}): ModelByIdResolver {
  return (principal, modelRef) => resolveRegisteredModel(opts.modelRegistry, opts.secretStore, principal, modelRef);
}

// Dev fallback: an OpenAI-compatible endpoint from env (AGENT_LLM_*), used when no DB / registered model is present.
export function envModelResolver(opts: { baseURL?: string; apiKey: string; model: string }): ModelResolver {
  return async () => ({
    client: createLlmClient({ apiKey: opts.apiKey, ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}) }),
    model: opts.model,
  });
}
