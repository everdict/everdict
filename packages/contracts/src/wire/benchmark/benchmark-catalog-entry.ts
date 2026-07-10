import { z } from "zod";

// GET /benchmarks 200 — first-party catalog summary. Mirrors listBenchmarks() (@everdict/datasets catalog.ts).
export const BenchmarkCatalogEntrySchema = z.object({
  id: z.string(),
  category: z.string(),
  source: z.enum(["huggingface", "jsonl"]).describe("huggingface = fetch by id, jsonl = needs a file upload"),
  gated: z.boolean().describe("True when the HF source requires an HF_TOKEN secret"),
  defaultVersion: z.string(),
  description: z.string(),
});
export type BenchmarkCatalogEntry = z.infer<typeof BenchmarkCatalogEntrySchema>;

export const BenchmarkCatalogResponseSchema = z.array(BenchmarkCatalogEntrySchema);
export type BenchmarkCatalogResponse = z.infer<typeof BenchmarkCatalogResponseSchema>;
