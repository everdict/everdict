import type { EffectContract } from "@everdict/contracts";
import type { ZodTypeAny } from "zod";

export interface ToolContext {
  abortSignal?: AbortSignal;
  selectedModel?: string;
}

// An image a tool returned (a base64 payload + its MIME type) — e.g. a browser screenshot or a rendered DOM. The loop
// feeds these to the model as image content so it can actually SEE them (multimodal tool results).
export interface ToolResultImage {
  data: string; // base64 (no data: prefix)
  mediaType: string; // e.g. "image/png"
}

// A tool result: string content fed back as a `tool` message (+ an error flag so the loop records success/failure
// without inspecting the text), plus any images the loop surfaces to the model in a follow-up multimodal user turn.
export interface ToolResult {
  content: string;
  isError: boolean;
  images?: ToolResultImage[];
}

// Permission gate for a (write) tool call. Read-only tools auto-allow; a non-read-only tool consults the host's hook
// (allow/deny) — the low-level seam a HITL approval flow plugs into. "ask" is expressed by the host resolving the
// promise only after a human decides, then returning allow/deny.
export type PermissionDecision = "allow" | "deny";
export interface PermissionRequest {
  name: string;
  isReadOnly: boolean;
  input: unknown;
  // What the capability behind this tool DECLARED about its effects (blast radius, idempotency, rollback,
  // data access). Carried so the host's gate can classify risk from the declaration instead of guessing from
  // the tool's name — a capability that told us its blast radius should not be graded on its spelling.
  // Absent for tools with no capability behind them (the kernel's own, the built-in control-plane surface).
  effects?: EffectContract;
}
export type PermissionHook = (req: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

export interface ToolDefinition {
  name: string;
  description: string;
  // The declared effect contract of the capability this tool came from (@everdict/contracts). Provenance
  // travels WITH the tool rather than being looked up again at call time — the loop hands it to the
  // permission gate, which is the only consumer that needed it.
  effects?: EffectContract;
  // JSON Schema object handed verbatim to the OpenAI `tools[]` function.parameters.
  parametersJsonSchema: Record<string, unknown>;
  // Optional runtime validation of the parsed arguments before `call` (native tools use it; MCP-bridged tools
  // rely on the server's own validation).
  inputSchema?: ZodTypeAny;
  isReadOnly?: boolean;
  isDestructive?: boolean;
  // A KERNEL cognition tool (todo list, plan, sub-agent spawn, result paging, wait): part of how the agent
  // thinks, not a workspace capability — exempt from the envelope's reads/writes scope
  // (authorizeToolInvocation), still refusable via `forbidden`. Set only by the loop on the tools it adds.
  intrinsic?: boolean;
  // ToolSearch progressive disclosure (Claude Code parity): a deferred tool is held out of the outbound tools[]
  // until the model discovers it via ToolSearch, keeping the per-call surface bounded across many MCP tools.
  isMcp?: boolean;
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  // One-line capability phrase used by ToolSearch keyword scoring; falls back to `description`.
  searchHint?: string;
  call: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
