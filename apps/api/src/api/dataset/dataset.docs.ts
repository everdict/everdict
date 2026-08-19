import { VersionTagsBodySchema } from "@everdict/application-control";
import { DatasetSchema } from "@everdict/contracts";
import { DatasetDiffResponseSchema } from "@everdict/contracts/wire";
import { DatasetListResponseSchema } from "@everdict/contracts/wire";
import { DatasetResponseSchema } from "@everdict/contracts/wire";
import { DeleteDatasetVersionResultSchema } from "@everdict/contracts/wire";
import { DeleteDatasetVersionsResultSchema } from "@everdict/contracts/wire";
import { ImportDatasetResultSchema } from "@everdict/contracts/wire";
import { RegisterDatasetResultSchema } from "@everdict/contracts/wire";
import { SetVersionTagsResultSchema } from "@everdict/contracts/wire";
import { ValidateDatasetResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { withOriginDoc } from "../capability-origin.js";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { teamMoveDocs } from "../team-move.js";
import { DeleteDatasetVersionsBodySchema } from "./request/delete-dataset-versions.js";
import { ImportTerminalBenchBodySchema } from "./request/import-terminal-bench.js";

// OpenAPI descriptors for the dataset routes — doc-only (rule api-layer): the no-op compilers in server.ts
// make attaching these behavior-free; validation stays in the handlers.

const idParams = {
  type: "object",
  properties: { id: { type: "string", description: "Dataset id" } },
  required: ["id"],
};

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Dataset id" },
    version: { type: "string", description: 'Dataset version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register a dataset version",
    description: withOriginDoc(
      "Registers a workspace-owned dataset (harness-agnostic eval-case bundle). Requires datasets:write " +
        "(member+). Versions are immutable — re-registering the same (id, version) with different content is 409. " +
        "Reads resolve workspace-owned first with a _shared (first-party benchmark) fallback.",
    ),
    tags: ["dataset"],
    body: toJsonSchema(DatasetSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterDatasetResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  importTerminalBench: {
    summary: "Import a Terminal-Bench task set as a dataset",
    description:
      "Maps Terminal-Bench tasks to eval cases (prebuilt image env + instruction + the reward-file grader, which reads the reward the task's verifier publishes rather than its exit code) and registers " +
      "them as a workspace dataset. Requires datasets:write (member+). A task with no resolvable image is 400 " +
      "(Everdict references images, never builds); a version collision is 409.",
    tags: ["dataset"],
    body: toJsonSchema(ImportTerminalBenchBodySchema),
    response: {
      201: { description: "Imported and registered", ...toJsonSchema(ImportDatasetResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a dataset",
    description:
      "Validates schema + reports this workspace's existing versions and whether the submitted version collides, " +
      "without registering (pre-check for the register flow). Requires datasets:write (member+). Validation " +
      "failures are reported as ok:false in a 200 response, not as 4xx.",
    tags: ["dataset"],
    body: toJsonSchema(DatasetSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateDatasetResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  list: {
    summary: "List datasets",
    description:
      "Lists this workspace's datasets plus _shared first-party benchmarks (workspace-owned first, _shared " +
      "fallback). Requires datasets:read (viewer+). Heavy per-case content is omitted — fetch a version for cases.",
    tags: ["dataset"],
    response: {
      200: { description: "Dataset list entries", ...toJsonSchema(DatasetListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a dataset version",
    description:
      'The full dataset for one version, cases included. version may be "latest" (semver-latest). Requires ' +
      "datasets:read (viewer+). Another workspace's dataset reads 404 — no existence leak.",
    tags: ["dataset"],
    params: idVersionParams,
    response: {
      200: { description: "Dataset (cases included)", ...toJsonSchema(DatasetResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  attestVersion: {
    summary: "Attest a dataset version's ground_truth declarations",
    description:
      "Records the constitutional approval for one version's EXACT bytes (mode: legacy_attested) — the path " +
      "for datasets whose graders declare ground_truth but that predate the authoring gate. Admin only; a " +
      "version declaring nothing constitutional is a 400, because a receipt for an act nobody performed " +
      "proves nothing. Evaluation refuses an unapproved constitutional dataset, which is why this exists.",
    tags: ["dataset"],
    params: idVersionParams,
    response: {
      200: {
        description: "Attested",
        type: "object",
        properties: {
          workspace: { type: "string" },
          id: { type: "string" },
          version: { type: "string" },
          metrics: { type: "array", items: { type: "string" } },
          mode: { type: "string" },
        },
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  deleteVersion: {
    summary: "Soft-delete a dataset version",
    description:
      "Tombstones one version — data preserved (past scorecards stay reproducible), excluded from all reads. " +
      "Allowed for that version's creator or a workspace admin (datasets:delete) — enforced in the service. " +
      "Missing/already-deleted/non-owned versions are 404.",
    tags: ["dataset"],
    params: idVersionParams,
    response: {
      200: { description: "Deleted (tombstoned)", ...toJsonSchema(DeleteDatasetVersionResultSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  deleteVersions: {
    summary: "Soft-delete several dataset versions or the whole dataset",
    description:
      "Bulk tombstone — pass `versions` to delete specific versions, or omit the body to delete the whole dataset " +
      "(all of its own live versions). Every target is checked creator-or-admin (datasets:delete) BEFORE any delete, " +
      "so a single forbidden/absent version rejects the whole request (403/404) with nothing deleted. Data is " +
      "preserved (past scorecards stay reproducible). An unknown / already-fully-deleted dataset is 404.",
    tags: ["dataset"],
    params: idParams,
    body: toJsonSchema(DeleteDatasetVersionsBodySchema),
    response: {
      200: { description: "Deleted (tombstoned) versions", ...toJsonSchema(DeleteDatasetVersionsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace a dataset version's tags",
    description:
      "Whole-array PUT of free-form version labels (empty array = clear) — mutable registry metadata outside the " +
      "immutable content (distinct from the dataset's own content tags). Requires datasets:write (member+). " +
      "Targets tenant-owned live versions only — _shared or another workspace's versions are 404.",
    tags: ["dataset"],
    params: idVersionParams,
    body: toJsonSchema(VersionTagsBodySchema),
    response: {
      200: { description: "Normalized tags after replacement", ...toJsonSchema(SetVersionTagsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  diff: {
    summary: "Diff two dataset versions",
    description:
      "Case additions/removals/changes + metadata changes between base and candidate versions of the same id. " +
      'Both refs may be "latest". Requires datasets:read (viewer+). Reproducible by the immutable-version ' +
      "guarantee. Missing base/candidate query parameters are 400; an unknown version is 404.",
    tags: ["dataset"],
    params: idParams,
    querystring: {
      type: "object",
      properties: {
        base: { type: "string", description: 'Base version ref (accepts "latest")' },
        candidate: { type: "string", description: 'Candidate version ref (accepts "latest")' },
      },
      required: ["base", "candidate"],
    },
    response: {
      200: { description: "Structural diff (base ↔ candidate)", ...toJsonSchema(DatasetDiffResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  move: teamMoveDocs({
    resource: "dataset",
    tag: "dataset",
    idDescription: "Dataset id",
    action: "datasets:write",
    extra:
      "EVERY version moves — ownership belongs to the dataset, not to one release of it — including retired " +
      "(tombstoned) ones, so a revived version does not reappear under the previous team. Content is untouched: " +
      "no version is minted, and immutability is unaffected.",
  }),
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const datasetDocs: Record<keyof typeof docs, FastifySchema> = docs;
