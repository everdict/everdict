import { z } from "zod";
import { CodeToolExampleSchema } from "../../records/capability.js";
import { AgentToolEntrySchema } from "./agent-tool-list.js";

// GET /agent/tools/:key 200 — ONE tool of the caller's own toolset, in full: not just the row the list shows but what
// the tool actually IS (how it is reached, which functions it puts in front of the model, what the model reads as its
// description, which secrets it needs and where they come from). The list is a switch; this is the explanation behind
// the switch — the surface a member uses to decide whether to trust a tool, wire its secret, and test it.

// One callable function the tool contributes to the model's tool list. A `code` capability is exactly ONE function
// (the tool IS the function); an `mcp` server contributes as many as it serves. `bridgedName` is the name the model
// actually calls (`code__<name>` / `mcp__<server>__<tool>`), which is NOT the store name — the runtime namespaces
// them so two servers cannot collide.
export const AgentToolFunctionSchema = z.object({
  name: z.string(),
  bridgedName: z.string().describe("The name the model calls (namespaced by the runtime)"),
  description: z.string().default(""),
  // JSON Schema for the function's arguments, when known. A `code` tool declares it in its spec; for an mcp server it
  // is only known after a live probe, so the declared (unprobed) listing omits it.
  parametersSchema: z.record(z.unknown()).optional(),
  // false ⇒ the call goes through the session's permission gate (the member is asked before it runs).
  readOnly: z.boolean(),
});
export type AgentToolFunction = z.infer<typeof AgentToolFunctionSchema>;

// How the runtime reaches this tool. The three shapes are the three things the agent actually does: open an HTTP MCP
// session, run a container over stdio, or execute a script under the code-tool contract.
export const AgentToolTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), url: z.string() }),
  z.object({ kind: z.literal("stdio"), image: z.string(), args: z.array(z.string()).default([]) }),
  z.object({
    kind: z.literal("code"),
    language: z.enum(["python", "node"]),
    timeoutSec: z.number().optional(),
    image: z.string().optional(),
  }),
]);
export type AgentToolTransport = z.infer<typeof AgentToolTransportSchema>;

// One secret the tool declares, resolved from THIS member's point of view. `name` is the logical name the tool's
// author declared; `boundTo` is the secret name it currently reads (same-name convention unless the adoption mapped
// it); `resolved` says whether the member can actually satisfy it from the workspace/personal tiers.
export const AgentToolSecretSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  boundTo: z.string(),
  resolved: z.boolean(),
});
export type AgentToolSecret = z.infer<typeof AgentToolSecretSchema>;

export const AgentToolDetailResponseSchema = AgentToolEntrySchema.extend({
  // Which channel put this tool on the table — the same three the resolver distinguishes.
  origin: z.enum(["builtin", "capability", "mcpServer"]),
  transport: AgentToolTransportSchema,
  // The functions this tool contributes, as DECLARED (an mcp capability's `provides`, a code tool's own signature).
  // A live `POST /agent/tools/:key/probe` replaces this with what the server actually serves.
  functions: z.array(AgentToolFunctionSchema).default([]),
  secrets: z.array(AgentToolSecretSchema).default([]),
  // code capabilities only: the pinned source, so a member can audit exactly what runs, plus its worked examples
  // (which double as the try-runner's prefilled input).
  code: z.string().optional(),
  parametersSchema: z.record(z.unknown()).optional(),
  examples: z.array(CodeToolExampleSchema).default([]),
  // The store coordinates behind a capability-backed tool (built-in defaults included — they are `_everdict`-owned
  // public capabilities). Absent for a hand-wired MCP server, which has no store identity.
  capability: z.object({ source: z.string(), id: z.string(), version: z.string() }).optional(),
  tags: z.array(z.string()).default([]),
  // Can the caller REBIND this tool's secrets (PUT …/secrets)? True for an adopted capability and a hand-wired MCP
  // server — both keep their binding on the workspace AgentSpec. False for a built-in default and a
  // published-but-unadopted capability: those bind by the declared NAME, so the fix is a secret of that name.
  bindable: z.boolean(),
  // Can the caller take this tool into the chat to edit it and cut a new version? Only a capability this workspace
  // owns — a first-party default and another workspace's publication are read-only here.
  editable: z.boolean(),
  // Is `POST …/probe` meaningful for this tool? Only an HTTP MCP server can be connected to from the control plane
  // (a stdio container is spawned by the agent, and a code tool is verified by running it instead).
  probeable: z.boolean(),
});
export type AgentToolDetailResponse = z.infer<typeof AgentToolDetailResponseSchema>;

// POST /agent/tools/:key/probe 200 — a live connect to an HTTP MCP tool with the member's OWN bound secret, listing
// what it really serves. Like every probe in the codebase a failure is a RESULT (reachable:false + reason), never a
// thrown error: "this tool is unreachable for me" is the answer the member came for.
export const AgentToolProbeResponseSchema = z.object({
  reachable: z.boolean(),
  detail: z.string(),
  reason: z.enum(["auth", "unreachable", "protocol"]).optional(),
  functions: z.array(AgentToolFunctionSchema).default([]),
  // Declared secrets that did not resolve for this member — the usual reason a probe comes back with `auth`.
  missingSecrets: z.array(z.string()).default([]),
});
export type AgentToolProbeResponse = z.infer<typeof AgentToolProbeResponseSchema>;
