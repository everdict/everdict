import { ProductRecordSchema, ProductServiceVersionRecordSchema, ReleaseRecordSchema } from "@everdict/contracts";
import {
  ProductDetailResponseSchema,
  ProductListResponseSchema,
  ProductRepoDiscoveryResponseSchema,
  ProductSyncResponseSchema,
  ProductTimelineResponseSchema,
  ReleaseDetailResponseSchema,
} from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CreateProductBodySchema } from "./request/create-product.js";
import { CreateReleaseBodySchema, UpdateReleaseBodySchema } from "./request/create-release.js";
import { DiscoverRepoBodySchema } from "./request/discover-repo.js";
import { SetReleaseStatusBodySchema } from "./request/set-release-status.js";
import { UpdateProductBodySchema } from "./request/update-product.js";

// OpenAPI descriptors for the product timeline (doc-only — never validates/serializes; see api/openapi.ts).
// A Product is the released thing several services compose: its tracked services' GitHub releases/tags are
// pulled into a version ledger, its watch series (dataset × harness × judges) are the trends its quality is
// judged by, and a Release is a gated checkpoint on that axis. Authz reuses the issue pair (read =
// issues:read, write = issues:write); delete additionally creator-or-admin. Facts product.created /
// product.service_version_imported / release.created / release.status_changed feed the event log.
export const productDocs: Record<
  | "create"
  | "list"
  | "get"
  | "repoOptions"
  | "discover"
  | "listVersions"
  | "timeline"
  | "update"
  | "delete"
  | "sync"
  | "createRelease"
  | "listReleases"
  | "getRelease"
  | "updateRelease"
  | "setReleaseStatus"
  | "deleteRelease",
  FastifySchema
