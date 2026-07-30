import {
  type McpInvoke,
  type SkillEntry,
  type ToolDefinition,
  ToolRegistry,
  buildSkillTools,
  buildToolSearchTool,
  mcpToolToDefinition,
} from "@everdict/agent-runtime";
import { mcpBridgePrefix } from "@everdict/domain";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isProtocolTool } from "./action-policy.js";
import { type CodeToolRuntime, type ResolvedCodeTool, buildCodeTools } from "./code-tools.js";
import { type ForwardHeaders, forwardHeaderRecord } from "./principal.js";

// Read-verb classification — decides which bridged tools SKIP the permission gate, not which are bridged (the whole
// base surface is; see isDefaultBaseTool). A workspace MCP server registered without write remains read-only-bridged.
const READ_PREFIXES = ["get_", "list_", "inspect_", "diff_", "estimate_", "leaderboard_", "search_", "hf_", "preview_"];

// Knowledge-graph READ tools whose names don't match the read prefixes but are pure reads (a node's ranked
// relationships, a multi-hop neighbourhood, a node's authored notes). Bridged read-only, exactly like a read verb — so
// the agent can consult the workspace's knowledge before analyzing or contributing. (get_knowledge_node /
// get_knowledge_graph already match `get_`.)
const KNOWLEDGE_READS = new Set<string>(["knowledge_related", "knowledge_subgraph", "knowledge_notes"]);

function isReadOnlyToolName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p)) || KNOWLEDGE_READS.has(name);
}

// Read-prefixed tools that actually MINT credentials — they must not skip the permission gate despite the get_ verb.
const MINTING_READS = new Set<string>(["get_image_push_credentials"]);

// The base (built-in everdict) surface is the WHOLE control-plane catalog — every entity's reads AND mutations — so
// the agent can directly perform any action the member could (create datasets, run/cancel scorecards, register
// harnesses, configure integrations, delete entities, …). Only the runner wire-protocol tools are excluded (machine
// protocol, never member actions). Safety is layered, not surface-shaped: the control-plane RBAC bounds every call to
// the member's own role, and every mutation goes through the permission gate under the session's permission mode
// (default=ask · auto=ask only guarded actions · bypass=never ask · plan=read-only until approved) — see
// action-policy.ts + server.ts. Supersedes the default-deny allowlist + the AGENT_ALLOW_EVAL_DRIVE opt-in.
export function isDefaultBaseTool(name: string): boolean {
  return !isProtocolTool(name);
}

// A base tool is read-only (skips the permission gate) only when it is a pure read verb and not a minting read — so
// get_image_push_credentials (matches get_ but mints credentials) still asks. Everything else is isReadOnly:false and
// therefore decided by the session's permission mode.
export function isBaseToolReadOnly(name: string): boolean {
  return isReadOnlyToolName(name) && !MINTING_READS.has(name);
}

// A resolved MCP tool server the agent connects to (from the workspace's AgentSpec / an adopted capability), with its
// secrets already resolved. Two transports: `http` = a remote Streamable-HTTP endpoint (authSecret → verbatim
// Authorization header); `stdio` = a container image the agent runs (`docker run --rm -i <image> [args]`) with the
// bound secrets as env. write=true → all of its tools are bridged (mutating allowed); else read-only subset.
export type ResolvedMcpServer =
  | { kind: "http"; name: string; url: string; authorization?: string; write: boolean }
  | { kind: "stdio"; name: string; image: string; args: string[]; env: Record<string, string>; write: boolean };

// `docker run --rm -i --init [--env NAME …] <image> [args]`. `--init` runs a tiny init as PID 1 so servers that spawn
// children (e.g. Playwright → chromium) don't leak zombies over the session. Secrets pass through with `--env NAME`
// (no `=value` on argv, so the values never appear in `ps`/logs) — their VALUES ride in the spawned docker process's
// env (stdioEnv below).
export function dockerRunArgs(server: { image: string; args: string[]; env: Record<string, string> }): string[] {
  const envFlags = Object.keys(server.env).flatMap((name) => ["--env", name]);
  return ["run", "--rm", "-i", "--init", ...envFlags, server.image, ...server.args];
}

