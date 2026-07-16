import { GithubAppDetailViewSchema } from "@everdict/contracts/wire";
import { GithubAppViewSchema } from "@everdict/contracts/wire";
import { InstallStartResponseSchema } from "@everdict/contracts/wire";
import { InstallationRepoSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";

// Doc-only OpenAPI descriptors for the workspace GitHub App integration (rule api-layer: schemas document,
// never validate/serialize — the compilers are no-ops). Body/query schemas mirror exactly what the handlers parse.
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  view: {
    summary: "Workspace GitHub App integration status",
    description:
      "Installations with each installation's allowed repos (per-install soft-fail via reposError), the configured " +
      "providers (github.com / GitHub Enterprise — both operator env), plus the callback URL to register as the App " +
      "Setup URL. Workspace-owned integration (replaces personal connections). Requires settings:read.",
    tags: ["github-app"],
    response: {
      200: { description: "Install status with allowed repos", ...toJsonSchema(GithubAppDetailViewSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  repos: {
    summary: "List repos the workspace App installations can access",
    description:
      "Repo picker for the CI repo-link UX — merges every installation's repository list. Only the repos chosen " +
      "at install time appear (= what the team explicitly allowed). Requires settings:read.",
    tags: ["github-app"],
    response: {
      200: {
        description: "Accessible repos across all installations",
        ...toJsonSchema(z.array(InstallationRepoSchema)),
      },
      ...errorResponses(400, 401, 403, 404, 502),
    },
  },
  startInstall: {
    summary: "Start a GitHub App install",
    description:
      "Returns the GitHub App install-page URL (with a single-use state). host absent = the operator github.com App; " +
      "host set = the operator GitHub Enterprise App (that host). The admin picks repos on GitHub, which then " +
      "redirects to the public callback. Requires settings:write (admin).",
    tags: ["github-app"],
    body: toJsonSchema(
      z.object({
        host: z
          .string()
          .url()
          .optional()
          .describe("GitHub Enterprise base URL — absent = github.com (operator env App)"),
      }),
    ),
    response: {
      200: { description: "Install page URL", ...toJsonSchema(InstallStartResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  callback: {
    summary: "GitHub App install callback (public)",
    description:
      "GitHub redirects here after an App install (Setup URL). No auth — authenticity comes from the single-use " +
      "state minted by install/start. Records the installation on the workspace and redirects the browser back to " +
      "the workspace settings screen (success or error callout).",
    tags: ["github-app"],
    querystring: toJsonSchema(
      z.object({
        installation_id: z.number().int().optional().describe("Installation id GitHub assigns"),
        state: z.string().optional().describe("Single-use state from install/start"),
      }),
    ),
    response: { 302: { description: "Redirect back to the workspace settings screen", type: "null" } },
  },
  unlinkInstallation: {
    summary: "Unlink a GitHub App installation",
    description:
      "Forgets the installation record on the workspace (idempotent) — the actual uninstall happens on GitHub's side. " +
      "Requires settings:write (admin).",
    tags: ["github-app"],
    params: toJsonSchema(z.object({ id: z.string().describe("Installation id (numeric)") })),
    response: {
      200: { description: "Updated installations + providers", ...toJsonSchema(GithubAppViewSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const githubAppDocs: Record<keyof typeof docs, FastifySchema> = docs;