> = {
  create: {
    summary: "Create a product on the timeline",
    description:
      "The released thing several services compose. `services` name the GitHub repositories whose " +
      "releases/tags mark 'this component moved'; `series` declare the dataset × harness × judges trends the " +
      "product is judged by (validated against the workspace's registries). Auto-eval is on by default: a " +
      "genuinely new imported version submits one scorecard per watched series. Emits product.created. " +
      "Requires issues:write.",
    tags: ["product"],
    body: toJsonSchema(CreateProductBodySchema),
    response: {
      201: { description: "The created product", ...toJsonSchema(ProductRecordSchema) },
      ...errorResponses(400, 401, 403),
    },
  },
  list: {
    summary: "List the workspace's products",
    description: "Every product, newest activity first. Requires issues:read.",
    tags: ["product"],
    response: {
      200: { description: "The workspace's products", ...toJsonSchema(ProductListResponseSchema) },
      ...errorResponses(401, 403),
    },
  },
  get: {
    summary: "Get one product with its releases and recent versions",
    description:
      "The record plus every release and the visible slice of the imported version ledger. The per-series " +
      "trend is GET /products/:id/timeline (windowed). Requires issues:read.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The product detail", ...toJsonSchema(ProductDetailResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  repoOptions: {
    summary: "The repositories a tracked service may point at",
    description:
      "The workspace GitHub App's installation repos — exactly the set the version sync can mint tokens " +
      "for, so the wizard's picker offers what the control plane accepts. Empty = no App installed. " +
      "Requires issues:write.",
    tags: ["product"],
    response: {
      200: {
        description: "The pickable repositories",
        ...toJsonSchema(z.array(z.object({ fullName: z.string(), host: z.string().optional(), private: z.boolean() }))),
      },
      ...errorResponses(401, 403),
    },
  },
  discover: {
    summary: "Read a repository and propose the services it composes",
    description:
      "Read-only, persists nothing. Reads the repository through the workspace GitHub App and answers the " +
      "two questions a service row needs: which version streams it publishes (releases first, tags as the " +
      "fallback — with the tag prefixes derived from the real tag names) and which deployable units live in " +
      "its tree (a monorepo composes one product out of several subpaths). `suggestions` are the rows a " +
      "wizard renders: `recommended` ones are backed by an existing version stream, the rest are packages " +
      "offered under a repo-wide stream. `versions` is the sample the caller re-filters when a member edits " +
      "a prefix, so a preview costs no extra round trip. `complete: false` = a read hit its ceiling, which " +
      "makes every count a floor. Requires issues:write.",
    tags: ["product"],
    body: toJsonSchema(DiscoverRepoBodySchema),
    response: {
      200: { description: "What the repository says it composes", ...toJsonSchema(ProductRepoDiscoveryResponseSchema) },
      ...errorResponses(400, 401, 403, 404, 502),
    },
  },
  listVersions: {
    summary: "List a product's imported service versions",
    description:
      "The version ledger, newest published first (the remote's own clock). Filter by service name. " +
      "Requires issues:read.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    querystring: toJsonSchema(
      z.object({ service: z.string().optional(), limit: z.coerce.number().int().positive().max(500).optional() }),
    ),
    response: {
      200: { description: "The imported versions", ...toJsonSchema(z.array(ProductServiceVersionRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  timeline: {
    summary: "The product's time axis in one read",
    description:
      "Releases (past + planned), the windowed version ledger, each watch series' scorecard points (oldest " +
      "first, with pass rate and the service version that triggered them), and the lifecycle markers of " +
      "linked issues. Default window: the last 90 days. Requires issues:read.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    querystring: toJsonSchema(
      z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }),
    ),
    response: {
      200: { description: "The timeline", ...toJsonSchema(ProductTimelineResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  update: {
    summary: "Edit a product",
    description:
      "Content editing — audit-trail history, no lifecycle facts. Lists replace what is there; a re-declared " +
      "service keeps its sync watermark unless its repository/source/prefix changed (then the next sync is a " +
      "fresh backfill). Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(UpdateProductBodySchema),
    response: {
      200: { description: "The updated product", ...toJsonSchema(ProductRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  delete: {
    summary: "Delete a product",
    description:
      "Creator or workspace admin only. Its releases and version ledger cascade with it — they exist only " +
      "under their product. Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: { 204: { description: "Deleted", type: "null" }, ...errorResponses(401, 403, 404) },
  },
  sync: {
    summary: "Pull the tracked services' releases/tags from GitHub now",
    description:
      "Everdict stays the client — no webhook; this is the timeline's refresh. Per-service soft-fail (an " +
      "unreachable repository records its error and the rest proceed). The first sync of a service is a " +
      "BACKFILL: it fills the timeline's past but emits nothing and runs nothing. After that, each genuinely " +
      "new version emits product.service_version_imported and — when auto-eval is enabled — submits one " +
      "scorecard per watched series (the active planned release's selection, else every series), stamped " +
      "with product/series/version provenance. Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "What the pull did, per service", ...toJsonSchema(ProductSyncResponseSchema) },
      ...errorResponses(401, 403, 404, 502),
    },
  },
  createRelease: {
    summary: "Plan a release",
    description:
      "A checkpoint on the product's axis — a name, a target date, which watch series it is judged by " +
      "(absent = every series) and which service versions it ships (`components`, one row per tracked " +
      "service; a version may be omitted while the plan is still open). It starts `planned`; shipping goes " +
      "through POST /releases/:id/status, which is a gate — the composition is recorded, never gated on. " +
      "Emits release.created. Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(CreateReleaseBodySchema),
    response: {
      201: { description: "The planned release", ...toJsonSchema(ReleaseRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  listReleases: {
    summary: "List the workspace's releases",
    description:
      "Every product's releases, newest plan first — the read a picker needs. Optional ?product= narrows to " +
      "one product's. Requires issues:read.",
    tags: ["product"],
    querystring: toJsonSchema(z.object({ product: z.string().optional() })),
    response: {
      200: { description: "The releases", ...toJsonSchema(z.array(ReleaseRecordSchema)) },
      ...errorResponses(401, 403, 404),
    },
  },
  getRelease: {
    summary: "Get one release with its readiness",
    description:
      "The record plus how ready it is: open issues linked to the release, and every watched series' RELEASE " +
      "VERDICT — the scorecard gate's own decision (pass|block|blocked_missing|not_comparable) over (baseline " +
      "anchored at the previous ship, latest), plus not_evaluated (no run — which BLOCKS a required series: not " +
      "evaluated is never green) and no_baseline (first ship). Opting a series out of the gate is the explicit " +
      "requiredForRelease: false, never inferred from missing evidence. Requires issues:read.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: {
      200: { description: "The release detail", ...toJsonSchema(ReleaseDetailResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  updateRelease: {
    summary: "Edit a release",
    description:
      "Content editing — audit-trail history, no lifecycle facts. `seriesKeys: null` clears the selection " +
      "back to every series; `components: null` clears the declared composition back to 'never declared' " +
      "(distinct from an empty list, which says this release ships no tracked service). Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(UpdateReleaseBodySchema),
    response: {
      200: { description: "The updated release", ...toJsonSchema(ReleaseRecordSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setReleaseStatus: {
    summary: "Move a release between planned / released / cancelled",
    description:
      "Releasing is a GATE: it refuses (409, naming the counts and the series) while issues linked to the " +
      "release are open or any required watched series' release verdict is not passing (regressed, missing " +
      "evidence, not comparable, or simply never evaluated) — unless `force: true`, which is recorded on the " +
      "fact and in the history along with the per-series verdict snapshot the decision saw. A released release " +
      "is history and cannot reopen. Emits release.status_changed. Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    body: toJsonSchema(SetReleaseStatusBodySchema),
    response: {
      200: { description: "The moved release", ...toJsonSchema(ReleaseRecordSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  deleteRelease: {
    summary: "Delete a release",
    description: "Creator or workspace admin only. Requires issues:write.",
    tags: ["product"],
    params: toJsonSchema(z.object({ id: z.string() })),
    response: { 204: { description: "Deleted", type: "null" }, ...errorResponses(401, 403, 404) },
  },
};