// The env for the spawned `docker` process: the bound secrets (referenced by `--env NAME`) + a minimal PATH/HOME so
// the docker CLI itself resolves and runs. Nothing else from the agent's own environment is forwarded (no accidental
// leak of the agent's own secrets into the docker invocation). Forwarding HOME also means a PRIVATE image pulls with
// the operator's host `docker login` (`$HOME/.docker/config.json` / credential helpers on PATH) — no per-workspace
// registry plumbing needed for the operator-managed case. The bound secrets reach the CONTAINER via `--env NAME`
// (dockerRunArgs); HOME/PATH stay on the docker CLI, never passed into the container.
export function stdioEnv(secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...secrets };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

// Operator image allowlist (AGENT_MCP_STDIO_ALLOWED_IMAGES) — defense-in-depth beyond the allowStdio flag: when the
// operator pins a set of permitted images, a stdio server whose image isn't on it is refused. An empty allowlist means
// "no restriction" (any image runs, still gated by allowStdio). Matching: exact (with/without tag/digest) OR a
// `repo/`-style trailing-slash prefix. e.g. "grafana/" allows any grafana image; "crystaldba/postgres-mcp" is exact.
export function imageAllowed(image: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return true;
  const bare = image.split("@")[0] ?? image; // strip @digest
  const repo = bare.split(":")[0] ?? bare; // strip :tag
  return allow.some((a) => (a.endsWith("/") ? bare.startsWith(a) : a === image || a === bare || a === repo));
}

export interface ToolSession {
  registry: ToolRegistry;
  // Direct read-tool invocation for @-reference resolution (get_*) — always the BASE everdict client (its read tools
  // resolve workspace entities); null when no base MCP session is available.
  call: McpInvoke | null;
  close: () => Promise<void>;
}

// Given the caller's forward headers (and the workspace's extra MCP servers + skills), produce the tool registry for
// one chat turn: connect to the control plane's MCP as that principal + each workspace server, bridge the allowed
// tools (deferred), add ToolSearch, and add the native `use_skill` tool for the workspace's skills.
export type ToolProvider = (
  headers: ForwardHeaders,
  extraServers?: ResolvedMcpServer[],
  skills?: SkillEntry[],
  codeTools?: ResolvedCodeTool[],
) => Promise<ToolSession>;

const EMPTY_SESSION: ToolSession = { registry: new ToolRegistry([]), call: null, close: async () => {} };

