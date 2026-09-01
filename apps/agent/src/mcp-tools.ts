import {
  type McpInvoke,
  type SkillEntry,
  TOOL_SEARCH_TOOL_NAME,
  type ToolDefinition,
  ToolRegistry,
  buildSkillTools,
  buildToolSearchTool,
  mcpToolToDefinition,
  withResourceTargets,
} from "@everdict/agent-runtime";
import type { EffectContract } from "@everdict/contracts";
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

// Pure READS whose names do not match a prefix. The convention is a verb prefix and these are the places the
// control plane named a tool after its SUBJECT instead — so the list is the exception log, not a policy.
//
// Each entry is a tool whose handler gates `…:read` and declares `readOnlyHint`. Getting one wrong in the
// permissive direction is the real cost, so the test beside this asserts the membership rather than trusting
// the name.
const NAMED_READS = new Set<string>([
  // Knowledge graph: a node's ranked relationships, a multi-hop neighbourhood, a node's authored notes — so the
  // agent can consult the workspace's knowledge before analyzing or contributing. (get_knowledge_node /
  // get_knowledge_graph already match `get_`.)
  "knowledge_related",
  "knowledge_subgraph",
  "knowledge_notes",
  // The evolution campaign's two reads. `campaign_decision` asks the frozen frame whether to continue, adopt
  // or halt, and `campaign_adoption` reads back what a close authorized — both gate `scorecards:read`, neither
  // touches anything. Missing here they were classified as MUTATIONS, so an agent walking a campaign had to
  // ask permission in order to ask whether it should keep walking, once per round. The loop is the one place
  // where a read gated like a write turns a procedure into an interrogation.
  "campaign_decision",
  "campaign_adoption",
]);

