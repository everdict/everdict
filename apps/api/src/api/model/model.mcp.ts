import { deleteModelVersion, deleteModelVersions } from "@everdict/application-control";
import { ModelSpecSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";

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
          await models.register(ws, result.data, principal.subject); // creator = subject (delete permission)
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );

    server.registerTool(
      "delete_model",
      {
        description:
          "Soft-delete one model (version) (tombstone — disappears from list/get but the data is preserved, keeping past scorecards that referenced it reproducible). version is required — deletes exactly one version (do not lump it under 'latest'). Confirm in order: which workspace (fixed by credential) → which id → which version. Permission: only that version's 'creator' or a 'workspace admin' (else FORBIDDEN). Missing / already-deleted / _shared / other-workspace versions are NOT_FOUND.",
        inputSchema: {
          id: z.string().describe("model id"),
          version: z
            .string()
            .describe("exact version to delete (required; latest not allowed — deletes exactly one version)"),
        },
      },
      ({ id, version }) => plain(async () => ok(await deleteModelVersion(models, principal, id, version))),
    );

    server.registerTool(
      "delete_model_versions",
      {
        description:
          "Bulk soft-delete (tombstone) — several selected versions, or the WHOLE model when versions is omitted (deletes every one of this workspace's own live versions). Convenience over delete_model for cleaning up many versions at once. Fail-fast: every target is checked ('creator' or 'workspace admin') before anything is deleted, so one forbidden/absent version rejects the whole call (FORBIDDEN/NOT_FOUND) with nothing removed. Confirm in order: which workspace (fixed by credential) → which id → which versions (or all). An unknown / already-fully-deleted model is NOT_FOUND. Data is preserved so past scorecards stay reproducible.",
        inputSchema: {
          id: z.string().describe("model id"),
          versions: z
            .array(z.string())
            .min(1)
            .optional()
            .describe("exact versions to delete; omit to delete the whole model (all own live versions)"),
        },
      },
      ({ id, versions }) => plain(async () => ok(await deleteModelVersions(models, principal, id, versions))),
    );
  }
}
