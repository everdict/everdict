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