// One MCP call → ToolResult, bound to a specific client. An MCP result is a content-block array — join the text blocks
// and carry any image blocks through as base64 (the kernel surfaces them to the model as multimodal content).
function makeInvoke(client: Client, prefix?: string): McpInvoke {
  return async (name, args) => {
    // A namespaced workspace tool is exposed to the model as `mcp__<server>__<tool>`; strip the prefix before calling
    // the server, which only knows the bare tool name.
    const toolName = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const r = await client.callTool({ name: toolName, arguments: args });
    const blocks =
      (r.content as Array<{ type?: string; text?: string; data?: string; mimeType?: string }> | undefined) ?? [];
    const text = blocks
      .filter((b) => typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    const images = blocks
      .filter((b) => b.type === "image" && typeof b.data === "string")
      .map((b) => ({ data: b.data as string, mediaType: b.mimeType ?? "image/png" }));
    return { content: text, isError: r.isError === true, ...(images.length > 0 ? { images } : {}) };
  };
}

// opts.allowStdio — the operator opt-in (AGENT_MCP_ALLOW_STDIO) that permits containerized stdio MCP servers to spawn
// (`docker run`). Default false → stdio servers are skipped (degrade), so process-spawning is off unless enabled.
// opts.allowedImages — an optional operator allowlist (AGENT_MCP_STDIO_ALLOWED_IMAGES); empty = any image.
export function mcpToolProvider(
  mcpUrl: string,
  codeRuntime?: CodeToolRuntime,
  opts: { allowStdio?: boolean; allowedImages?: readonly string[] } = {},
): ToolProvider {
  const baseUrl = new URL(mcpUrl);
  const allowStdio = opts.allowStdio ?? false;
  const allowedImages = opts.allowedImages ?? [];
  return async (headers, extraServers = [], skills = [], codeTools = []) => {
    const clients: Client[] = [];
    const bridged: ToolDefinition[] = [];
    let baseCall: McpInvoke | null = null;

    // 1. Base everdict MCP — the whole catalog minus the runner protocol tools, forwarding the caller's bearer
    // (dogfooding the control plane's own tools). Mutations are bridged isReadOnly:false so each call is decided by
    // the session's permission mode (see action-policy.ts).
    const baseClient = new Client({ name: "everdict-agent", version: "0.1.0" });
    try {
      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers: forwardHeaderRecord(headers) },
      });
      await baseClient.connect(transport);
      const baseTools = (await baseClient.listTools()).tools.filter((t) => isDefaultBaseTool(t.name));
      if (baseTools.length > 0) {
        clients.push(baseClient);
        const invoke = makeInvoke(baseClient);
        baseCall = invoke;
        for (const t of baseTools) {
          bridged.push(
            mcpToolToDefinition(
              {
                name: t.name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
              { isReadOnly: isBaseToolReadOnly(t.name) },
            ),
          );
        }
      } else {
        await baseClient.close().catch(() => {});
      }
    } catch {
      // Degrade rather than fail: the agent answers from its own knowledge when the platform tools are unreachable.
      await baseClient.close().catch(() => {});
    }

    // 2. Each workspace-registered MCP server — its OWN authorization; read-only unless registered write-allowed. Its
    // tools are NAMESPACED `mcp__<server>__<tool>` so multiple servers (and the built-in tools) can't collide, and the
    // model can see which server a tool belongs to. The invoke strips the prefix before calling the server.
    for (const server of extraServers) {
      // Containerized stdio servers spawn a `docker run` process — only when the operator has opted in AND (if an
      // allowlist is set) the image is on it; else skip (degrade).
      if (server.kind === "stdio" && (!allowStdio || !imageAllowed(server.image, allowedImages))) continue;
      const client = new Client({ name: "everdict-agent", version: "0.1.0" });
      try {
        const transport =
          server.kind === "stdio"
            ? new StdioClientTransport({
                command: "docker",
                args: dockerRunArgs(server),
                env: stdioEnv(server.env),
                stderr: "pipe",
              })
            : new StreamableHTTPClientTransport(new URL(server.url), {
                requestInit: { headers: server.authorization ? { authorization: server.authorization } : {} },
              });
        await client.connect(transport);
        const prefix = mcpBridgePrefix(server.name);
        const listed = (await client.listTools()).tools;
        const allowed = server.write ? listed : listed.filter((t) => isReadOnlyToolName(t.name));
        const invoke = makeInvoke(client, prefix);
        const toAdd: ToolDefinition[] = [];
        for (const t of allowed) {
          const name = `${prefix}${t.name}`;
          if (bridged.some((b) => b.name === name) || toAdd.some((b) => b.name === name)) continue;
          toAdd.push(
            mcpToolToDefinition(
              {
                name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
              { isReadOnly: !server.write },
            ),
          );
        }
        if (toAdd.length === 0) {
          await client.close().catch(() => {});
          continue;
        }
        clients.push(client);
        bridged.push(...toAdd);
      } catch {
        await client.close().catch(() => {}); // an unreachable workspace server is skipped, not fatal
      }
    }

    // Deterministic tool order (name-sorted) so ToolSearch results + the outbound tools[] are stable across runs.
    bridged.sort((a, b) => a.name.localeCompare(b.name));

    // The native skill tools (use_skill + read_skill_file — progressive disclosure over the workspace's skills) are
    // added even when no MCP tools are reachable — a workspace can rely on skills alone.
    const skillTools = buildSkillTools(skills);
    // Adopted code capabilities → native `code__<name>` tools. buildCodeTools drops any adopted-from-others code the
    // runtime can't safely (isolatedly) run — never execute untrusted code on the host.
    const { defs: codeDefs } = buildCodeTools(codeTools, codeRuntime);
    if (bridged.length === 0 && skillTools.length === 0 && codeDefs.length === 0) return EMPTY_SESSION;

    const tools: ToolDefinition[] = [];
    if (bridged.length > 0) tools.push(buildToolSearchTool(new ToolRegistry(bridged)), ...bridged);
    tools.push(...codeDefs); // native code tools — always loaded (not deferred behind ToolSearch)
    tools.push(...skillTools);
    const registry = new ToolRegistry(tools);
    return {
      registry,
      call: baseCall,
      close: async () => {
        for (const c of clients) await c.close().catch(() => {});
      },
    };
  };
}
