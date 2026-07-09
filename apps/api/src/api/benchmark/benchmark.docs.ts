import { BenchmarkAdapterSpecSchema } from "@everdict/datasets";
import type { FastifySchema } from "fastify";
import { BenchmarkImportBodySchema, BenchmarkPreviewBodySchema } from "../../core/benchmark/benchmark-service.js";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { BenchmarkCatalogResponseSchema } from "./response/benchmark-catalog-entry.js";
import { BenchmarkRecipeListResponseSchema } from "./response/benchmark-recipe-list-entry.js";
import { BenchmarkRecipeResponseSchema } from "./response/benchmark-recipe.js";
import { HfDatasetSearchResponseSchema } from "./response/hf-dataset-hit.js";
import { HfFileListResponseSchema } from "./response/hf-file-list.js";
import { HfSplitsResponseSchema } from "./response/hf-split.js";
import { ImportBenchmarkResultSchema } from "./response/import-benchmark-result.js";
import { PreviewSourceResultSchema } from "./response/preview-source-result.js";
import { RegisterBenchmarkRecipeResultSchema } from "./response/register-benchmark-recipe-result.js";
import { ValidateBenchmarkRecipeResultSchema } from "./response/validate-benchmark-recipe-result.js";

// OpenAPI descriptors for the benchmark (catalog + HF wizard + recipe) routes — doc-only (rule api-layer):
// the no-op compilers in server.ts make attaching these behavior-free; validation stays in the handlers.

const recipeIdVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Recipe id" },
    version: { type: "string", description: 'Recipe version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  list: {
    summary: "List the first-party benchmark catalog",
    description:
      "The built-in benchmark catalog (code, not tenant data) — each entry can be imported into a " +
      "workspace-owned dataset via POST /benchmarks/import. Requires datasets:read (viewer+).",
    tags: ["benchmark"],
    response: {
      200: { description: "Catalog entries", ...toJsonSchema(BenchmarkCatalogResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  hfDatasets: {
    summary: "Search HF Hub datasets",
    description:
      "Hugging Face Hub dataset search for the add-benchmark wizard (pick candidates by query instead of typing " +
      "an exact id). Requires datasets:read (viewer+). Gated repos authenticate with the requester's HF_TOKEN " +
      "secret (personal-first merge over workspace secrets). A missing/blank q is 400.",
    tags: ["benchmark"],
    querystring: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search query" },
        limit: { type: "string", description: "Max hits (number; optional)" },
      },
      required: ["q"],
    },
    response: {
      200: { description: "Search hits", ...toJsonSchema(HfDatasetSearchResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  hfSplits: {
    summary: "List an HF dataset's config/split combinations",
    description:
      "The config/split combinations of the selected HF dataset — for the wizard dropdown. Requires " +
      "datasets:read (viewer+). Gated repos use the requester's HF_TOKEN secret. A missing dataset parameter is 400.",
    tags: ["benchmark"],
    querystring: {
      type: "object",
      properties: { dataset: { type: "string", description: "HF dataset repo id (org/name)" } },
      required: ["dataset"],
    },
    response: {
      200: { description: "Config/split combinations", ...toJsonSchema(HfSplitsResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  hfFiles: {
    summary: "List an HF dataset repo's data files",
    description:
      "Fallback for datasets not served by the HF viewer (datasets-server) — the repo's data files " +
      "(csv/jsonl/json) for the wizard file dropdown. Requires datasets:read (viewer+). A missing dataset " +
      "parameter is 400.",
    tags: ["benchmark"],
    querystring: {
      type: "object",
      properties: { dataset: { type: "string", description: "HF dataset repo id (org/name)" } },
      required: ["dataset"],
    },
    response: {
      200: { description: "Data file paths", ...toJsonSchema(HfFileListResponseSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  preview: {
    summary: "Preview a benchmark source",
    description:
      "Fetches N raw rows + detected fields before mapping — powers the add-benchmark wizard's field " +
      "auto-detect. No registration or writes (pure fetch). Requires datasets:write (member+). Gated HF sources " +
      "authenticate with the HF_TOKEN secret.",
    tags: ["benchmark"],
    body: toJsonSchema(BenchmarkPreviewBodySchema),
    response: {
      200: { description: "Detected fields + raw rows", ...toJsonSchema(PreviewSourceResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  import: {
    summary: "Import a benchmark into a workspace dataset",
    description:
      "Pulls one of spec (inline wizard definition) · benchmark (catalog id) · recipe (registered recipe) and " +
      "registers the result as a workspace-owned dataset (HF sources fetch over the network, using the HF_TOKEN " +
      "secret if gated; import provenance is stamped on the dataset). Requires datasets:write (member+). An " +
      "unsupported catalog id is 400; a dataset version collision is 409 (versions are immutable).",
    tags: ["benchmark"],
    body: toJsonSchema(BenchmarkImportBodySchema),
    response: {
      201: { description: "Imported and registered as a dataset", ...toJsonSchema(ImportBenchmarkResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  registerRecipe: {
    summary: "Register a benchmark recipe version",
    description:
      "Registers a workspace-owned benchmark recipe (BenchmarkAdapterSpec — a reusable source → dataset mapping; " +
      "import is a separate call). Requires datasets:write (member+; a recipe is a dataset adapter). Versions " +
      "are immutable — re-registering the same (id, version) with different content is 409.",
    tags: ["benchmark"],
    body: toJsonSchema(BenchmarkAdapterSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterBenchmarkRecipeResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validateRecipe: {
    summary: "Dry-run validate a benchmark recipe",
    description:
      "Validates schema + reports this workspace's existing recipe versions and whether the submitted version " +
      "collides, without registering. Requires datasets:write (member+). Validation failures are reported as " +
      "ok:false in a 200 response, not as 4xx.",
    tags: ["benchmark"],
    body: toJsonSchema(BenchmarkAdapterSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateBenchmarkRecipeResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  listRecipes: {
    summary: "List benchmark recipes",
    description:
      "Lists this workspace's recipes plus _shared first-party entries (workspace-owned first, _shared " +
      "fallback). Requires datasets:read (viewer+).",
    tags: ["benchmark"],
    response: {
      200: { description: "Recipe list entries", ...toJsonSchema(BenchmarkRecipeListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  getRecipe: {
    summary: "Get a benchmark recipe version",
    description:
      'The full recipe spec for one version. version may be "latest" (semver-latest). Requires datasets:read ' +
      "(viewer+). Another workspace's recipe reads 404 — no existence leak.",
    tags: ["benchmark"],
    params: recipeIdVersionParams,
    response: {
      200: { description: "BenchmarkAdapterSpec", ...toJsonSchema(BenchmarkRecipeResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const benchmarkDocs: Record<keyof typeof docs, FastifySchema> = docs;
