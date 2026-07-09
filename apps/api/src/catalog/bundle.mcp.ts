import { authorize } from "@everdict/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, plain } from "../mcp-context.js";
import { BundleSchema, requiredActionsForBundle } from "./bundle-service.js";

// Bundle MCP tools — the MCP twin of bundle.routes.ts.
export function registerBundleTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.bundleService) {
    const bundles = deps.bundleService;
    server.registerTool(
      "apply_bundle",
      {
        description:
          "Apply a bundle (JSON) — register harness + benchmark + dataset + runtime + judge/model in one shot (idempotent, partial success). Requires per-type permissions depending on the bundle contents.",
        inputSchema: { bundle: z.string().describe("Bundle JSON") },
      },
      ({ bundle }) =>
        plain(async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bundle);
          } catch {
            return fail("BAD_REQUEST: not a valid Bundle JSON.");
          }
          const result = BundleSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          // per-section authorization (throw→plain catch→fail) — combines existing per-type gates with no new action.
          for (const action of requiredActionsForBundle(result.data)) authorize(principal, action);
          return ok(await bundles.apply(ws, principal.subject, result.data));
        }),
    );
  }
}
