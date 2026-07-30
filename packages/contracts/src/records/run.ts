import { z } from "zod";
import { CaseResultSchema, EvalCaseSchema } from "../execution/eval-case.js";
import { RunUsageSummarySchema } from "../execution/trace.js";

// A run's lifecycle: accept → (scheduler queue/dispatch) → success/failure. The result store keeps this record.
export const RunStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunErrorSchema = z.object({ code: z.string(), message: z.string() });

// ─── The universal-run shape (execution-model.md P0) ────────────────────────────────────────────────────────
// A Run is ONE activation of some executable — an eval case today; agent activations, sandbox commands and
// analysis runs join the same ledger later. These fields are ADDITIVE and stamped at create; absent on a legacy
// row means "an eval run from before the shape existed". Nothing here is enforced yet (enforcement is the P4
// admission gate) — P0 only makes the ledger able to SAY what ran, why, at what priority, and on whose budget.

// One row per executable family. Eval keeps its dedicated columns (harness/caseId) — the kind names the family.
export const RUN_KINDS = ["eval", "agent", "command", "sandbox", "analysis"] as const;
export const RunKindSchema = z.enum(RUN_KINDS);
export type RunKind = z.infer<typeof RunKindSchema>;

// Scheduling class (CaseJob's interactive|batch, made uniform + the agent-caused default). interactive = a
// person is waiting; background = agent/event-caused work that must never starve a human's click; batch = fan-out.
export const RunClassSchema = z.enum(["interactive", "background", "batch"]);
export type RunClass = z.infer<typeof RunClassSchema>;

// Does the run end by itself (task), or is it held open until closed/expired (session — a sandbox shell, a
// live browser)? `running` stops meaning "in progress" once sessions exist; lifetime is the discriminator.
export const RunLifetimeSchema = z.enum(["task", "session"]);
export type RunLifetime = z.infer<typeof RunLifetimeSchema>;

// WHY this run exists — the structured successor of the free-string `trigger` (which stays, dual-stamped, for
// the activity view's legacy source axis). `causedByRunId` makes causation a first-class edge: the run tree is
// the demand graph, the audit trail, and (from P4) the budget-envelope chain and the cascade-cancel scope.
export const RunOriginSchema = z.object({
  cause: z.enum(["member", "schedule", "event", "run", "ci", "api"]),
  actor: z.string().optional(), // the member subject behind the cause, when there is one
  scheduleId: z.string().optional(),
  eventId: z.string().optional(),
  eventKind: z.string().optional(),
  causedByRunId: z.string().optional(),
});
export type RunOrigin = z.infer<typeof RunOriginSchema>;

// The budget this run draws from (and delegates to runs it causes). P0 stamps it; P4 enforces it.
export const RunEnvelopeSchema = z.object({
  id: z.string(),
  capUsd: z.number().nonnegative().optional(),
  capTokens: z.number().int().nonnegative().optional(),
  capRuns: z.number().int().nonnegative().optional(),
});
export type RunEnvelope = z.infer<typeof RunEnvelopeSchema>;

// Whose compute, how isolated. A field rather than a property of the kind, so the same run can move up the
// ladder (driver → runtime) without changing what it is.
export const RunPlacementSchema = z.object({
  where: z.enum(["inline", "driver", "runtime"]),
  target: z.string().optional(), // runtime id / self:<runnerId> — mirrors placement.target
  isolation: z.string().optional(),
});
export type RunPlacement = z.infer<typeof RunPlacementSchema>;

// Channels this run exposes while alive (the live-observability attach surfaces, generalized).
// "tasks" = a harness session accepts ad-hoc test-case submissions (the playground channel).
export const RunAttachChannelSchema = z.enum(["logs", "exec", "terminal", "screen", "cdp", "tasks"]);
export type RunAttachChannel = z.infer<typeof RunAttachChannelSchema>;

// The orchestration this run belongs to — a scorecard's case, a conversation's turn, a generic child.
// Generalizes parentScorecardId (which stays for the eval surfaces).
export const RunGroupRefSchema = z.object({
  id: z.string(),
  role: z.enum(["case", "turn", "child"]),
});
export type RunGroupRef = z.infer<typeof RunGroupRefSchema>;

