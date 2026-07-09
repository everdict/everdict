import type { FastifySchema } from "fastify";
import { z } from "zod";
import { UpsertCiLinkBodySchema } from "../../core/ci-link/ci-link-service.js";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CiLinkRosterSchema } from "./response/ci-link-roster.js";
import { SetupPrResultSchema } from "./response/setup-pr-result.js";

// Doc-only OpenAPI descriptors for CI repo links — repository ↔ harness slot mapping = the GitHub Actions
// OIDC trust policy (rule api-layer: schemas document, never validate/serialize — the compilers are no-ops).
// Values are widened to FastifySchema so Fastify does NOT narrow reply.code() to the documented status keys.
const docs = {
  list: {
    summary: "List CI repo links",
    description:
      "Repository ↔ harness slot mappings. A link's existence IS the OIDC trust policy: it federates that " +
      "repo's GitHub Actions OIDC token into this workspace (keyless CI auth, ci role). Read is harnesses:read " +
      "(benign metadata shown on the harness detail). Design: docs/architecture/github-actions-trigger.md.",
    tags: ["ci-link"],
    response: {
      200: { description: "Link roster", ...toJsonSchema(CiLinkRosterSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  upsert: {
    summary: "Create or update a CI repo link",
    description:
      "Upsert keyed by (host, repository) — host unset = github.com, set = that GHE instance. Creating a link " +
      "grants trust to that repo's OIDC token, so this requires settings:write (admin). CI placement is always " +
      'self-hosted: a personal runner runtime ("self"/"self:<id>") is rejected 400 — only the "self:ws" pool or ' +
      '"self:ws:<id>" narrowing is allowed. Returns the full roster after the change.',
    tags: ["ci-link"],
    body: toJsonSchema(UpsertCiLinkBodySchema),
    response: {
      200: { description: "Link roster after the upsert", ...toJsonSchema(CiLinkRosterSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  remove: {
    summary: "Remove a CI repo link",
    description:
      'Revokes that repo\'s OIDC trust. repository is "owner/name" (contains a slash) so it rides as a query ' +
      "parameter, not a path segment; host unset = the github.com link. Requires settings:write (admin). " +
      "Returns the full roster after the change.",
    tags: ["ci-link"],
    querystring: toJsonSchema(
      z.object({
        repository: z.string().describe('Repository "owner/name" (required)'),
        host: z.string().optional().describe("GHE base URL — unset = github.com"),
      }),
    ),
    response: {
      200: { description: "Link roster after the removal", ...toJsonSchema(CiLinkRosterSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setupPr: {
    summary: "Open a CI setup PR on the linked repo",
    description:
      "Synthesizes the link's workflow YAML and opens a branch+commit+PR on the target repo via a " +
      "workspace-owned GitHub App installation token (near-idempotent — an existing branch/PR is reused). " +
      "Fail-closed: 400 when the self:ws runner pool is empty (a merged workflow with zero runners queues " +
      "silently on GitHub). Since the link already granted trust, this is harnesses:read — the PR still needs " +
      "merge approval on GitHub. Errors: missing link / App not installed 404, GitHub failure 502.",
    tags: ["ci-link"],
    body: toJsonSchema(
      z.object({
        repository: z.string().min(1).describe('Repository "owner/name" of an existing link'),
        host: z.string().url().optional().describe("GHE base URL — unset = github.com"),
      }),
    ),
    response: {
      200: { description: "Opened (or reused) setup PR", ...toJsonSchema(SetupPrResultSchema) },
      ...errorResponses(400, 401, 403, 404, 502),
    },
  },
} satisfies Record<string, FastifySchema>;

export const ciLinkDocs: Record<keyof typeof docs, FastifySchema> = docs;
