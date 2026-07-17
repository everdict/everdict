import { z } from "zod";
import { RunnerMetaSchema } from "./runner-meta.js";

// Pairing response (POST /runners, POST /workspace/runners) — the ONLY place the plaintext rnr_ token exists.
// It is stored as a SHA-256 hash and never shown again; the `everdict runner` process authenticates with it.
export const PairedRunnerResponseSchema = z.object({
  runner: RunnerMetaSchema,
  token: z.string().describe("Plaintext pairing token (rnr_…) — returned exactly once; only a hash is stored"),
  attachCommand: z
    .string()
    .optional()
    .describe(
      "Ready-to-run `everdict runner --pair …` command that attaches a headless runner (workspace-shared / headless personal) — token embedded, shown once. Omitted for desktop one-click pairing (the token is handed to the app, never displayed).",
    ),
  installCommand: z
    .string()
    .optional()
    .describe(
      "One-line `curl … /install.sh?token=… | sh` bootstrap that installs the standalone everdict-runner binary AND pairs the machine — for a headless host that has no everdict. Same one-time token as attachCommand.",
    ),
});
export type PairedRunnerResponse = z.infer<typeof PairedRunnerResponseSchema>;
