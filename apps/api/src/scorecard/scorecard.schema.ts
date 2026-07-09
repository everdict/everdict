import { JudgeRunConfigSchema } from "@everdict/core";
import { z } from "zod";

// Origin coordinates the submitter attaches (commit/PR/CI run) — origin.source is decided server-side from principal.via (client can't forge it).
export const ScorecardOriginBodySchema = z.object({
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(),
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(),
});

// Run-scorecard body — dataset×harness (version defaults to latest, the service resolves a concrete version) + selected judges.
// harness.pins = submit-time ephemeral pins (slot→image, registry unchanged) — a CI PR trigger swaps just one service image for the eval.
export const RunScorecardBodySchema = z.object({
  dataset: z.object({ id: z.string(), version: z.string().default("latest") }),
  harness: z.object({
    id: z.string(),
    version: z.string().default("latest"),
    pins: z.record(z.string()).optional(),
  }),
  origin: ScorecardOriginBodySchema.optional(),
  judges: z.array(z.object({ id: z.string(), version: z.string().default("latest") })).default([]),
  // tenant Runtime id to execute on (placement.target). A comma-separated list SHARDS the batch round-robin
  // across the listed runtimes (e.g. "nomad-seoul,k8s-east"); "auto" expands to every registered runtime.
  // Absent = default backend.
  runtime: z.string().optional(),
  judge: JudgeRunConfigSchema.optional(), // inline judge-grader scoring-model override (unset = workspace default)
  // concurrent case dispatches within a batch (runSuite parallelism). Unset = service default (=4). The Scheduler's
  // per-backend capacity + queue backpressure govern actual placement, so this mostly means "how many cases this
  // batch is willing to have in flight" — sized for cluster runtimes (nomad/k8s spread allocs across nodes).
  concurrency: z.number().int().min(1).max(512).optional(),
  // transient dispatch retries per case (throw-only — a failing eval result is never retried). Unset = 1.
  retries: z.number().int().min(0).max(5).optional(),
  // run each case N times for pass@k / flakiness (fans out N dispatches per case). Unset = 1 (single run). The
  // scorecard detail carries a derived trialSummary (pass@k / flake rate). docs/architecture/trial-based-verdict.md
  trials: z.number().int().min(1).max(100).optional(),
  // per-batch trace-sink override: a configured workspace sink name, or "none" to suppress export for this batch.
  // Unset = the harness's own selection. docs/architecture/trace-sink.md
  traceSink: z.string().min(1).optional(),
  // in-batch OOM auto-boost (opt-in — every boost re-runs the case): an OOM_KILLED case re-dispatches inside
  // the batch with doubled job-only memory up to the cap. docs/architecture/batch-resilience.md
  oomAutoBoost: z.boolean().optional(),
  // partial run — only a subset of the full dataset (cost/smoke). Applied in order: ids (explicit) → tags (any-match) → limit (first N).
  cases: z
    .object({
      ids: z.array(z.string().min(1)).min(1).optional(),
      tags: z.array(z.string().min(1)).min(1).optional(),
      limit: z.number().int().min(1).max(10_000).optional(),
    })
    .optional(),
});
