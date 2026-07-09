import { API_KEY_SCOPES } from "@everdict/auth";
import { issueKey } from "@everdict/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, plain } from "../mcp-context.js";

export function registerApiKeyTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  if (deps.keyStore) {
    const keys = deps.keyStore;
    // Personal API keys — self-scoped (no role gate). Each user views/issues/revokes only their own (subject) keys. A key acts with the issuer's privileges.
    server.registerTool(
      "list_api_keys",
      { description: "My API keys (metadata only — no plaintext/hash, identified by prefix)", inputSchema: {} },
      () => plain(async () => ok(await keys.list(ws, principal.subject))),
    );
    server.registerTool(
      "create_api_key",
      {
        description:
          "Issue a new personal API key — acts with the issuer's (my) privileges. scopes can narrow it further (read|write|admin, never exceeding your role). If unset, keeps my role. The plaintext (ak_…) is shown once in the response and can't be read again.",
        inputSchema: {
          label: z.string().max(80).optional().describe("identifying label (optional)"),
          scopes: z
            .array(z.enum(API_KEY_SCOPES))
            .nonempty()
            .optional()
            .describe("permission scope (read|write|admin). unset = keep my role"),
        },
      },
      ({ label, scopes }) =>
        plain(async () => ok({ apiKey: await issueKey(keys, ws, label, scopes ?? ["admin"], principal.subject) })),
    );
    server.registerTool(
      "revoke_api_key",
      {
        description: "Revoke my API key (effective immediately). id is the id from list_api_keys.",
        inputSchema: { id: z.string() },
      },
      ({ id }) =>
        plain(async () => {
          await keys.revoke(ws, id, principal.subject); // only my keys — others' keys / machine keys are a no-op
          return ok({ workspace: ws, id, revoked: true });
        }),
    );
  }
}
