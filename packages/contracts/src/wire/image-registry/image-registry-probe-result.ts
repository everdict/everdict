import { z } from "zod";

// POST /workspace/image-registries/probe 200 — the connection-test outcome (host answers as a Docker Registry v2
// API + the resolved credential authenticates). Mirrors ImageRegistryProbeResult (execution/image-registry-probe.ts)
// and is the parse boundary the web drift-guards against. A classified failure (reason set, reachable=false) is
// still a 200 — the same convention as trace-probe / runtime-probe.
export const ImageRegistryProbeResultSchema = z.object({
  reachable: z.boolean(),
  detail: z.string().describe("Human-readable probe detail"),
  reason: z
    .enum(["auth", "unreachable", "error"])
    .optional()
    .describe("Structured failure class — absent when reachable"),
  credential: z
    .enum(["push", "pull", "anonymous"])
    .describe("Which configured credential the probe authenticated with (single-credential test — push preferred)"),
});
export type ImageRegistryProbeResult = z.infer<typeof ImageRegistryProbeResultSchema>;
