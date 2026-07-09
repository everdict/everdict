import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

export function registerSettingsTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.settingsStore) {
    const settings = deps.settingsStore;
    server.registerTool(
      "get_workspace_settings",
      { description: "This workspace's settings (metering policy, etc.). Empty object if unset.", inputSchema: {} },
      () => run(principal, "settings:read", async () => ok((await settings.get(ws)) ?? {})),
    );
    server.registerTool(
      "set_workspace_settings",
      {
        description:
          "Partially update (merge) workspace settings. meterUsage: turn usage metering for this workspace's runs on/off. judge: the workspace default model that scores inline judge graders (HTTP parity).",
        inputSchema: {
          meterUsage: z
            .boolean()
            .optional()
            .describe("default for usage metering (per-request override takes precedence)"),
          judge: z
            .object({ provider: z.enum(["openai", "anthropic"]).optional(), model: z.string() })
            .optional()
            .describe("workspace default judge model for inline judge graders (per-request override wins)"),
        },
      },
      ({ meterUsage, judge }) =>
        run(principal, "settings:write", async () =>
          ok(
            await settings.set(ws, {
              ...(meterUsage === undefined ? {} : { meterUsage }),
              ...(judge ? { judge } : {}),
            }),
          ),
        ),
    );
  }
}
