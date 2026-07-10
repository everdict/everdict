import { PairRunnerBodySchema, RUNNER_CAPABILITIES } from "@everdict/application-control";
import { GithubRunnerInstallResultSchema } from "@everdict/contracts/wire";
import { PairedRunnerResponseSchema } from "@everdict/contracts/wire";
import { RunnerRosterSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// Doc-only OpenAPI descriptors for workspace-shared runners (team tier, owner="ws:<workspace>") —
// rule api-layer: schemas document, never validate/serialize (the compilers are no-ops).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  roster: {
    summary: "Workspace runner roster",
    description:
      "Every runner paired into this workspace — personal runners included (workspace-visibility roster, " +
      "metadata only, never tokens). For the team-owned subset see GET /workspace/runners/owned. " +
      "Requires members:read.",
    tags: ["runner"],
    response: {
      200: { description: "Runners paired in this workspace", ...toJsonSchema(RunnerRosterSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  pair: {
    summary: "Pair a workspace-shared runner",
    description:
      'Registers a team resource (owner="ws:<workspace>", e.g. a shared build server): unlike a personal ' +
      'runner (POST /runners, self-scoped), any member can target it via "self:ws:<id>" or the "self:ws" pool, ' +
      "and runs bill the workspace (workspace-pays). The plaintext rnr_ token appears exactly once (stored as " +
      "a hash). Requires settings:write (admin — registering a team resource).",
    tags: ["runner"],
    body: toJsonSchema(PairRunnerBodySchema),
    response: {
      200: { description: "Runner metadata + one-time pairing token", ...toJsonSchema(PairedRunnerResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  owned: {
    summary: "List workspace-owned runners",
    description:
      'Only the team-owned runners (owner="ws:<workspace>") — the roster route also includes personal runners ' +
      "paired here. Requires settings:write (admin).",
    tags: ["runner"],
    response: {
      200: { description: "Workspace-owned runners", ...toJsonSchema(RunnerRosterSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  revoke: {
    summary: "Revoke a workspace-shared runner",
    description:
      "Removes a team-owned runner (owner-scoped to ws:<workspace> — cannot touch personal runners). " +
      "Requires settings:write (admin).",
    tags: ["runner"],
    params: toJsonSchema(z.object({ id: z.string().describe("Runner id") })),
    response: { 204: { description: "Revoked", type: "null" }, ...errorResponses(401, 403, 404) },
  },
  githubInstall: {
    summary: "Generate a GitHub Actions runner install script",
    description:
      "One admin action stands up two workers on a build server: a GitHub Actions self-hosted runner " +
      "(registration token minted via the workspace GitHub App, administration permission, short-lived) and an " +
      "Everdict workspace-shared runner (newly paired — rnr_ token embedded in the script, shown once). Target " +
      'is exactly one of repository ("owner/name") or org; host selects a GHE installation (unset = ' +
      "github.com preferred). Errors: App not installed 404, repo/org format 400, GitHub failure 502. " +
      "Requires settings:write (admin).",
    tags: ["runner"],
    body: toJsonSchema(
      z.object({
        repository: z
          .string()
          .min(1)
          .optional()
          .describe('Repo-level target "owner/name" (exactly one of repository/org)'),
        org: z.string().min(1).optional().describe("Org-level target — all repos in the org share this runner"),
        host: z.string().url().optional().describe("GHE base URL — unset = github.com preferred"),
        runnerGroup: z.string().min(1).optional().describe("Org runner group (org-level only)"),
        label: z.string().min(1).max(80).optional().describe("Runner display name (defaults to the org/repo name)"),
        githubLabels: z.array(z.string().min(1)).optional().describe("Extra GitHub runner labels"),
        capabilities: z
          .array(z.enum(RUNNER_CAPABILITIES))
          .optional()
          .describe("Initial capability labels (re-probed on attach)"),
      }),
    ),
    response: {
      200: { description: "Install script + workflow wiring values", ...toJsonSchema(GithubRunnerInstallResultSchema) },
      ...errorResponses(400, 401, 403, 404, 502),
    },
  },
} satisfies Record<string, FastifySchema>;

export const workspaceRunnerDocs: Record<keyof typeof docs, FastifySchema> = docs;
