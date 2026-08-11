import type { ModelRegistry, SecretStore } from "@everdict/application-control";
import { BadRequestError } from "@everdict/contracts";
import { SHARED_TENANT, contentDigest, modelApiKeySecretName } from "@everdict/domain";
import { type LlmTransport, transportFor } from "@everdict/llm";
import type { Principal } from "./principal.js";

export interface ResolvedModel {
  transport: LlmTransport;
  model: string;
  temperature?: number;
  // True when the API key came from the WORKSPACE secret tier — the workspace paid for these tokens, so the
  // conversation's cost is metered against it (own-pays/personal key or dev fallback → false). Mirrors the harness
  // billing rule (docs/architecture/usage-metering.md).
  billed?: boolean;
  // The spec's companion tiers (registered-model refs) — the workspace's own tuning of the agent it powers.
  // chat.ts prefers these over the deployment AGENT_*_MODEL defaults. Absent on the env-fallback model.
  companions?: { small?: string; fallback?: string; subagent?: string };
}

export type ModelResolver = (principal: Principal) => Promise<ResolvedModel>;
// Resolve an explicitly-named registered model (a workspace AgentSpec's model override) for this principal.
export type ModelByIdResolver = (principal: Principal, modelRef: string) => Promise<ResolvedModel>;

// D3 core: resolve (workspace, modelRef) → ModelSpec, read its API key from the workspace/user SecretStore, and build
// the PROVIDER-NATIVE transport for spec.provider (Anthropic Messages / OpenAI). The key never leaves this process;
// it is used exactly like a dispatched job's injected model connection.
async function resolveRegisteredModel(
  modelRegistry: ModelRegistry,
  secretStore: SecretStore,
  principal: Principal,
  modelRef: string,
): Promise<ResolvedModel> {
  const spec = await modelRegistry.get(principal.workspace, modelRef);
  const keyName = modelApiKeySecretName(spec);
  const scoped = await secretStore.scopedEntries(principal.workspace, principal.subject);
  const fromWorkspace = scoped.workspace[keyName];
  const apiKey = fromWorkspace ?? scoped.user[keyName];
  if (apiKey === undefined && spec.baseUrl === undefined) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { keyName, modelRef },
      `The agent model "${modelRef}" has no API key (secret ${keyName}) set and no baseUrl — cannot reach a provider.`,
    );
  }
  const transport = transportFor({
    provider: spec.provider,
    apiKey: apiKey ?? "",
    ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
  });
  return {
    transport,
    model: spec.model,
    ...(spec.params?.temperature !== undefined ? { temperature: spec.params.temperature } : {}),
    billed: fromWorkspace !== undefined, // the workspace secret paid → meter this conversation's cost to the workspace
    ...(spec.companions !== undefined ? { companions: spec.companions } : {}),
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
// Routed through the OpenAI transport with a custom baseUrl — the explicit "openai-compatible" escape hatch (vLLM / a
// LiteLLM proxy), never a provider-native default.
export function envModelResolver(opts: { baseURL?: string; apiKey: string; model: string }): ModelResolver {
  const transport = transportFor({
    provider: "openai-compatible",
    apiKey: opts.apiKey,
    ...(opts.baseURL !== undefined ? { baseUrl: opts.baseURL } : {}),
  });
  return async () => ({ transport, model: opts.model });
}

// ── THE VERIFIER'S EXECUTION PROFILE (arch-review 26 P0) ─────────────────────────────────────────────
//
// PLATFORM MODEL SELECTED IS NOT PLATFORM-OWNED MODEL RESOLVED.
//
// A verification turn stopped honouring the conversation's and the workspace agent's model override, which
// closed the obvious door. It then called the ordinary resolver — and that resolver reads the model registry
// owner-first: `modelRegistry.get(principal.workspace, ref)` answers with the WORKSPACE's document whenever
// one exists under that id, falling back to `_shared` only when it does not.
//
// So an operator pinning AGENT_MODEL=trusted-verifier gets the platform's document only until the workspace
// registers its own `trusted-verifier`. After that the party being verified chooses the provider, the base
// URL, the underlying model and its parameters — everything except the words in the prompt. The verifier's
// authority would be rooted in the namespace of the party it is meant to hold to account.
//
// This resolver reads the PLATFORM namespace and nothing else, pins the exact version, and returns the
// document's digest so the decision can say which instrument produced the verdict. No tenant read, no
// fallback: a deployment whose platform namespace has no verifier model cannot verify, and says so.
export interface VerifierExecutionProfile extends ResolvedModel {
  identity: { modelRef: string; version: string; documentDigest: string };
}

export type VerifierModelResolver = () => Promise<VerifierExecutionProfile>;

export function platformVerifierModelResolver(opts: {
  modelRegistry: ModelRegistry;
  secretStore: SecretStore;
  modelRef: string;
}): VerifierModelResolver {
  return async () => {
    // SHARED_TENANT explicitly, never the caller's workspace — that substitution IS the defect.
    const spec = await opts.modelRegistry.get(SHARED_TENANT, opts.modelRef);
    const keyName = modelApiKeySecretName(spec);
    // …and the credential comes from the platform's own tier for the same reason: a member secret standing in
    // would let the verified party choose which endpoint the verifier talks to.
    const scoped = await opts.secretStore.scopedEntries(SHARED_TENANT, "platform");
    const apiKey = scoped.workspace[keyName];
    if (apiKey === undefined && spec.baseUrl === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { keyName, modelRef: opts.modelRef },
        `The platform verifier model "${opts.modelRef}" has no API key (secret ${keyName}) in the platform namespace and no baseUrl — a verification cannot run under a model this deployment cannot reach.`,
      );
    return {
      transport: transportFor({
        provider: spec.provider,
        apiKey: apiKey ?? "",
        ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
      }),
      model: spec.model,
      ...(spec.params?.temperature !== undefined ? { temperature: spec.params.temperature } : {}),
      billed: false, // the platform runs its own verifier; the workspace is not charged for being audited
      identity: {
        modelRef: opts.modelRef,
        version: spec.version,
        // WHICH BYTES. A version is immutable, so this is redundant for a healthy registry — and it is what
        // makes "which instrument judged this" answerable from the record a year later.
        documentDigest: contentDigest(spec),
      },
    };
  };
}
