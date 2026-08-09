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

// See ToolDefinition.resourceTargets — the three answers a resource extractor can give, kept apart so that
// "nothing to check" and "I could not tell" never share a representation.
export type ResourceTarget = { type: string; id: string };
export type ResourceTargetResult =
  | { kind: "none" }
  | { kind: "targets"; values: ResourceTarget[] }
  | { kind: "indeterminate" };

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
  // WHICH OBJECTS this call would touch, read off its own arguments (arch-review 11 P0). The envelope's
  // `scope.resources` says which objects a task may reach, and `authorizeResourceAccess` decides — but the
  // decision needs a target, and only the tool knows how to find one in its own argument shape.
  //
  // A tool that does not declare this is REFUSED under an object-scoped envelope. That is not an oversight
  // budget: the whole guarantee of an evidence-scoped role is "this and nothing else", and a tool whose
  // resource semantics nobody stated is a tool we cannot say that about. Under an unscoped envelope (no
  // `scope.resources` — every executor task today) it is never consulted, so declaring it is only required
  // where object isolation is actually claimed.
  //
  // The result is a DISCRIMINATED answer, not a possibly-empty array (arch-review 12 P2). `[]` meant two
  // opposite things — "this call addresses no object" and "I could not find the target in these arguments" —
  // and the second silently passed the guard. It is harmless while every wired extractor reads a required
  // argument; it stops being harmless the moment an evidence tool takes an optional id or a wildcard, and
  // that is a fail-OPEN a reader would have to reconstruct from two helpers to notice.
  //   { kind: "none" }              — genuinely targetless (a search, a listing with no anchor). Passes.
  //   { kind: "targets", values }   — check each one.
  //   { kind: "indeterminate" }     — the arguments did not yield a target. REFUSED under an object scope,
  //                                   because a call we cannot describe is a call we cannot promise anything
  //                                   about.
  resourceTargets?: (input: unknown) => ResourceTargetResult;
  call: (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
}