function isReadOnlyToolName(name: string): boolean {
  return READ_PREFIXES.some((p) => name.startsWith(p)) || NAMED_READS.has(name);
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

// The server's own declaration OUTRANKS the name (F7): every base tool's handler gates on an Action string
// ("x:read" / "x:write"), and registration surfaces it as annotations.readOnlyHint — the same fact the server
// enforces, now carried on the wire. The name classifier stays as the FALLBACK for tools registered without
// an annotation, which is all it ever deserved to be: the MINTING_READS blacklist above is the standing proof
// that a name is not a semantic authority.
export function baseToolReadOnly(tool: { name: string; annotations?: { readOnlyHint?: boolean } }): boolean {
  return tool.annotations?.readOnlyHint ?? isBaseToolReadOnly(tool.name);
}

// A resolved MCP tool server the agent connects to (from the workspace's AgentSpec / an adopted capability), with its
// secrets already resolved. Two transports: `http` = a remote Streamable-HTTP endpoint (authSecret → verbatim
// Authorization header); `stdio` = a container image the agent runs (`docker run --rm -i <image> [args]`) with the
// bound secrets as env. write=true → all of its tools are bridged (mutating allowed); else read-only subset.
// `effects` is the adopted capability's declared effect contract, carried so every tool this server exposes
// reaches the permission gate with the author's own statement of blast radius instead of just a name.
export type ResolvedMcpServer =
  | { kind: "http"; name: string; url: string; authorization?: string; write: boolean; effects?: EffectContract }
  | {
      kind: "stdio";
      name: string;
      image: string;
      args: string[];
      env: Record<string, string>;
      write: boolean;
      effects?: EffectContract;
    };

// Whether ANY of an external server's tools may be auto-retried after a transport death. A read-only-
// bridged server: yes (its exposed set is our read-name filter). A write-enabled server: NEVER — a retry
// re-issues a call whose first outcome is unknown, the per-tool semantics are a third party's, and the
// pre-fix name-prefix classification trusted the untrusted surface with the weaker signal (a third-party
// `get_or_create_*` double-fires). Per-tool retry returns only with locally-trusted adopted-capability
// metadata; until then the model gets an explicit error and decides.
export function externalServerCanRetry(server: Pick<ResolvedMcpServer, "write">): boolean {
  return !server.write;
}

// The effect contract a bridged tool carries to the permission gate. The author's own declaration always
// wins; without one, a REMOTE transport is structurally external — every call ships its model-chosen
// arguments to an outside endpoint, so an UNDECLARED remote read-only server is exfiltration-shaped by
// construction (effectsRequireConsent reason ④: reading the workspace and reaching an outside network are
// the two halves) and must not run as a plain safe read just because nobody wrote a declaration. The
// synthesized contract states ONLY the structural fact (the egress). A stdio server runs locally (nothing
// synthesized), and an undeclared write-capable server is already permit-gated by isReadOnly — demanding
// its declaration is the registration guard's job.
export function bridgedEffectsFor(
  server: Pick<ResolvedMcpServer, "kind" | "write" | "effects">,
): EffectContract | undefined {
  if (server.effects) return server.effects;
  if (server.kind === "http" && !server.write) {
    return { sideEffect: "none", dataAccess: { egress: "external" } };
  }
  return undefined;
}

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
  // The tools this process can ATTEST are pure reads — the kernel's `ExecutionMode.shadow.executableReads`, which is
  // the only set a shadow run will actually invoke. Membership is a statement about PROVENANCE, not about a name or
  // about a flag on the wire: the control plane's own catalog (its handlers gate on our Action strings, and it tells
  // us which are reads), plus the tools this file builds itself out of data already in memory. A workspace-registered
  // MCP server is NEVER in it — its read-only classification is a third party's claim about a third party's code, and
  // `get_or_create_ticket` is what that claim is worth.
  attestedReads: ReadonlySet<string>;
  // Direct read-tool invocation for @-reference resolution (get_*) — always the BASE everdict client (its read tools
  // resolve workspace entities); null when no base MCP session is available.
  call: McpInvoke | null;
  // WHY the platform surface is missing, when it is. A base-MCP failure degrades the turn (the agent answers from
  // its own knowledge) — but degrading SILENTLY is what turned a one-line deployment fault into an unexplainable
  // agent: the credential the control plane's MCP door requires was absent, every tool vanished, and the only
  // evidence anywhere was one warn line on the CONTROL PLANE. Nothing on this side, nothing in the transcript, and
  // an agent that looks like it simply chose not to use its tools. So the reason travels: into this field, into the
  // agent's log, and into the turn's environment block so the model can SAY it instead of improvising an answer.
  platformToolsError?: string;
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

const EMPTY_SESSION: ToolSession = {
  registry: new ToolRegistry([]),
  call: null,
  attestedReads: new Set<string>(),
  close: async () => {},
};

// The mutable client slot a resilient invoke reconnects through. `current` is what calls go to; `refresh` shares
// one in-flight reconnect across concurrently-failing calls (no reconnect storm). close() must close `current`,
// not the client that happened to exist at connect time.
export interface McpClientBox {
  current: Client;
  refresh?: Promise<Client>;
}

function toToolResult(r: Awaited<ReturnType<Client["callTool"]>>): Awaited<ReturnType<McpInvoke>> {
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
}

// One MCP call → ToolResult, RECONNECTING through a dead session (ResilientMcpSession's fix, reinterpreted for the
// chat path: it lived only in the self-hosted runner while a mid-turn control-plane restart made every remaining
// tool call of the turn fail). A tool-level failure comes back as an isError RESULT (no reconnect); a THROW is a
// transport/session death → discard the session, connect fresh (shared in-flight, so concurrent failures don't
// stampede), and then:
//   · a READ call is retried once on the fresh session — reads are safe to re-issue;
//   · a MUTATING call is NOT auto-retried (the first attempt may have reached the server — a silent double-fire
//     is worse than an error): the healed session serves the FOLLOWING calls, and the model gets an error result
//     telling it the call's outcome is unknown so it can verify/re-issue deliberately.
// An MCP result is a content-block array — join the text blocks and carry image blocks through as base64.
// Exported for direct unit testing of the reconnect semantics.
export function makeInvoke(
  box: McpClientBox,
  connect: () => Promise<Client>,
  canRetry: (bareToolName: string) => boolean,
  prefix?: string,
): McpInvoke {
  const reconnect = (): Promise<Client> => {
    if (!box.refresh) {
      box.refresh = (async () => {
        await box.current.close().catch(() => {});
        const fresh = await connect();
        box.current = fresh;
        return fresh;
      })().finally(() => {
        box.refresh = undefined;
      });
    }
    return box.refresh;
  };
  return async (name, args) => {
    // A namespaced workspace tool is exposed to the model as `mcp__<server>__<tool>`; strip the prefix before calling
    // the server, which only knows the bare tool name.
    const toolName = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
    try {
      return toToolResult(await box.current.callTool({ name: toolName, arguments: args }));
    } catch (err) {
      const fresh = await reconnect(); // throws when the server is really gone → invokeTool turns it into an error result
      if (canRetry(toolName)) {
        return toToolResult(await fresh.callTool({ name: toolName, arguments: args }));
      }
      const detail = err instanceof Error ? err.message : String(err);
      return {
        content: `The tool server connection dropped while "${toolName}" was in flight (${detail}). The session was re-established, but the call was NOT retried automatically because it may mutate state and its outcome is unknown. Verify the current state with a read tool and re-issue the call if appropriate.`,
        isError: true,
      };
    }
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
    const boxes: McpClientBox[] = [];
    const bridged: ToolDefinition[] = [];
    // Filled ONLY where this file can vouch for the tool (see ToolSession.attestedReads).
    const attestedReads = new Set<string>();
    let baseCall: McpInvoke | null = null;
    let platformToolsError: string | undefined;

    // 1. Base everdict MCP — the whole catalog minus the runner protocol tools, forwarding the caller's bearer
    // (dogfooding the control plane's own tools). Mutations are bridged isReadOnly:false so each call is decided by
    // the session's permission mode (see action-policy.ts).
    const connectBase = async (): Promise<Client> => {
      const c = new Client({ name: "everdict-agent", version: "0.1.0" });
      await c.connect(
        new StreamableHTTPClientTransport(baseUrl, { requestInit: { headers: forwardHeaderRecord(headers) } }),
      );
      return c;
    };
    const baseClient = new Client({ name: "everdict-agent", version: "0.1.0" });
    try {
      const transport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: { headers: forwardHeaderRecord(headers) },
      });
      await baseClient.connect(transport);
      const baseTools = (await baseClient.listTools()).tools.filter((t) => isDefaultBaseTool(t.name));
      if (baseTools.length > 0) {
        const baseBox: McpClientBox = { current: baseClient };
        boxes.push(baseBox);
        // Auto-retry after a reconnect only for pure reads — a mutating call's first attempt may have landed.
        // Retry safety follows the DECLARED access when the server stated one (annotations.readOnlyHint),
        // the name fallback otherwise — the same order the per-tool isReadOnly below uses.
        const hints = new Map(
          baseTools.map((t) => [t.name, (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint]),
        );
        const invoke = makeInvoke(baseBox, connectBase, (tool) => hints.get(tool) ?? isBaseToolReadOnly(tool));
        baseCall = invoke;
        const baseDefs: ToolDefinition[] = [];
        for (const t of baseTools) {
          const readOnly = baseToolReadOnly({
            name: t.name,
            annotations: t.annotations as { readOnlyHint?: boolean } | undefined,
          });
          // A read of OUR control plane, gated by OUR handler on an Action we defined — attestable.
          if (readOnly) attestedReads.add(t.name);
          baseDefs.push(
            mcpToolToDefinition(
              {
                name: t.name,
                ...(t.description !== undefined ? { description: t.description } : {}),
                inputSchema: t.inputSchema as Record<string, unknown> | undefined,
              },
              invoke,
              { isReadOnly: readOnly },
            ),
          );
        }
        // Declare WHICH OBJECT each evidence reader addresses (arch-review 11 P0). Only the CONTROL-PLANE
        // surface gets this: these are our own tools with argument shapes we define, so stating their
        // resource semantics is a statement we are entitled to make. An external workspace server's tools
        // stay undeclared on purpose — an object-scoped envelope refuses them, which is the honest answer to
        // "can we promise this call touches nothing outside the evidence?" for someone else's tool.
        bridged.push(...withResourceTargets(baseDefs));
      } else {
        // Connected, and the catalog came back EMPTY. Not the same failure as an unreachable door, and worth saying
        // so: it means the surface answered with nothing this principal may call.
        platformToolsError = `the control plane at ${baseUrl.href} listed no usable tools`;
        await baseClient.close().catch(() => {});
      }
    } catch (err) {
      // Degrade rather than fail: the agent answers from its own knowledge when the platform tools are unreachable.
      // But NAME the reason — see ToolSession.platformToolsError. The STATUS is stated separately because the SDK's
      // message does not carry it (`Error POSTing to endpoint: <body>`), and it is the one fact that tells an
      // operator which fault this is: 401 = the door wants a credential nobody forwarded, 404 = wrong URL,
      // 5xx = the control plane itself. `StreamableHTTPError.code` holds it; a transport-level failure has none.
      const status = (err as { code?: unknown }).code;
      platformToolsError = `could not reach the control plane's MCP at ${baseUrl.href}${
        typeof status === "number" ? ` (HTTP ${status})` : ""
      }: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`▶ everdict-agent: platform tools unavailable — ${platformToolsError}`);
      await baseClient.close().catch(() => {});
    }

    // 2. Each workspace-registered MCP server — its OWN authorization; read-only unless registered write-allowed. Its
    // tools are NAMESPACED `mcp__<server>__<tool>` so multiple servers (and the built-in tools) can't collide, and the
    // model can see which server a tool belongs to. The invoke strips the prefix before calling the server.
    for (const server of extraServers) {
      // Containerized stdio servers spawn a `docker run` process — only when the operator has opted in AND (if an
      // allowlist is set) the image is on it; else skip (degrade).
      if (server.kind === "stdio" && (!allowStdio || !imageAllowed(server.image, allowedImages))) continue;
      const connectServer = async (): Promise<Client> => {
        const c = new Client({ name: "everdict-agent", version: "0.1.0" });
        const t =
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
        await c.connect(t);
        return c;
      };
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
        const box: McpClientBox = { current: client };
        // A read-only-bridged server may auto-retry everything it exposes (its tool set is OUR read-name
        // filter). A write-allowed server gets NO automatic retry at all: a retry re-issues a call whose
        // first outcome is unknown, its per-tool semantics are a third party's, and classifying them by
        // NAME trusted the untrusted surface with the weaker signal — a `get_or_create_*` or `get_credit`
        // double-fires. Per-tool retry for external servers returns only with locally-trusted adopted-
        // capability metadata (named deferral); until then the model gets an explicit error and decides.
        const invoke = makeInvoke(box, connectServer, () => externalServerCanRetry(server), prefix);
        const toAdd: ToolDefinition[] = [];
        const effects = bridgedEffectsFor(server);
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
              { isReadOnly: !server.write, ...(effects ? { effects } : {}) },
            ),
          );
        }
        if (toAdd.length === 0) {
          await client.close().catch(() => {});
          continue;
        }
        boxes.push(box);
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
    // A toolless turn is the case that USED to be indistinguishable from a well-behaved agent choosing not to call
    // anything — so the empty session carries the reason too.
    if (bridged.length === 0 && skillTools.length === 0 && codeDefs.length === 0)
      return platformToolsError !== undefined ? { ...EMPTY_SESSION, platformToolsError } : EMPTY_SESSION;

    const tools: ToolDefinition[] = [];
    if (bridged.length > 0) tools.push(buildToolSearchTool(new ToolRegistry(bridged)), ...bridged);
    tools.push(...codeDefs); // native code tools — always loaded (not deferred behind ToolSearch)
    tools.push(...skillTools);
    // ToolSearch and the skill tools are built HERE, out of data already in this process (the registry it was handed,
    // the skill bodies passed in) — they reach nothing and change nothing, so they are attestable in the same sense the
    // control plane's reads are. Without ToolSearch a shadow try cannot even see the deferred catalog it is meant to
    // reason over. The code tools (`code__*`) are deliberately absent: running someone's code is the effect.
    attestedReads.add(TOOL_SEARCH_TOOL_NAME);
    for (const t of skillTools) if (t.isReadOnly === true) attestedReads.add(t.name);
    const registry = new ToolRegistry(tools);
    return {
      registry,
      call: baseCall,
      attestedReads,
      ...(platformToolsError !== undefined ? { platformToolsError } : {}),
      close: async () => {
        // Close through the boxes — a reconnect may have swapped the live client since connect time.
        for (const b of boxes) await b.current.close().catch(() => {});
      },
    };
  };
}
