import { type Dataset, GraderSpecSchema } from "@everdict/core";
import { z } from "zod";
import { type BenchmarkAdapter, type ImportBenchmarkOpts, importBenchmark } from "./catalog.js";
import { type DatasetMeta, interpolateFields } from "./mapping.js";
import { type FetchLike, fetchHfFileRows, fetchHfRows } from "./sources.js";

// The benchmark definition as JSON-serializable "data" — a recipe the tenant registers/versions in their own workspace.
// Unlike the first-party catalog adapters (code: rowTransform/graderBuilder), this spec is pure data, so it can be stored in the registry.

// Mapping rules (data). **Isomorphic** to the CaseMapping interface in mapping.ts — if this schema is too narrow, a user recipe
// cannot use the env kinds (prompt/os-use)·image·placement the first-party catalog code uses and silently falls back to a browser env
// (Zod strips unspecified keys). So expose every CaseMapping field here (self-serve completeness).
export const CaseMappingSchema = z.object({
  idField: z.string(),
  taskField: z.string(),
  taskTemplate: z.string().optional(), // Composes task from multiple fields ({field} interpolation) — e.g. question + evidence document URL (OfficeQA-style)

  startUrlField: z.string().optional(),
  promptEnv: z.boolean().optional(), // true → prompt env (QA — gsm8k/GAIA). git/repoPath takes precedence.
  answerField: z.string().optional(),
  answerMode: z.enum(["contains", "exact"]).optional(),
  gitField: z.string().optional(),
  refField: z.string().optional(),
  repoPath: z.string().optional(), // in-image repo (e.g. SWE-bench "/testbed") — no clone
  osUseEnv: z.boolean().optional(), // true → os-use (desktop) env — OSWorld-style
  osUseSetup: z.array(z.string()).optional(), // os-use env.setup (starting Xvfb, etc.)
  display: z.string().optional(), // os-use display (default ":99")
  screenshotPath: z.string().optional(), // os-use snapshot path (VLM judge)
  imageField: z.string().optional(), // per-row compute image field
  image: z.string().optional(), // common compute image (imageField wins per-row)
  placement: z.string().optional(), // placement.target for all cases (registered runtime id)
  testCmdField: z.string().optional(),
  tagFields: z.array(z.string()).optional(),
  extraGraders: z.array(GraderSpecSchema).optional(),
});

export const BenchmarkSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("huggingface"),
    dataset: z.string(),
    config: z.string().optional(),
    split: z.string().optional(),
    file: z.string().optional(), // fallback for datasets the viewer (datasets-server) doesn't serve — fetch the repo data file directly (csv/jsonl/json)
    gated: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("jsonl") }),
]);

// Per-row grader template — {field} interpolation into config string values (e.g. command's applyPatch:"{test_patch}").
// Replaces graderBuilder (code) with data → expresses per-row SWE-bench-style scoring without code too.
export const GraderTemplateSchema = z.object({
  id: z.string(),
  config: z.record(z.string()).optional(),
});

// Benchmark provenance — for officially published benchmarks like SpreadsheetBench, records the homepage/paper/code/data/official leaderboard
// in the recipe (so "which benchmark, what it is" is preserved after registration). Display/citation metadata, irrelevant to execution/scoring.
export const BenchmarkOriginSchema = z
  .object({
    homepage: z.string().url().optional(), // official homepage (e.g. https://spreadsheetbench.github.io/)
    paper: z.string().url().optional(), // paper (arXiv/OpenReview, etc.)
    code: z.string().url().optional(), // code repository (GitHub, etc.)
    data: z.string().url().optional(), // source dataset page (HuggingFace, etc.)
    leaderboard: z.string().url().optional(), // official leaderboard
    authors: z.string().optional(), // authors/affiliation
    license: z.string().optional(), // license (e.g. CC-BY-4.0)
    citation: z.string().optional(), // citation (bibtex or text)
    taskType: z.string().optional(), // task type description (e.g. "real-world spreadsheet manipulation (cell/sheet level)")
  })
  .optional();
export type BenchmarkOrigin = z.infer<typeof BenchmarkOriginSchema>;

export const BenchmarkAdapterSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  category: z.enum(["browser", "qa", "coding", "tool"]).default("qa"),
  origin: BenchmarkOriginSchema, // provenance metadata (homepage/paper/code/data/official leaderboard, etc.)
  source: BenchmarkSourceSchema,
  mapping: CaseMappingSchema,
  graderTemplates: z.array(GraderTemplateSchema).optional(),
});
export type BenchmarkAdapterSpec = z.infer<typeof BenchmarkAdapterSpecSchema>;

// Data spec → runtime BenchmarkAdapter. graderTemplates become graderBuilder (per-row interpolation). Defined as data with no code functions.
export function specToAdapter(spec: BenchmarkAdapterSpec): BenchmarkAdapter {
  const templates = spec.graderTemplates;
  return {
    id: spec.id,
    description: spec.description ?? spec.id,
    category: spec.category,
    defaultVersion: spec.version,
    source: spec.source,
    mapping: spec.mapping,
    ...(templates && templates.length > 0
      ? {
          graderBuilder: (row: Record<string, unknown>) =>
            templates.map((t) => ({
              id: t.id,
              ...(t.config
                ? {
                    config: Object.fromEntries(
                      Object.entries(t.config).map(([k, v]) => [k, interpolateFields(v, row)]),
                    ),
                  }
                : {}),
            })),
        }
      : {}),
  };
}

// Ingest a benchmark from a tenant-registered spec → a registrable Dataset. Both HF/jsonl reuse importBenchmark.
export function importFromSpec(
  spec: BenchmarkAdapterSpec,
  meta: DatasetMeta,
  opts: ImportBenchmarkOpts = {},
): Promise<Dataset> {
  return importBenchmark(specToAdapter(spec), meta, opts);
}

export type BenchmarkSourceSpec = z.infer<typeof BenchmarkSourceSchema>;

// Fetches N raw rows from the source as-is before mapping — for the "add benchmark" wizard's preview/field auto-detection.
// HF uses fetchHfRows (small batch), jsonl parses the first N lines of opts.text. Shows the real fields/samples without knowing the mapping.
export async function fetchSourceRows(
  source: BenchmarkSourceSpec,
  opts: { limit?: number; token?: string; text?: string; fetchImpl?: FetchLike } = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.max(1, opts.limit ?? 5);
  if (source.kind === "huggingface") {
    // When file is specified, fetch the repo file directly instead of the viewer (datasets-server) (fallback for datasets the viewer doesn't serve).
    if (source.file) {
      return fetchHfFileRows(
        { dataset: source.dataset, file: source.file, limit, ...(opts.token ? { token: opts.token } : {}) },
        opts.fetchImpl,
      );
    }
    return fetchHfRows(
      {
        dataset: source.dataset,
        ...(source.config ? { config: source.config } : {}),
        ...(source.split ? { split: source.split } : {}),
        limit,
        ...(opts.token ? { token: opts.token } : {}),
      },
      opts.fetchImpl,
    );
  }
  if (!opts.text) throw new Error("The jsonl source requires text (the raw content).");
  return opts.text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
