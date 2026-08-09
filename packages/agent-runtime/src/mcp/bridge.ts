import type { EffectContract } from "@everdict/contracts";
import type { ToolDefinition, ToolResult } from "../tools/definition.js";

// A tool spec as returned by an MCP server's tools/list (name + description + JSON-schema input).
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// The host owns the MCP transport/session; the kernel only needs a way to call a tool by name. This keeps the
// runtime free of any MCP SDK dependency (apps/agent injects a ResilientMcpSession-backed invoke).
export type McpInvoke = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

function asArgs(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

// Cap a bridged description — an OpenAPI-generated MCP server can dump tens of KB of endpoint docs per tool, which
// would swamp the prompt. (Claude Code caps at the same size.)
const MAX_DESCRIPTION_CHARS = 2048;

// Bridge one MCP tool spec into a runtime ToolDefinition. Marked isMcp → deferred by default (ToolSearch-gated).
// isReadOnly defaults to true (the built-in control-plane surface is read-only); a host bridging a write-allowed
// workspace server passes { isReadOnly: false } so the tool is honestly marked as mutating.
export function mcpToolToDefinition(
  spec: McpToolSpec,
  invoke: McpInvoke,
  // `effects` is the declared effect contract of the CAPABILITY this server came from, when there is one.
  // Every tool a server exposes inherits it: the contract is a property of the adopted thing, and the server
  // is what the workspace consented to. Absent for the built-in control-plane surface (ours, not declared).
  opts?: { isReadOnly?: boolean; effects?: EffectContract },
): ToolDefinition {
  const params = spec.inputSchema ?? { type: "object", properties: {} };
  return {
    name: spec.name,
    description: (spec.description ?? spec.name).slice(0, MAX_DESCRIPTION_CHARS),
    parametersJsonSchema: params,
    isMcp: true,
    isReadOnly: opts?.isReadOnly ?? true,
    ...(opts?.effects ? { effects: opts.effects } : {}),
    call: (input) => invoke(spec.name, asArgs(input)),
  };
}

export function bridgeMcpTools(specs: McpToolSpec[], invoke: McpInvoke): ToolDefinition[] {
  return specs.map((s) => mcpToolToDefinition(s, invoke));
}

// WHICH OBJECT each evidence-reader tool addresses, DECLARED (arch-review 11 P0). An object-scoped envelope —
// today only a verifier's — refuses any tool that has not stated this, so the table is what makes such an
// envelope usable at all rather than a task that can call nothing.
//
// Declared, never inferred from the tool's spelling. `get_run` reading `{id}` as a run is obvious to a human
// and is exactly the kind of "grade the capability on its name" the effect contract exists to avoid: a
// server that later renames or re-shapes a tool would silently change what the guard checks. A table is a
// statement someone made; a heuristic is one nobody did.
//
// Deliberately small. It covers the evidence kinds a checkpoint can cite (CheckpointRef: run, scorecard,
// file, issue, trace) and nothing else — every other tool stays refused under an object scope, which is the
// correct posture for a role whose whole definition is "the evidence and nothing else".
const ID_ARG = (input: unknown): string | undefined => {
  if (input === null || typeof input !== "object") return undefined;
  const id = (input as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
};
const byId =
  (type: string) =>
  (input: unknown): Array<{ type: string; id: string }> => {
    const id = ID_ARG(input);
    return id === undefined ? [] : [{ type, id }];
  };
const byPath = (input: unknown): Array<{ type: string; id: string }> => {
  if (input === null || typeof input !== "object") return [];
  const path = (input as Record<string, unknown>).path;
  return typeof path === "string" && path.length > 0 ? [{ type: "file", id: path }] : [];
};

export const EVIDENCE_RESOURCE_TARGETS: Readonly<
  Record<string, (input: unknown) => Array<{ type: string; id: string }>>
> = {
  get_run: byId("run"),
  get_scorecard: byId("scorecard"),
  get_issue: byId("issue"),
  get_trace: byId("trace"),
  get_file: byPath,
};

// Attach the declared extractors to a bridged tool set. Applied by the host that knows its own tool
// vocabulary — the same reasoning `verifierTools` is injectable for: tool names are a deployment's, not the
// kernel's. A tool with no declaration is left as it is and stays refused under an object scope.
export function withResourceTargets(
  tools: ToolDefinition[],
  targets: Readonly<
    Record<string, (input: unknown) => Array<{ type: string; id: string }>>
  > = EVIDENCE_RESOURCE_TARGETS,
): ToolDefinition[] {
  return tools.map((t) => {
    const extractor = targets[t.name];
    return extractor === undefined ? t : { ...t, resourceTargets: extractor };
  });
}
