import { ModelSpecSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Model MCP tools — the MCP twin of model.routes.ts.
export function registerModelTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.modelRegistry) {
    const models = deps.modelRegistry;
    server.registerTool(
      "list_models",
      { description: "Models visible to this workspace (inference/judge models: owned + _shared)", inputSchema: {} },
      () => run(principal, "models:read", async () => ok(await models.list(ws))),
    );

    server.registerTool(
      "get_model",
      {
        description:
          "A full ModelSpec (provider + underlying model + baseUrl). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "models:read", async () => ok(await models.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_model",
      {
        description:
          "Dry-run validate a ModelSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { model: z.string().describe("ModelSpec JSON") },
      },
      ({ model }) =>
        run(principal, "models:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(model);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = ModelSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await models.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            provider: result.data.provider,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_model",
      {
        description:
          "Register a ModelSpec (JSON string) as owned by this workspace (provider + underlying model + baseUrl; immutable; CONFLICT on collision)",
        inputSchema: { model: z.string().describe("ModelSpec JSON") },
      },
      ({ model }) =>
        run(principal, "models:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(model);
          } catch {
            return fail("BAD_REQUEST: not a valid ModelSpec JSON.");
          }
          const result = ModelSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await models.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }
}
