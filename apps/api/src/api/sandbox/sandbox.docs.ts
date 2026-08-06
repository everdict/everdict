import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CloseSandboxBodySchema } from "./request/close-sandbox.js";
import { CreateSandboxBodySchema } from "./request/create-sandbox.js";
import { ExecSandboxBodySchema } from "./request/exec-sandbox.js";
import { PushSandboxGitBodySchema } from "./request/push-sandbox-git.js";
import { ReadSandboxTaskTraceQuerySchema } from "./request/read-sandbox-task-trace.js";
import { SnapshotSandboxBodySchema } from "./request/snapshot-sandbox.js";
import { SubmitSandboxTaskBodySchema } from "./request/submit-sandbox-task.js";
import { TouchSandboxBodySchema } from "./request/touch-sandbox.js";

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
      "that declare none) is required. harness.conversation boots a CONVERSATION session: every submitted task " +
      "continues one conversation (stable workdir + the harness's resume mechanism) instead of running " +
      "independent cases — refused (400) when the harness cannot resume. The session carries a hard TTL " +
      "(session.expiresAt on the record) and is torn down on close or expiry; every exec lands on the session's " +
      "trajectory, sealed at teardown. Per-tenant/global capacity is enforced (429).",
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
      "container; on a CONVERSATION session each submit is one more turn of the same conversation (shared " +
      "workdir, group role 'turn'), and `fresh` starts a new thread (400 on a non-conversation session). One " +
      "task at a time per session (409 while one runs); tenant budget admission applies (402). " +
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
  snapshot: {
    summary: "Snapshot a world session (publish its filesystem as the world's next version)",
    description:
      "Agent worlds: commits the live container's filesystem, pushes it into the workspace's managed image " +
      "namespace as the world's next v<n> tag, and registers it as a new environment-capability version pinned " +
      "to the pushed digest — the next session boots the world from it (create with world:{id}). The commit and " +
      "push run host-side; no credential ever enters the container. Prose (name/description/instructions) " +
      "carries forward from the world's latest version when omitted. Creator-or-admin; 409 while a playground " +
      "task runs; 400 on a session with no world or a deployment with no managed image store.",
    tags: ["sandboxes"],
    params: idParams,
    body: toJsonSchema(SnapshotSandboxBodySchema),
    response: {
      200: { description: "{ world, version, image } — the published capability version and its pinned ref" },
      ...errorResponses(400, 401, 403, 404, 409, 502),
    },
  },
  gitPush: {
    summary: "Push a session's working tree to its remote (optionally opening a pull request)",
    description:
      "Agent worlds: pushes the session's checked-out branch to the repository it was cloned from. The write " +
      "credential is a GitHub App installation token minted for THIS call and discarded — it is never stored " +
      "on the session and never enters a snapshot. Committing is the caller's own job through exec (it needs " +
      "no credential); this authenticates the push. The remote URL is read from the container, so what is " +
      "pushed is what is actually checked out. 400 on a directory with no remote or a detached HEAD; 404 when " +
      "no workspace GitHub App installation covers the repository. Creator-or-admin.",
    tags: ["sandboxes"],
    params: idParams,
    body: toJsonSchema(PushSandboxGitBodySchema),
    response: {
      200: { description: "{ branch, remote, pushed, pullRequest?: { url, base } }" },
      ...errorResponses(400, 401, 403, 404, 502),
    },
  },
  touch: {
    summary: "Extend a live sandbox session's deadline (keep-alive)",
    description:
      "Pushes the session's hard deadline out to now+ttl (clamped to the max; a touch never PULLS a deadline " +
      "in) — in process memory, on the run record, and on the durable reaper's timer. Creator-or-admin.",
    tags: ["sandboxes"],
    params: idParams,
    body: toJsonSchema(TouchSandboxBodySchema),
    response: {
      200: { description: "{ expiresAt } — the session's new hard deadline" },
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
      "as succeeded with session.closedReason. A world session with hibernate on snapshots BEFORE the container " +
      "dies; body.snapshot overrides that default for this one close. Idempotent over an already-settled " +
      "session; a running record whose live handle was lost to a control-plane restart settles as orphaned.",
    tags: ["sandboxes"],
    params: idParams,
    body: toJsonSchema(CloseSandboxBodySchema),
    response: {
      200: { description: "The settled RunRecord" },
      ...errorResponses(400, 401, 403, 404),
    },
  },
};
