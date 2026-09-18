import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok } from "../mcp-context.js";

// The MCP half of `GET /deployment` (DEFAUL-54). Registered for every session, with no service behind it and
// no authz gate: the session is WHO needs this, and a caller deciding whether to trust a contract must not
// need a credential to find out.
export function registerMetaTools(server: McpServer): void {
  const raw = process.env.EVERDICT_BUILD_COMMIT?.trim();
  const commit = raw !== undefined && raw !== "" ? raw : null;
  const startedAt = new Date().toISOString();

  server.registerTool(
    "get_deployment",
    {
      annotations: { readOnlyHint: true },
      description:
        "What THIS control plane is built from — the commit of the image serving you, and when the process " +
        "started. ⚠️ RUN IT BEFORE YOU TRUST ANY TOOL'S SCHEMA when you have a checkout in front of you. " +
        "⚠️ COMPARE IT THE RIGHT WAY: the dangerous case is a deployment BEHIND you, and a commit behind yours " +
        'is an ANCESTOR of your HEAD — so "is this a commit I have?" answers *yes* for exactly the case that ' +
        "bites. The test is `git merge-base --is-ancestor <commit> HEAD` succeeding while `<commit>` is not " +
        "HEAD: that is BEHIND, and it means a defect you just fixed can still be live and a tool you expect " +
        "may be absent from this catalogue — say the deployment is behind rather than re-opening the finding. " +
        "Not an ancestor at all = a different line than your checkout. `commit: null` = the image carries no " +
        "stamp, which is neither agreement nor staleness: 'I do not know what I am built from'.",
      inputSchema: {},
    },
    async () => ok({ commit, startedAt }),
  );
}
