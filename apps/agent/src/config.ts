import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8790),
  // The control plane base URL — used for GET /me (identity) and, by default, the MCP endpoint.
  CONTROL_PLANE_URL: z.string().url(),
  EVERDICT_MCP_URL: z.string().url().optional(),
  // Shared Postgres (sessions + secrets + model registry). Unset → in-memory sessions + the env LLM fallback.
  DATABASE_URL: z.string().optional(),
  // The registered workspace model the agent runs on (D3). Falls back to AGENT_LLM_* when unset / no DB.
  AGENT_MODEL: z.string().optional(),
  // Optional model tiering (needs a registered model + DB + secrets, like AGENT_MODEL). AGENT_SMALL_MODEL digests
  // compaction summaries on a cheaper/faster model instead of the main one (resolved lazily — only when compaction
  // fires). AGENT_FALLBACK_MODEL takes over for the rest of a run if the main model keeps failing transiently.
  AGENT_SMALL_MODEL: z.string().optional(),
  AGENT_FALLBACK_MODEL: z.string().optional(),
  // A (typically cheaper) registered model for spawn_agent sub-agents — delegated research rarely needs the main model.
  AGENT_SUBAGENT_MODEL: z.string().optional(),
  // Per-tool wall-clock deadline (ms); a tool that outruns it is aborted and returned as an error. Unset → no deadline.
  AGENT_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Extended-thinking budget (tokens). Set → the agent asks the model to reason before answering (Anthropic `thinking`;
  // OpenAI-side reasoning models reason regardless). Reasoning is captured + streamed to the chat either way. Unset →
  // thinking off (no extra cost). Anthropic requires this to exceed 1024 and be below max_tokens; the transport bumps
  // max_tokens to fit.
  AGENT_THINKING_BUDGET: z.coerce.number().int().positive().optional(),
  // The registered agent-config id resolved per workspace (instructions + MCP tool servers + model override). A
  // workspace registers an agent under this id ("default") to customize its assistant; unset id → base agent.
  AGENT_CONFIG_ID: z.string().default("default"),
  AGENT_LLM_BASE_URL: z.string().url().optional(),
  AGENT_LLM_API_KEY: z.string().optional(),
  AGENT_LLM_MODEL: z.string().optional(),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().optional(),
});

export interface AgentConfig extends z.infer<typeof ConfigSchema> {
  mcpUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = ConfigSchema.parse(env);
  const mcpUrl = parsed.EVERDICT_MCP_URL ?? `${parsed.CONTROL_PLANE_URL.replace(/\/$/, "")}/mcp`;
  return { ...parsed, mcpUrl };
}
