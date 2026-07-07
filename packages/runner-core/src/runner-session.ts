import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The result of a single MCP tool call the runner makes (text + whether it errored). ResilientMcpSession absorbs transport/session errors.
export interface ToolResult {
  text: string;
  isError: boolean;
}

// One connected MCP client session. The unit ResilientMcpSession discards and recreates when a session dies (tests inject a fake).
export interface RunnerClient {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

// A factory that creates and connects (=initialize) a new session. Throws on failure (the caller backs off).
export type ConnectClient = () => Promise<RunnerClient>;

// The real implementation — a new Client + StreamableHTTP transport that connects to /mcp with the rnr_ token.
// connect() sends initialize and is issued a new mcp-session-id → a fresh session on each reconnect.
export function mcpConnect(mcpUrl: URL, token: string): ConnectClient {
  return async () => {
    const client = new Client({ name: "everdict-runner", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return {
      async callTool(name, args) {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
        return { text, isError: r.isError === true };
      },
      async close() {
        await client.close().catch(() => {});
      },
    };
  };
}

// The runner MCP session — auto-reinitializes the session so an API restart / transient disconnect doesn't wedge it.
//
// Problem: the control plane holds stateful MCP sessions in an in-memory Map (server.ts), so when the API restarts the
// mcp-session-id the runner holds disappears. A tool call sent to that dead session fails with 400 (stale session)/404/connection-refused,
// but the old runner just retried forever on the same transport and never recovered (wedge — only repeating lease-failure logs).
//
// Fix: when callTool throws (= transport/session error), discard the dead session, reconnect with a new Client+transport (rerun
// initialize → new session id), and retry that one call once. App-level errors return as an isError result rather than a throw,
// so they don't trigger a reconnect. Generalize all tool calls (lease/submit/heartbeat/fail) into this one place — a single API
// restart doesn't wedge the runner. If the retry also fails, throw (the caller = poll loop backs off and reconnects again on the next call).
export class ResilientMcpSession {
  private current: RunnerClient | null = null;
  private connecting: Promise<RunnerClient> | null = null;

  constructor(private readonly connect: ConnectClient) {}

  // Ensure the current session (connect once if absent). Concurrent calls share the same in-flight connect → prevents a reconnect storm.
  private async ensure(): Promise<RunnerClient> {
    if (this.current) return this.current;
    if (!this.connecting) {
      this.connecting = this.connect().then(
        (c) => {
          this.current = c;
          this.connecting = null;
          return c;
        },
        (e) => {
          this.connecting = null;
          throw e;
        },
      );
    }
    return this.connecting;
  }

  // Attempt the initial connection ahead of time (for the banner). Throws on failure — the caller just logs a warning and retries in the poll loop.
  async ensureConnected(): Promise<void> {
    await this.ensure();
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.ensure();
    try {
      return await client.callTool(name, args);
    } catch {
      // Transport/session error — discard the dead session, reinitialize, and retry once.
      await this.reset();
      const fresh = await this.ensure();
      try {
        return await fresh.callTool(name, args);
      } catch (retryErr) {
        await this.reset(); // the retry also failed → discard the session (the next call reconnects fresh)
        throw retryErr;
      }
    }
  }

  private async reset(): Promise<void> {
    const c = this.current;
    this.current = null;
    if (c) await c.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
