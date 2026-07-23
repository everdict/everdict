import { deleteAgentVersion, deleteAgentVersions } from "@everdict/application-control";
import { AgentSpecSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";
import { SaveAgentBodySchema } from "./request/save-agent.js";

// Agent MCP tools — the MCP twin of agent.routes.ts (the workspace's conversational-agent configuration).
export function registerAgentTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.agentRegistry) {
    const agents = deps.agentRegistry;
    server.registerTool(
      "list_agents",
      {
        description:
          "Agent configurations visible to this workspace (instructions + MCP servers + model; owned + _shared)",
        inputSchema: {},
      },
      () => run(principal, "agents:read", async () => ok(await agents.list(ws))),
    );

    server.registerTool(
      "get_agent",
      {
        description:
          "A full AgentSpec (instructions + MCP tool servers + model). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "agents:read", async () => ok(await agents.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_agent",
      {
        description:
          "Dry-run validate an AgentSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { agent: z.string().describe("AgentSpec JSON") },
      },
      ({ agent }) =>
        run(principal, "agents:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(agent);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = AgentSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await agents.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_agent",
      {
        description:
          "Register an AgentSpec (JSON string) as owned by this workspace (instructions + MCP tool servers + model; immutable; CONFLICT on collision)",
        inputSchema: { agent: z.string().describe("AgentSpec JSON") },
      },
      ({ agent }) =>
        run(principal, "agents:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(agent);
          } catch {
            return fail("BAD_REQUEST: not a valid AgentSpec JSON.");
          }
          const result = AgentSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await agents.register(ws, result.data, principal.subject); // creator = subject (delete permission)
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );

    server.registerTool(
      "delete_agent",
      {
        description:
          "Soft-delete one agent (version) (tombstone — disappears from list/get but the data is preserved). version is required — deletes exactly one version. Permission: only that version's 'creator' or a 'workspace admin' (else FORBIDDEN). Missing / already-deleted / _shared / other-workspace versions are NOT_FOUND.",
        inputSchema: {
          id: z.string().describe("agent id"),
          version: z.string().describe("exact version to delete (required; latest not allowed)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteAgentVersion(agents, principal, id, version))),
    );

    server.registerTool(
      "delete_agent_versions",
      {
        description:
          "Bulk soft-delete (tombstone) — several selected versions, or the WHOLE agent when versions is omitted (deletes every one of this workspace's own live versions). Fail-fast: every target is checked ('creator' or 'workspace admin') before anything is deleted. An unknown / already-fully-deleted agent is NOT_FOUND.",
        inputSchema: {
          id: z.string().describe("agent id"),
          versions: z
            .array(z.string())
            .min(1)
            .optional()
            .describe("exact versions to delete; omit to delete the whole agent (all own live versions)"),
        },
      },
      ({ id, versions }) => plain(async () => ok(await deleteAgentVersions(agents, principal, id, versions))),
    );
  }

  if (deps.agentService) {
    const agentService = deps.agentService;
    server.registerTool(
      "save_agent",
      {
        description:
          "Save (upsert) a workspace agent configuration by id (the interactive edit path). A new id registers version 1.0.0; a changed spec auto patch-bumps to a NEW immutable version; an unchanged spec is an idempotent no-op (created:false). The version is assigned server-side, so `agent` JSON carries no id/version (instructions? + mcpServers? + model? + description? + tags?). Requires agents:write. create_agent remains the explicit-version programmatic path.",
        inputSchema: {
          id: z.string().describe("agent id (the config's stable identity)"),
          agent: z.string().describe("AgentSpec JSON minus id/version"),
        },
      },
      ({ id, agent }) =>
        run(principal, "agents:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(agent);
          } catch {
            return fail("BAD_REQUEST: not a valid agent JSON.");
          }
          const result = SaveAgentBodySchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await agentService.saveAgent(ws, principal.subject, id, result.data));
        }),
    );
  }
}
