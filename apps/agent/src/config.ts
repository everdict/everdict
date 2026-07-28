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
  // The web app's public base URL — lets the agent hand the member real links (entity deep links, the desktop-app
  // download page). Same env name + default as the control plane's web-base sites (invite links, App callbacks).
  WEB_BASE_URL: z.string().url().default("http://localhost:3001"),
  // Direct desktop-app download URL (e.g. a GitHub Release) — offered alongside the in-app download page when set.
  DESKTOP_DOWNLOAD_URL: z.string().url().optional(),
  // Shared secret the control plane presents (x-internal-token) to POST /agent/events for a recipient (S4 — the
  // monitoring→proactive-team bridge). Unset → the internal event path is disabled (only user-authenticated events).
  AGENT_INTERNAL_TOKEN: z.string().optional(),
  // The control plane's x-internal-token (its EVERDICT_INTERNAL_TOKEN) — lets the agent report a conversation's LLM
  // usage to POST {CONTROL_PLANE_URL}/internal/usage so agent cost lands in the SAME meter + budget as evals. Unset →
  // usage reporting is off (the agent still runs; workspace-billed conversation cost just isn't metered).
  CONTROL_PLANE_INTERNAL_TOKEN: z.string().optional(),
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
  // Operator-global API key for the built-in `web_search` default tool (Tavily). Set → every workspace's agent gets
  // web search out of the box; unset → a workspace can still enable it with its own secret of the declared name.
  AGENT_WEBSEARCH_API_KEY: z.string().optional(),
  AGENT_LLM_BASE_URL: z.string().url().optional(),
  AGENT_LLM_API_KEY: z.string().optional(),
  AGENT_LLM_MODEL: z.string().optional(),
  AGENT_MAX_TURNS: z.coerce.number().int().positive().optional(),
  // Operator opt-in for containerized stdio MCP servers (Capability Store `mcp` capabilities that declare an `image`).
  // "1"/"true" → the agent may spawn `docker run --rm -i <image>` for an adopted stdio server; anything else (default)
  // → those capabilities are skipped. Requires Docker where the agent runs. Off by default (no process-spawning).
  AGENT_MCP_ALLOW_STDIO: z.string().optional(),
  // Optional operator allowlist for stdio MCP images (space/comma-separated) — defense-in-depth beyond ALLOW_STDIO.
  // e.g. "grafana/mcp-grafana crystaldba/postgres-mcp mcr.microsoft.com/playwright/" — a trailing "/" is a repo prefix.
  // Unset/empty → no restriction (any image, still gated by ALLOW_STDIO).
  AGENT_MCP_STDIO_ALLOWED_IMAGES: z.string().optional(),
});

export interface AgentConfig extends z.infer<typeof ConfigSchema> {
  mcpUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  // Treat empty-string env values as unset. Compose / `.env` pass-through writes "" for every unconfigured optional
  // var (`${AGENT_TOOL_TIMEOUT_MS:-}` → ""), and z.coerce on "" would otherwise fail boot (Number("")→0 fails
  // .positive(); z.enum rejects ""). This mirrors the control plane's truthiness tolerance (`process.env.X ? …`).
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== "") cleaned[key] = value;
  }
  const parsed = ConfigSchema.parse(cleaned);
  const mcpUrl = parsed.EVERDICT_MCP_URL ?? `${parsed.CONTROL_PLANE_URL.replace(/\/$/, "")}/mcp`;
  return { ...parsed, mcpUrl };
}
