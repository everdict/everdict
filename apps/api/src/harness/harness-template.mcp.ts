import { HarnessTemplateSpecSchema } from "@everdict/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, fail, ok, run } from "../mcp-context.js";

// Harness-template MCP tools — the MCP twin of harness-template.routes.ts.
export function registerHarnessTemplateTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Harness category (template: structure/slots). No gate (viewer+) — collaborative content.
  if (deps.harnessTemplates) {
    const templates = deps.harnessTemplates;
    server.registerTool(
      "list_harness_templates",
      { description: "Harness templates this workspace sees (categories; owned + _shared)", inputSchema: {} },
      () => run(principal, "harnesses:read", async () => ok(await templates.list(ws))),
    );

    server.registerTool(
      "get_harness_template",
      {
        description:
          "Fetch one harness template (category) structure spec — for config view / new-version edit prefill",
        inputSchema: { id: z.string(), version: z.string().describe('template version or "latest"') },
      },
      ({ id, version }) => run(principal, "harnesses:read", async () => ok(await templates.get(ws, id, version))),
    );

    server.registerTool(
      "register_harness_template",
      {
        description:
          "Register a harness template (category structure, JSON string) (immutable; CONFLICT on clash). No gate (viewer+)",
        inputSchema: { spec: z.string().describe("HarnessTemplateSpec JSON") },
      },
      ({ spec }) =>
        run(principal, "templates:write", async () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(spec);
          } catch {
            return fail("BAD_REQUEST: not a valid HarnessTemplateSpec JSON.");
          }
          const result = HarnessTemplateSpecSchema.safeParse(parsed);
          if (!result.success) return fail(`BAD_REQUEST: ${result.error.message}`);
          await templates.register(ws, result.data, principal.subject); // creator stamp — HTTP parity
          return ok({ workspace: ws, id: result.data.id, version: result.data.version });
        }),
    );
  }
}
