import { randomUUID } from "node:crypto";
import type { AgentSessionStore } from "@everdict/application-control";
import {
  InMemoryAgentSessionStore,
  PgAgentSessionStore,
  PgCapabilityStore,
  PgSecretStore,
  PgSkillStore,
  cipherFromEnv,
  makePool,
  sqlClient,
} from "@everdict/db";
import { LocalDriver } from "@everdict/drivers";
import { PgAgentRegistry, PgModelRegistry } from "@everdict/registry";
import type { CodeToolRuntime } from "./code-tools.js";
import { type AgentConfig, loadConfig } from "./config.js";
import { mcpToolProvider } from "./mcp-tools.js";
import {
  type ModelByIdResolver,
  type ModelResolver,
  envModelResolver,
  registryModelByIdResolver,
  registryModelResolver,
} from "./model.js";
import { meAuthenticate } from "./principal.js";
import { type ProfileResolver, baseProfileResolver, registryProfileResolver } from "./profile.js";
import { buildServer } from "./server.js";
import { EVERDICT_AGENT_SYSTEM_PROMPT } from "./system-prompt.js";

function envModelFallback(config: AgentConfig): ModelResolver {
  if (config.AGENT_LLM_API_KEY === undefined || config.AGENT_LLM_MODEL === undefined) {
    throw new Error(
      "No agent model configured: set AGENT_MODEL (with DATABASE_URL + EVERDICT_SECRETS_KEY) or AGENT_LLM_API_KEY + AGENT_LLM_MODEL.",
    );
  }
  return envModelResolver({
    apiKey: config.AGENT_LLM_API_KEY,
    model: config.AGENT_LLM_MODEL,
    ...(config.AGENT_LLM_BASE_URL !== undefined ? { baseURL: config.AGENT_LLM_BASE_URL } : {}),
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  let sessions: AgentSessionStore;
  let resolveModel: ModelResolver;
  // Per-workspace agent customization (Phase 1). resolveProfile is always set (base fallback when no DB / no key);
  // resolveModelById is only available with a DB + secrets key (needed to resolve an AgentSpec.model override's key).
  let resolveProfile: ProfileResolver = baseProfileResolver(EVERDICT_AGENT_SYSTEM_PROMPT);
  let resolveModelById: ModelByIdResolver | undefined;
  if (config.DATABASE_URL !== undefined) {
    const client = sqlClient(makePool(config.DATABASE_URL));
    sessions = new PgAgentSessionStore(client);
    const cipher = cipherFromEnv();
    if (cipher !== undefined) {
      // With the KEK we can decrypt the workspace's model + MCP-server secrets → full per-workspace customization.
      const secretStore = new PgSecretStore(client, cipher);
      const modelRegistry = new PgModelRegistry(client);
      const agentRegistry = new PgAgentRegistry(client);
      resolveModel =
        config.AGENT_MODEL !== undefined
          ? registryModelResolver({ modelRegistry, secretStore, modelRef: config.AGENT_MODEL })
          : envModelFallback(config);
      resolveModelById = registryModelByIdResolver({ modelRegistry, secretStore });
      resolveProfile = registryProfileResolver({
        agentRegistry,
        secretStore,
        skillStore: new PgSkillStore(client),
        capabilityStore: new PgCapabilityStore(client),
        baseSystemPrompt: EVERDICT_AGENT_SYSTEM_PROMPT,
        configId: config.AGENT_CONFIG_ID,
      });
    } else {
      // No KEK: sessions persist, but a registered model / secret-backed customization can't be decrypted → env model + base agent.
      if (config.AGENT_MODEL !== undefined) {
        throw new Error("AGENT_MODEL requires EVERDICT_SECRETS_KEY to decrypt the model's API key.");
      }
      resolveModel = envModelFallback(config);
    }
  } else {
    sessions = new InMemoryAgentSessionStore();
    resolveModel = envModelFallback(config);
  }

  // Code capabilities (type:'code') run in a provisioned compute. The default agent uses a LocalDriver (host
  // subprocess — dev / self-hosted, matching "LocalDriver = inside the agent"); it is NOT isolated, so own-workspace
  // code runs while adopted-from-others code is skipped (the buildCodeTools sandbox gate). A managed deployment
  // injects an isolated driver (DockerDriver) to run adopted code safely.
  const localDriver = new LocalDriver();
  const codeRuntime: CodeToolRuntime = { provision: (spec) => localDriver.provision(spec), isolated: false };

  const app = buildServer({
    authenticate: meAuthenticate(config.CONTROL_PLANE_URL),
    sessions,
    resolveModel,
    resolveProfile,
    ...(resolveModelById ? { resolveModelById } : {}),
    toolProvider: mcpToolProvider(config.mcpUrl, codeRuntime),
    systemPrompt: EVERDICT_AGENT_SYSTEM_PROMPT,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    ...(config.AGENT_MAX_TURNS !== undefined ? { maxTurns: config.AGENT_MAX_TURNS } : {}),
    // Model tiering — only effective with resolveModelById (DB + secrets); otherwise ignored (single env model).
    ...(config.AGENT_SMALL_MODEL !== undefined ? { smallModelRef: config.AGENT_SMALL_MODEL } : {}),
    ...(config.AGENT_FALLBACK_MODEL !== undefined ? { fallbackModelRef: config.AGENT_FALLBACK_MODEL } : {}),
    ...(config.AGENT_SUBAGENT_MODEL !== undefined ? { subagentModelRef: config.AGENT_SUBAGENT_MODEL } : {}),
    ...(config.AGENT_TOOL_TIMEOUT_MS !== undefined ? { toolTimeoutMs: config.AGENT_TOOL_TIMEOUT_MS } : {}),
    ...(config.AGENT_THINKING_BUDGET !== undefined ? { thinkingBudgetTokens: config.AGENT_THINKING_BUDGET } : {}),
  });

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.error(`▶ everdict-agent listening on :${config.PORT} (control plane ${config.CONTROL_PLANE_URL})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
