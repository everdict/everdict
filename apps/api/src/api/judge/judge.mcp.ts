import { setVersionTags } from "@everdict/application-control";
import { JudgeSpecSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";

// Judge MCP tools — the MCP twin of judge.routes.ts.
export function registerJudgeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.judgeRegistry) {
    const judges = deps.judgeRegistry;
    server.registerTool(
      "list_judges",
      { description: "Agent Judges visible to this workspace (owned + _shared default judges)", inputSchema: {} },
      () => run(principal, "judges:read", async () => ok(await judges.list(ws))),
    );

    server.registerTool(
      "get_judge",
      {
        description: "A full JudgeSpec (model | harness). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) => run(principal, "judges:read", async () => ok(await judges.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "set_judge_version_tags",
      {
        description:
          "Replace all tags on a judge version (empty array = remove all) — free-form labels to tell versions apart (mutable metadata outside the spec, independent of immutability). Gate: judges:write. _shared / other-workspace versions get NOT_FOUND.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("exact version (latest not allowed)"),
          tags: z.array(z.string()).describe("all tags for this version (≤60 chars each, ≤20 per version; replaces)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => ok(await setVersionTags(judges, principal, "judges:write", id, version, tags))),
    );

    server.registerTool(
      "validate_judge",
      {
        description:
          "Dry-run validate a JudgeSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { judge: z.string().describe("JudgeSpec JSON (kind: model | harness)") },
      },
      ({ judge }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await judges.ownVersions(ws, result.data.id);
          return ok({
            ok: true,
            kind: result.data.kind,
            id: result.data.id,
            version: result.data.version,
            existingVersions,
            versionExists: existingVersions.includes(result.data.version),
          });
        }),
    );

    server.registerTool(
      "create_judge",
      {
        description:
          "Register a JudgeSpec (JSON string) as owned by this workspace (model/harness; immutable; CONFLICT on collision)",
        inputSchema: { judge: z.string().describe("JudgeSpec JSON") },
      },
      ({ judge }) =>
        run(principal, "judges:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(judge);
          } catch {
            return fail("BAD_REQUEST: not a valid JudgeSpec JSON.");
          }
          const result = JudgeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await judges.register(ws, result.data, principal.subject); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }
}
