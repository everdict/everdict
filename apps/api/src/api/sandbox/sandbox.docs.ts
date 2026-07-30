import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateSandboxBodySchema } from "./request/create-sandbox.js";
import { ExecSandboxBodySchema } from "./request/exec-sandbox.js";

const idParams = { type: "object", properties: { id: { type: "string" } }, required: ["id"] } as const;

// Sandbox session runs (execution-model P6): boot an environment image, shell in, close — a Run on the
// universal ledger (kind "sandbox", lifetime "session") with its trajectory sealed at teardown.
export const sandboxDocs: Record<string, FastifySchema> = {
  create: {
    summary: "Open a sandbox session (run an environment image and shell in)",
    description:
      "Boots the image as a long-lived container and records it as a Run (kind sandbox, lifetime session, born " +
      "running) on the activity ledger. Exactly one of image (ad-hoc) or environment (an adopted environment " +
      "capability, resolved through the consume gate) is required. The session carries a hard TTL " +
      "(session.expiresAt on the record) and is torn down on close or expiry; every exec lands on the session's " +
      "trajectory, sealed at teardown. Per-tenant/global capacity is enforced (429).",
    tags: ["sandboxes"],
    body: toJsonSchema(CreateSandboxBodySchema),
    response: {
      200: { description: "The session's RunRecord (kind sandbox, status running, session.expiresAt set)" },
      ...errorResponses(400, 401, 402, 403, 404, 429, 502),
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
