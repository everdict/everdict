import { randomUUID } from "node:crypto";
import type { AgentSessionStore } from "@everdict/application-control";
import {
  InMemoryAgentSessionStore,
  PgAgentSessionStore,
  PgSecretStore,
  cipherFromEnv,
  makePool,
  sqlClient,
} from "@everdict/db";
import { PgModelRegistry } from "@everdict/registry";
import { type AgentConfig, loadConfig } from "./config.js";
import { mcpToolProvider } from "./mcp-tools.js";
import { type ModelResolver, envModelResolver, registryModelResolver } from "./model.js";
import { meAuthenticate } from "./principal.js";
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
  if (config.DATABASE_URL !== undefined) {
    const client = sqlClient(makePool(config.DATABASE_URL));
    sessions = new PgAgentSessionStore(client);
    if (config.AGENT_MODEL !== undefined) {
      const cipher = cipherFromEnv();
      if (cipher === undefined) {
        throw new Error("AGENT_MODEL requires EVERDICT_SECRETS_KEY to decrypt the model's API key.");
      }
      resolveModel = registryModelResolver({
        modelRegistry: new PgModelRegistry(client),
        secretStore: new PgSecretStore(client, cipher),
        modelRef: config.AGENT_MODEL,
      });
    } else {
      resolveModel = envModelFallback(config);
    }
  } else {
    sessions = new InMemoryAgentSessionStore();
    resolveModel = envModelFallback(config);
  }

  const app = buildServer({
    authenticate: meAuthenticate(config.CONTROL_PLANE_URL),
    sessions,
    resolveModel,
    toolProvider: mcpToolProvider(config.mcpUrl),
    systemPrompt: EVERDICT_AGENT_SYSTEM_PROMPT,
    now: () => new Date().toISOString(),
    newId: () => randomUUID(),
    ...(config.AGENT_MAX_TURNS !== undefined ? { maxTurns: config.AGENT_MAX_TURNS } : {}),
  });

  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  console.error(`▶ everdict-agent listening on :${config.PORT} (control plane ${config.CONTROL_PLANE_URL})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
