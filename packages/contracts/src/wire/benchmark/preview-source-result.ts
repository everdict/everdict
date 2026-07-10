import { z } from "zod";

// POST /benchmarks/preview 200 — N raw rows + detected fields before mapping (wizard field auto-detect).
export const PreviewSourceResultSchema = z.object({
  fields: z.array(z.string()).describe("Union of the keys detected across the previewed rows"),
  rows: z.array(z.record(z.unknown())).describe("Raw source rows (unmapped)"),
});
export type PreviewSourceResult = z.infer<typeof PreviewSourceResultSchema>;
