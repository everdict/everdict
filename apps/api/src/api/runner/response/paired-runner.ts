import { z } from "zod";
import { RunnerMetaSchema } from "./runner-meta.js";

// Pairing response (POST /runners, POST /workspace/runners) — the ONLY place the plaintext rnr_ token exists.
// It is stored as a SHA-256 hash and never shown again; the `everdict runner` process authenticates with it.
export const PairedRunnerResponseSchema = z.object({
  runner: RunnerMetaSchema,
  token: z.string().describe("Plaintext pairing token (rnr_…) — returned exactly once; only a hash is stored"),
});
