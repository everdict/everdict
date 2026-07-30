import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Connect to a remote MCP server (Streamable HTTP) and enumerate its tools — the "test connection" behind the
// capability wizard's mcp step AND behind Settings › Agent › Tools' "what functions does this tool have". Like every
// probe (mattermost / trace-source / runtime) a FAILURE is a RESULT, not a thrown error: the caller renders
// reachability + reason + the discovered tools.
//
// Two ways to authenticate, matching the two callers: `token` is a transient bearer the AUTHOR pastes for the test
// only (wrapped as `Bearer <token>`, never stored — the adopter binds the real secret at adoption), while
// `authorization` is a VERBATIM header value resolved from an already-bound secret, exactly as the agent runtime
// sends it. Neither is logged.

export interface McpProbeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpProbeAuth {
  token?: string;
  authorization?: string;
}

export interface McpProbeResult {
  reachable: boolean;
  detail: string;
  reason?: "auth" | "unreachable" | "protocol"; // present when reachable=false — shapes the UI hint
  tools: McpProbeTool[]; // the server's tool names (+ descriptions) — [] on failure
}

export async function probeMcpServer(url: string, auth: McpProbeAuth = {}): Promise<McpProbeResult> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { reachable: false, detail: "Not a valid URL.", reason: "unreachable", tools: [] };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:")
    return { reachable: false, detail: "URL must be http(s).", reason: "unreachable", tools: [] };

  // A bound secret travels verbatim (it already carries its own scheme, e.g. "Bearer …"/"Basic …"); a pasted test
  // token is a bare credential, so it gets the Bearer wrapper.
  const header = auth.authorization ?? (auth.token ? `Bearer ${auth.token}` : undefined);
  const client = new Client({ name: "everdict-api", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    target,
    header ? { requestInit: { headers: { Authorization: header } } } : {},
  );
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}),
    }));
    return {
      reachable: true,
      detail: `Connected — ${tools.length} tool${tools.length === 1 ? "" : "s"} available.`,
      tools,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const reason: McpProbeResult["reason"] = /401|403|unauth|forbidden/i.test(msg)
      ? "auth"
      : /econn|fetch|network|timeout|refused|enotfound|getaddr|socket/i.test(msg)
        ? "unreachable"
        : "protocol";
    return { reachable: false, detail: msg.slice(0, 300), reason, tools: [] };
  } finally {
    await client.close().catch(() => {});
  }
}
