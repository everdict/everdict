import { authorize } from "@everdict/auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BundleSchema, requiredActionsForBundle } from "../../core/bundle/bundle-service.js";
import { type McpToolContext, fail, ok, plain } from "../mcp-context.js";
import { assertDatasetConstitution } from "../route-context.js";

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
          // ── …AND THE CONSTITUTIONAL ACT, WHICH THIS DOOR ALONE DID NOT ASK (pnpm scan, api, 2026-09-11) ──
          //
          // `datasets:write` is a MEMBER action. Declaring `ground_truth` for a metric is not: it defines what
          // passing means for every evaluation that ever runs the dataset, and `assertDatasetConstitution`
          // requires admin for it. Its REST twin nine lines into `bundle.routes.ts` calls this; this door
          // called only the per-section gate, so a plain member could grant that authority through the one
          // surface nobody checked — BFF↔MCP parity is structural (rule `api-layer`) and this was the half
          // that never learned it.
          for (const dataset of result.data.datasets) assertDatasetConstitution(principal, dataset);
          return ok(await bundles.apply(ws, principal.subject, result.data));
        }),
    );
  }
}
