import { z } from "zod";

// POST /runtimes/probe 200 — live connection-test outcome. Mirrors RuntimeProbeResult (core/ops/runtime-probe.ts).
export const ProbeRuntimeResultSchema = z.object({
  kind: z.string().describe("Runtime kind that was probed"),
  reachable: z.boolean(),
  detail: z.string().describe("Human-readable probe detail"),
  reason: z
    .enum(["auth", "unreachable", "error"])
    .optional()
    .describe("Structured failure class — absent when reachable"),
});
export type ProbeRuntimeResult = z.infer<typeof ProbeRuntimeResultSchema>;
