import { z } from "zod";
import { VersionSchema } from "../version.js";
import { EvalCaseSchema } from "./eval-case.js";

// Dataset: a bundle of eval cases — harness-agnostic (run any harness@version against the same cases for a fair comparison).
// Immutable versions (enforced by the registry) — cases must be fixed for a baseline↔candidate comparison to be reproducible.
// Distinct from core's Suite: a Suite is tied to a harness.id and unversioned; a Dataset is harness-agnostic + versioned.
// Original data source (lineage) — where the case rows actually came from. HuggingFace dataset/file/split + canonical link.
// The basis for the dataset detail showing "where this data came from" as links (lineage). Stamped at ingest (immutable).
export const DatasetSourceRefSchema = z.object({
  // WHERE THE ROWS CAME FROM, and a kind this cannot name is a lineage stamped as something it is not.
  // `terminal-bench` is its own kind for that reason: a task set is not "pasted jsonl", and the reader that
  // answers "where did these cases come from" has no other field to learn it from.
  kind: z.enum(["huggingface", "jsonl", "terminal-bench"]),
  dataset: z.string().optional(), // HF: org/name
  config: z.string().optional(), // HF config
  split: z.string().optional(), // HF split
  file: z.string().optional(), // repo file for the viewer-not-serving fallback (e.g. officeqa_pro.csv)
  url: z.string().optional(), // canonical link (HF dataset page)
});
export type DatasetSourceRef = z.infer<typeof DatasetSourceRefSchema>;

// The official source of a published benchmark (if any) — homepage/paper/code/data/leaderboard/authors/license/citation/task type.
// Comes from BenchmarkOrigin (@everdict/datasets) (when a recipe/catalog fills it). Display/citation metadata.
export const DatasetOriginSchema = z.object({
  homepage: z.string().optional(),
  paper: z.string().optional(),
  code: z.string().optional(),
  data: z.string().optional(),
  leaderboard: z.string().optional(),
  authors: z.string().optional(),
  license: z.string().optional(),
  citation: z.string().optional(),
  taskType: z.string().optional(),
});
export type DatasetOrigin = z.infer<typeof DatasetOriginSchema>;

// Dataset provenance — how it was built (registered recipe / catalog / inline spec) + original data source (lineage) + official provenance.
// via/id/version = back-reference (dataset → the recipe that made it); source/origin = lineage (where the data came from, which benchmark).
export const DatasetProvenanceSchema = z.object({
  via: z.enum(["recipe", "catalog", "spec"]),
  id: z.string(), // recipe id | catalog id | inline spec id
  version: z.string().optional(), // recipe version (if any) — the exact version for the detail back-link
  source: DatasetSourceRefSchema.optional(), // original data source (HF etc.) — stamped at ingest
  origin: DatasetOriginSchema.optional(), // official benchmark provenance (when provided by a recipe/catalog)
  // WHAT A SCORE OVER THESE CASES IS (arch-review 16 P2-8). Several first-party benchmarks cannot run their
  // OFFICIAL evaluator here — it needs the benchmark's own database and plan schema, which a harness-agnostic
  // runtime cannot host — so the adapter scores the same constraints with a judge. Every such adapter says so
  // in its description, and a description is not something a trend, an export or a release report can read.
  // Carried as data so a proxy number cannot be rendered as "the TREK score" by a surface that never saw the
  // paragraph. Absent = UNSTATED, never a claim of comparability.
  scoring: z
    .object({
      kind: z.enum(["official", "proxy"]),
      approximates: z.string().optional(), // what the proxy stands in for
      officialEvaluator: z.string().optional(), // what to run to reproduce the official number
      license: z.string().optional(),
    })
    .optional(),
});
export type DatasetProvenance = z.infer<typeof DatasetProvenanceSchema>;

export const DatasetSchema = z.object({
  id: z.string(),
  version: VersionSchema,
  description: z.string().optional(),
  cases: z.array(EvalCaseSchema),
  tags: z.array(z.string()).default([]),
  producedBy: DatasetProvenanceSchema.optional(), // ingest provenance (if any). Older datasets leave it unset.
});
export type Dataset = z.infer<typeof DatasetSchema>;

// A cross-version diff — one field's before/after (display strings). Represents changes to case fields (task/env/graders/…)
// and dataset metadata (description/tags) in the same shape.
export const DatasetFieldChangeSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
});
export type DatasetFieldChange = z.infer<typeof DatasetFieldChangeSchema>;

// Case reference (lightweight, for showing additions/removals) — id + task only.
export const DatasetCaseRefSchema = z.object({ id: z.string(), task: z.string() });

// The structural diff of two dataset versions (base↔candidate) — per-case added/removed/changed + dataset metadata changes.
// Immutable-version premise: match two versions of the same id by case id and report what changed (the basis for reproducible comparison).
export const DatasetDiffSchema = z.object({
  id: z.string(),
  base: z.string(), // resolved base version (e.g. "1.0.0")
  candidate: z.string(), // resolved candidate version
  meta: z.array(DatasetFieldChangeSchema), // dataset-level: description / tags
  added: z.array(DatasetCaseRefSchema), // cases only in candidate
  removed: z.array(DatasetCaseRefSchema), // cases only in base
  changed: z.array(z.object({ id: z.string(), changes: z.array(DatasetFieldChangeSchema) })),
  unchanged: z.number().int(), // count of identical cases
  summary: z.object({
    added: z.number().int(),
    removed: z.number().int(),
    changed: z.number().int(),
    unchanged: z.number().int(),
  }),
});
export type DatasetDiff = z.infer<typeof DatasetDiffSchema>;
