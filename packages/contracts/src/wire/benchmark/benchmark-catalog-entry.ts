import { z } from "zod";

// GET /benchmarks 200 — first-party catalog summary. Mirrors listBenchmarks() (@everdict/datasets catalog.ts).
// What a score over this benchmark's cases IS — `official` means the entry runs the benchmark's own evaluator and
// the number is leaderboard-comparable; `proxy` means the same constraints scored another way (an everdict-internal
// regression signal, never a leaderboard number). Absence is UNSTATED, never a comparability claim.
export const BenchmarkScoringSemanticsSchema = z.object({
  kind: z.enum(["official", "proxy"]),
  approximates: z.string().optional().describe("For proxy: what it approximates and what would make it official"),
  officialEvaluator: z.string().optional().describe("The evaluator that WOULD produce the official number"),
  license: z.string().optional().describe("The benchmark's published data/code license"),
});

export const BenchmarkCatalogEntrySchema = z.object({
  id: z.string(),
  category: z.string(),
  source: z.enum(["huggingface", "jsonl"]).describe("huggingface = fetch by id, jsonl = needs a file upload"),
  gated: z.boolean().describe("True when the HF source requires an HF_TOKEN secret"),
  defaultVersion: z.string(),
  description: z.string(),
  scoring: BenchmarkScoringSemanticsSchema.optional(),
  officialJudge: z
    .object({ id: z.string(), description: z.string(), officialEvaluator: z.string() })
    .optional()
    .describe("Pointer to the shipped official scorer — fetch its body from GET /benchmarks/:id/judge"),
});
export type BenchmarkCatalogEntry = z.infer<typeof BenchmarkCatalogEntrySchema>;

export const BenchmarkCatalogResponseSchema = z.array(BenchmarkCatalogEntrySchema);
export type BenchmarkCatalogResponse = z.infer<typeof BenchmarkCatalogResponseSchema>;

// GET /benchmarks/:id/judge 200 — the benchmark's own evaluator, shaped as the code judge a workspace registers.
export const BenchmarkJudgeResponseSchema = z.object({
  kind: z.literal("code"),
  id: z.string(),
  version: z.string(),
  language: z.literal("node"),
  description: z.string(),
  code: z.string(),
});
export type BenchmarkJudgeResponse = z.infer<typeof BenchmarkJudgeResponseSchema>;
