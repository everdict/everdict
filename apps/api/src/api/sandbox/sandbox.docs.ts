import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateSandboxBodySchema } from "./request/create-sandbox.js";
import { ExecSandboxBodySchema } from "./request/exec-sandbox.js";
import { ReadSandboxTaskTraceQuerySchema } from "./request/read-sandbox-task-trace.js";
import { SubmitSandboxTaskBodySchema } from "./request/submit-sandbox-task.js";

const idParams = { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as const;
const taskParams = {
  type: "object",
  properties: { id: { type: "string" }, taskId: { type: "string" } },
  required: ["id", "taskId"],
} as const;

// Sandbox session runs (execution-model P6): boot an environment image, shell in, close — a Run on the
// universal ledger (kind "sandbox", lifetime "session") with its trajectory sealed at teardown.
export const sandboxDocs: Record<string, FastifySchema> = {
  create: {
    summary: "Open a sandbox session (an environment image to shell into, or a harness to drive)",
    description:
      "Boots the image as a long-lived container and records it as a Run (kind sandbox, lifetime session, born " +
      "running) on the activity ledger. Exactly one of image (ad-hoc), environment (an adopted environment " +
      "capability, resolved through the consume gate), or harness (a registered harness warm-installed into the " +
      "session for interactive test cases — the playground; harness.image supplies the container image for specs " +
      "that declare none) is required. The session carries a hard TTL (session.expiresAt on the record) and is " +
      "torn down on close or expiry; every exec lands on the session's trajectory, sealed at teardown. " +
      "Per-tenant/global capacity is enforced (429).",
    tags: ["sandboxes"],
    body: toJsonSchema(CreateSandboxBodySchema),
    response: {
      200: { description: "The session's RunRecord (kind sandbox, status running, session.expiresAt set)" },
      ...errorResponses(400, 401, 402, 403, 404, 429, 502),
    },
  },
  list: {
    summary: "List live sandbox sessions (the reattach surface)",
    description:
      "Every session live on this control plane for the caller's workspace, each with its RunRecord and live " +
      "meta (expiresAt, busy, the booted harness, task summaries). Bounded by the global session cap — no " +
      "pagination. Settled/historical sessions stay on /runs.",
    tags: ["sandboxes"],
    response: {
      200: { description: "{ sessions: [{ record: RunRecord, live?: { expiresAt, busy, harness?, tasks[] } }] }" },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Read one sandbox session (record + live meta)",
    description:
      "The ledger record always answers (settled sessions included); `live` is present only while this control " +
      "plane holds the container handle — its task summaries and busy flag are what the playground panel polls.",
    tags: ["sandboxes"],
    params: idParams,
    response: {
      200: { description: "{ record: RunRecord, live?: { expiresAt, busy, harness?, tasks[] } }" },
      ...errorResponses(401, 403, 404),
    },
  },
  submitTask: {
    summary: "Submit one ad-hoc test case into a live harness session (the playground)",
    description:
      "Runs the session's harness on the given task prompt — no dataset, no graders. The child Run (kind eval, " +
      "class interactive, grouped to the session) is returned immediately (202, born running); poll its trace " +
      "via GET /sandboxes/:id/tasks/:taskId/trace. Each case gets a fresh working directory inside the warm " +
      "container. One task at a time per session (409 while one runs); tenant budget admission applies (402). " +
      "Creator-or-admin, checked before anything runs.",
    tags: ["sandboxes"],
    params: idParams,
    body: toJsonSchema(SubmitSandboxTaskBodySchema),
    response: {
      202: { description: "The child run's RunRecord (kind eval, status running, group → the session)" },
      ...errorResponses(400, 401, 402, 403, 404, 409),
    },
  },
  taskTrace: {
    summary: "Poll one test case's trace (live cursor, sealed fallback)",
    description:
      "Events since the cursor (an index into the task's append-only buffer; omitted = full replay). While the " +
      "task runs this reads the live buffer — with a streaming-capable harness, tool calls appear before the " +
      "case finishes. After settle the sealed trajectory serves the same events, so a refresh mid-completion is " +
      "lossless. done:true = terminal — stop polling (the run detail and GET /runs/:id/trajectory take over).",
    tags: ["sandboxes"],
    params: taskParams,
    querystring: toJsonSchema(ReadSandboxTaskTraceQuerySchema),
    response: {
      200: { description: "{ status, events: TraceEvent[], nextCursor, done }" },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  exec: {
    summary: "Run one shell command inside a live sandbox session",
    description:
      "Executes `sh -c command` in the session container and returns stdout/stderr/exitCode. Creator-or-admin " +
      "only, checked BEFORE the command runs (attach is not a read). The exec is appended to the session's " +
      "trajectory. 404 when no live session with that id exists on this control plane (closed, expired, or lost " +
      "to a restart).",
    tags: ["sandboxes"],
    params: idParams,
    body: toJsonSchema(ExecSandboxBodySchema),
    response: {
      200: { description: "{ stdout, stderr, exitCode }" },
      ...errorResponses(400, 401, 403, 404, 502),
    },
  },
  reap: {
    summary: "Reap a sandbox session at its deadline (internal)",
    description:
      "The durable reaper's teardown (reaper:<runId> workflow timer → this route, x-internal-token). A live " +
      "handle tears down as expired; a running row whose handle died with an earlier control plane settles as " +
      "orphaned and its stray container is removed by session.computeId. Idempotent over a settled row.",
    tags: ["internal"],
    params: idParams,
    response: {
      200: { description: "{ reaped: boolean }" },
      ...errorResponses(400, 403, 404),
    },
  },
  close: {
    summary: "Close a sandbox session",
    description:
      "Tears the container down (the reaper is the finally), seals the session's trajectory, and settles the run " +
      "as succeeded with session.closedReason. Idempotent over an already-settled session; a running record " +
      "whose live handle was lost to a control-plane restart settles as orphaned.",
    tags: ["sandboxes"],
    params: idParams,
    response: {
      200: { description: "The settled RunRecord" },
      ...errorResponses(401, 403, 404),
    },
  },
};