// How this run relates to earlier runs of the same work — the context-accumulation axis.
export const RunLineageSchema = z.object({
  retryOf: z.string().optional(),
  rescoreOf: z.string().optional(),
  forkedFrom: z.string().optional(),
});
export type RunLineage = z.infer<typeof RunLineageSchema>;

// What the run left behind, beyond its CaseResult — the join point agents analyze. Grows with P5/P6.
export const RunOutputsSchema = z.object({
  artifacts: z.array(z.string()).optional(), // artifact-store refs
  files: z.array(z.string()).optional(), // workspace-filesystem paths the run published
  summary: z.string().optional(),
});
export type RunOutputs = z.infer<typeof RunOutputsSchema>;

// The session half of a `lifetime: "session"` run (execution-model.md P6, mig 0099): disposal is the
// invariant, so every session carries its hard deadline ON THE RECORD — a reaper that finds the process
// gone can still tear down on time from the row alone. `image` is the concrete container image the session
// booted (the harness column names what the user ASKED for — an environment capability or an ad-hoc image).
export const RunSessionSchema = z.object({
  image: z.string(),
  ttlSec: z.number().int().positive(),
  expiresAt: z.string(), // hard deadline — extended by touch, never removed
  computeId: z.string().optional(), // driver-level compute id (container id) — the reaper's teardown key after a crash
  closedReason: z.enum(["closed", "expired", "orphaned"]).optional(), // stamped at teardown
});
export type RunSession = z.infer<typeof RunSessionSchema>;

export const RunRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: RunStatusSchema,
  result: CaseResultSchema.optional(),
  // The submitted EvalCase (standalone runs, mig 0051) — boot recovery's re-dispatch basis. Absent on batch
  // children (the batch re-plans from its dataset) and on legacy records (those keep the tombstone path).
  caseSpec: EvalCaseSchema.optional(),
  // Usage summary — not stored, derived from result.trace (filled on read). Lets the client see tokens/cost without parsing the trace.
  usage: RunUsageSummarySchema.optional(),
  error: RunErrorSchema.optional(),
  // Which scorecard batch this run is a child of (if any). Filled by the scorecard as it fans out a child run per case.
  // Unset = standalone (one-off) run. The activity list hides children by default (prevents flooding) → see the list option.
  parentScorecardId: z.string().optional(),
  // Why this run was created (source). standalone|scorecard|schedule|mcp|front-door etc. — the activity-view source axis.
  // A dumb store, so the value itself isn't validated (free string). Unset = standalone.
  trigger: z.string().optional(),
  // Runner (submitter subject) — the notification-feed recipient (notifications N2) + shows "who". Machine-fired is unset. mig 0036.
  createdBy: z.string().optional(),
  // The runtime it was placed on (placement.target: registered runtime id | self:<runnerId>) — the work-queue's "where does it run" axis. mig 0040.
  // Unset = default backend. Past records are unset.
  runtime: z.string().optional(),
  // ── The universal-run shape (execution-model.md P0, mig 0092) — additive; absent = legacy eval run. ──
  kind: RunKindSchema.optional(), // executable family; readers treat undefined as "eval"
  class: RunClassSchema.optional(), // scheduling class (interactive | background | batch)
  lifetime: RunLifetimeSchema.optional(), // task (ends by itself) | session (held open)
  origin: RunOriginSchema.optional(), // structured WHY (supersedes the free-string trigger; both stamped)
  envelope: RunEnvelopeSchema.optional(), // the budget drawn from — stamped now, enforced at P4
  placement: RunPlacementSchema.optional(), // whose compute, how isolated
  attach: z.array(RunAttachChannelSchema).optional(), // channels the run exposes while alive
  group: RunGroupRefSchema.optional(), // the orchestration this run belongs to (generalizes parentScorecardId)
  lineage: RunLineageSchema.optional(), // retry/rescore/fork relations to earlier runs
  outputs: RunOutputsSchema.optional(), // what it left behind (artifacts/files/summary)
  session: RunSessionSchema.optional(), // session runs only (P6, mig 0099): image + hard deadline + teardown reason
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
