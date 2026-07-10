import { setVersionTags } from "@everdict/application-control";
import { RuntimeSpecSchema } from "@everdict/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain, run } from "../mcp-context.js";

// Runtime MCP tools — the MCP twin of runtime.routes.ts.
export function registerRuntimeTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.runtimeRegistry) {
    const runtimes = deps.runtimeRegistry;
    server.registerTool(
      "list_runtimes",
      { description: "Execution infra visible to this workspace (Runtime: owned + _shared)", inputSchema: {} },
      () => run(principal, "runtimes:read", async () => ok(await runtimes.list(ws))),
    );

    server.registerTool(
      "get_runtime",
      {
        description:
          "A full RuntimeSpec (local | nomad | k8s). version defaults to latest. Other workspaces get NOT_FOUND",
        inputSchema: { id: z.string(), version: z.string().optional() },
      },
      ({ id, version }) =>
        run(principal, "runtimes:read", async () => ok(await runtimes.get(ws, id, version ?? "latest"))),
    );

    server.registerTool(
      "set_runtime_version_tags",
      {
        description:
          "Replace all tags on a runtime version (empty array = remove all) — free-form labels to tell versions apart (mutable metadata outside the spec, independent of immutability). Gate: runtimes:write. _shared / other-workspace versions get NOT_FOUND.",
        inputSchema: {
          id: z.string(),
          version: z.string().describe("exact version (latest not allowed)"),
          tags: z.array(z.string()).describe("all tags for this version (≤60 chars each, ≤20 per version; replaces)"),
        },
      },
      ({ id, version, tags }) =>
        plain(async () => ok(await setVersionTags(runtimes, principal, "runtimes:write", id, version, tags))),
    );

    server.registerTool(
      "validate_runtime",
      {
        description:
          "Dry-run validate a RuntimeSpec (JSON) — schema + this workspace's existing versions/conflict (does not register)",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON (kind: local | nomad | k8s)") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return ok({ ok: false, errors: ["(root): not valid JSON."] });
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success)
            return ok({
              ok: false,
              errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
            });
          const existingVersions = await runtimes.ownVersions(ws, result.data.id);
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
      "create_runtime",
      {
        description:
          "Register a RuntimeSpec (JSON string) as owned by this workspace (immutable; CONFLICT on collision). Credentials live in the SecretStore",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return fail("BAD_REQUEST: not a valid RuntimeSpec JSON.");
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await runtimes.register(ws, result.data);
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }

  if (deps.probeRuntime) {
    const probeRuntime = deps.probeRuntime;
    server.registerTool(
      "probe_runtime",
      {
        description:
          "Connection test for a RuntimeSpec (JSON) — attaches to the real cluster with no job to check reachability/auth (excludes local). {kind,reachable,detail}",
        inputSchema: { runtime: z.string().describe("RuntimeSpec JSON (kind: local | nomad | k8s)") },
      },
      ({ runtime }) =>
        run(principal, "runtimes:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(runtime);
          } catch {
            return fail("BAD_REQUEST: not a valid RuntimeSpec JSON.");
          }
          const result = RuntimeSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          return ok(await probeRuntime(ws, result.data));
        }),
    );
  }
}
