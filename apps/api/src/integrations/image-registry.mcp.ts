import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// Image-registry MCP tools — the MCP twin of image-registry.routes.ts.
export function registerImageRegistryTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Workspace image registries (BYO, multiple) — the harness-image classification baseline + target for everdict image push issuance.
  // Register several by name and select one on push. Read harnesses:read / register·remove settings:write / push credentials images:push (member+).
  if (deps.imageRegistryService) {
    const registry = deps.imageRegistryService;
    server.registerTool(
      "list_workspace_image_registries",
      {
        description:
          "This workspace's image registries — [{name,host,namespace?,username?,secret-name reference,imagePrefix}] (not secret values). Classification/pull auth matches by host across all of them.",
        inputSchema: {},
      },
      () => run(principal, "harnesses:read", async () => ok({ registries: await registry.list(ws) })),
    );
    server.registerTool(
      "set_workspace_image_registry",
      {
        description:
          "Register/update an image registry (admin, upsert by name — declarative full replace). Put the pull/push token (value) in the SecretStore first and pass its name. Warns via missingSecrets if a referenced secret is absent.",
        inputSchema: {
          name: z.string().min(1).describe("registry name (reference key — push selection points at this name)"),
          host: z.string().min(1).describe('registry host[:port] — "ghcr.io" · "registry.acme.dev:5000"'),
          namespace: z.string().min(1).optional().describe('path prefix under host — "acme" → ghcr.io/acme/<name>'),
          username: z.string().min(1).optional().describe("docker login username (omit for token-only registries)"),
          pullSecretName: z.string().min(1).optional().describe("SecretStore key name holding the pull token/password"),
          pushSecretName: z.string().min(1).optional().describe("SecretStore key name holding the push token/password"),
        },
      },
      (input) => run(principal, "settings:write", async () => ok(await registry.upsert(ws, input))),
    );
    server.registerTool(
      "remove_workspace_image_registry",
      {
        description: "Remove an image registry (admin, by name). Afterward its images are classified as external.",
        inputSchema: { name: z.string().min(1).describe("name of the registry to remove") },
      },
      ({ name }) =>
        run(principal, "settings:write", async () => {
          await registry.remove(ws, name);
          return ok({ ok: true });
        }),
    );
    server.registerTool(
      "get_image_push_credentials",
      {
        description:
          "Mint push credentials for a workspace registry (member+) — {name,host,namespace?,username?,password,imagePrefix}. Choose via registry (omittable if there's only one). Discard after docker tag+login+push (non-persistent).",
        inputSchema: {
          registry: z.string().min(1).optional().describe("registry name (omittable if there's only one)"),
        },
      },
      ({ registry: name }) =>
        run(principal, "images:push", async () => ok({ credentials: await registry.pushCredentials(ws, name) })),
    );
  }
}
