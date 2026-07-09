import { RubricSpecSchema } from "@everdict/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Rubric MCP tools — the MCP twin of rubric.routes.ts.
// AuthZ reuses the judge actions (rubrics are the judging domain — no new action, mirroring how views reuse
// scorecards:*): read = judges:read, write = judges:write.
export function registerRubricTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.rubricRegistry) {
    const rubrics = deps.rubricRegistry;
    server.registerTool(
      "list_rubrics",
      { description: "Rubrics visible to this workspace (owned + _shared default rubrics)", inputSchema: {} },
      () => run(principal, "judges:read", async () => ok(await rubrics.list(ws))),
    );

    server.registerTool(
      "get_rubric",
      {
        description:
          "A full RubricSpec (text and/or criteria + optional prompt template). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) =>
        run(principal, "judges:read", async () => ok(await rubrics.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "validate_rubric",
      {
        description:
          "Dry-run validate a RubricSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { rubric: z.string().describe("RubricSpec JSON (text and/or criteria/promptTemplate)") },
      },
      ({ rubric }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rubric);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = RubricSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await rubrics.ownVersions(ws, result.data.id);
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
      "create_rubric",
      {
        description:
          "Register a RubricSpec (JSON string) as owned by this workspace (referenced by judges as rubric:{id,version}; immutable; CONFLICT on collision)",
        inputSchema: { rubric: z.string().describe("RubricSpec JSON") },
      },
      ({ rubric }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rubric);
          } catch {
            return fail("BAD_REQUEST: not a valid RubricSpec JSON.");
          }
          const result = RubricSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await rubrics.register(ws, result.data, principal.subject); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }
}
