import {
  AgentModelPreferenceResponseSchema,
  AgentSkillListResponseSchema,
  AgentToolDetailResponseSchema,
  AgentToolListResponseSchema,
  AgentToolProbeResponseSchema,
} from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { BindAgentToolSecretsBodySchema } from "./request/bind-agent-tool-secrets.js";
import { SetAgentModelBodySchema } from "./request/set-agent-model.js";
import { SetAgentToolBodySchema } from "./request/set-agent-tool.js";

// The percent-encoded tool key every :key route takes (`capability:<owner>/<id>` carries a slash).
const KEY_PARAM = {
  type: "object",
  properties: { key: { type: "string", description: "Percent-encoded tool key from GET /agent/tools" } },
  required: ["key"],
} as const;

// OpenAPI descriptors for /agent/tools + /agent/skills — doc-only (rule api-layer); validation stays in the handlers.

const SELF_SCOPED = [
  "Self-scoped: any member of the workspace may read and set their own. Affects only this member — the workspace",
  "AgentSpec and skill library are untouched, which is how two members of one workspace get two different agents.",
].join(" ");

const docs = {
  listTools: {
    summary: "List the caller's agent toolset",
    description: [
      "Every tool the calling member can put on the workspace assistant, with the effective on/off for THEM:",
      "first-party defaults (builtin), tools shared at the workspace (adopted on the AgentSpec, hand-wired MCP",
      "servers, or published workspace-wide), and the member's own private publications (personal). Each row also",
      "reports the workspace baseline, so a row where enabled differs from baseline is the member's own override.",
      SELF_SCOPED,
    ].join(" "),
    tags: ["agent"],
    response: {
      200: { description: "The caller's toolset", ...toJsonSchema(AgentToolListResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  setTool: {
    summary: "Turn one tool on or off for the caller",
    description: [
      "Sets the calling member's own decision about one tool (enabled true/false), or clears it with null so they",
      "follow the workspace baseline again. A key that is not in the caller's toolset is 404.",
      SELF_SCOPED,
      "Returns the refreshed toolset.",
    ].join(" "),
    tags: ["agent"],
    body: toJsonSchema(SetAgentToolBodySchema),
    response: {
      200: { description: "The refreshed toolset", ...toJsonSchema(AgentToolListResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  getTool: {
    summary: "Read one tool of the caller's agent toolset in full",
    description: [
      "The detail behind the list row: which channel put the tool on the table (builtin | capability | mcpServer),",
      "how the runtime reaches it (remote MCP URL · stdio container · code script), the functions it contributes to",
      "the model's tool list with the NAMESPACED names the model actually calls, the description the model reads,",
      "the pinned source + worked examples of a code tool, and each declared secret with the secret name it reads and",
      "whether the caller can satisfy it. Also reports whether the tool can be rebound, edited, or probed.",
      SELF_SCOPED,
      "A key that is not in the caller's toolset is 404.",
    ].join(" "),
    tags: ["agent"],
    params: KEY_PARAM,
    response: {
      200: { description: "The tool", ...toJsonSchema(AgentToolDetailResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  probeTool: {
    summary: "Test-connect one MCP tool and list its functions",
    description: [
      "Opens a live MCP session to the tool AS THIS MEMBER — using the secret their agent would use — and returns",
      "what the server really serves, so the declared function list can be checked against reality. A failure is a",
      "RESULT (reachable:false + reason + the unresolved secret names), never an error. Only a remote (HTTP) MCP tool",
      "can be probed from the control plane: a container tool is started by the agent and a code tool is verified by",
      "running it, so either is 400.",
      SELF_SCOPED,
    ].join(" "),
    tags: ["agent"],
    params: KEY_PARAM,
    response: {
      200: { description: "The probe result", ...toJsonSchema(AgentToolProbeResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  bindToolSecrets: {
    summary: "Bind one tool's declared secrets to real secret names",
    description: [
      "Points each secret a tool declares at a secret name in this workspace (values are never sent — a spec",
      "references a secret by NAME). Unlike the on/off overlay this edits the WORKSPACE agent configuration, because",
      "that is where the binding lives: an adopted capability keeps it on its pinned reference, a hand-wired MCP",
      "server on its authSecret, and a built-in default / published-but-unadopted capability on the spec-level",
      "toolSecretBindings overlay. It therefore requires agents:write and produces a NEW agent version.",
      "An omitted entry keeps the current binding; an empty name clears the remap (back to the declared name).",
      "Returns the refreshed tool.",
    ].join(" "),
    tags: ["agent"],
    params: KEY_PARAM,
    body: toJsonSchema(BindAgentToolSecretsBodySchema),
    response: {
      200: { description: "The refreshed tool", ...toJsonSchema(AgentToolDetailResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  listSkills: {
    summary: "List the caller's agent skill set",
    description: [
      "Every skill the workspace supports, with the effective on/off for THIS member: skills authored here",
      "(including the caller's own private drafts), skill packages adopted or published in this workspace, and the",
      "first-party built-ins. The workspace library says what exists; this says what the member's agent follows.",
      SELF_SCOPED,
    ].join(" "),
    tags: ["agent"],
    response: {
      200: { description: "The caller's skill set", ...toJsonSchema(AgentSkillListResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  setSkill: {
    summary: "Turn one skill on or off for the caller",
    description: [
      "Sets the calling member's own decision about one skill (enabled true/false), or clears it with null so they",
      "follow the workspace baseline again. A key that is not in the caller's skill set is 404.",
      SELF_SCOPED,
      "Returns the refreshed skill set.",
    ].join(" "),
    tags: ["agent"],
    body: toJsonSchema(SetAgentToolBodySchema),
    response: {
      200: { description: "The refreshed skill set", ...toJsonSchema(AgentSkillListResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
  getModel: {
    summary: "Read the caller's default agent model",
    description: [
      "Which registered model the calling member's conversations run on by default, next to the workspace baseline it",
      "stands in for: `model` is their own pick (null = they follow the workspace) and `workspaceDefault` is the",
      "workspace agent's own model (null = the agent server's deployment default). The models a member may pick from",
      "are GET /models.",
      SELF_SCOPED,
    ].join(" "),
    tags: ["agent"],
    response: {
      200: { description: "The caller's default model", ...toJsonSchema(AgentModelPreferenceResponseSchema) },
      ...errorResponses(401, 404),
    },
  },
  setModel: {
    summary: "Set the caller's default agent model",
    description: [
      "Picks the registered model the calling member's conversations run on by default, or clears it with null so they",
      "follow the workspace agent's model again. A single conversation's own pick still wins over this, and a crafted",
      "agent keeps the model it declares. An id that is not a registered model in this workspace is 404.",
      SELF_SCOPED,
      "Returns the refreshed preference.",
    ].join(" "),
    tags: ["agent"],
    body: toJsonSchema(SetAgentModelBodySchema),
    response: {
      200: { description: "The refreshed preference", ...toJsonSchema(AgentModelPreferenceResponseSchema) },
      ...errorResponses(400, 401, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (repo convention): keeps the doc attachment behavior-free (no reply.code() narrowing).
export const agentToolDocs: Record<keyof typeof docs, FastifySchema> = docs;
