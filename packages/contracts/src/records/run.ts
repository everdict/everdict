import { z } from "zod";
import { CaseResultSchema, EvalCaseSchema } from "../execution/eval-case.js";
import { RunUsageSummarySchema } from "../execution/trace.js";

// A run's lifecycle: accept → (scheduler queue/dispatch) → success/failure. The result store keeps this record.
// `suspended` = stopped WITHOUT completing, resumably (an agent run halting at its envelope budget, or
// parking on an armed wait). Settled like a terminal state — nothing rewrites the row, and it never counts
// as in-flight — but the claim it makes is "not done yet", never "succeeded": a resume is a NEW run on the
// ledger (the continuation-leg rule), so the suspended row stays the honest record of where work stopped.
export const RunStatusSchema = z.enum(["queued", "running", "suspended", "succeeded", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// SETTLED — the statuses whose outcome nothing may rewrite ("first terminal write wins"). Here rather than in
// the domain guard that reads it, because the STORE has to state the same rule in SQL: the guard runs in a
// process, and two processes racing to settle one run is exactly the case a process-local check cannot decide.
// One list, two enforcement sites, no chance of them drifting into two different definitions of "done".
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "suspended"] as const satisfies readonly RunStatus[];

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
  // WHO actually performed the work (`agent:<id>` for an agent run) — a RECORDED creation-time fact, never
  // inferred. `actor`/`createdBy` are the PRINCIPAL (the member the work acts as and is attributed to);
  // re-deriving the executor out of attribution is what let an agent pass as independent of its own work
  // (member:kim ≠ agent:fixer). Absent = the principal executed in person (a member's own run).
  executor: z.string().optional(),
  scheduleId: z.string().optional(),
  eventId: z.string().optional(),
  eventKind: z.string().optional(),
  causedByRunId: z.string().optional(),
});
export type RunOrigin = z.infer<typeof RunOriginSchema>;

// The budget this run draws from (and delegates to runs it causes) — spoken name: the CAUSAL BUDGET.
// P0 stamps it; P4 enforces it (admitCausedWork). NOT the TaskEnvelope (records/ownership.ts — the
// AUTONOMY BOUNDARY the agent kernel enforces): different budget vocabularies, different enforcement
// points, different persistence, one unlucky shared word — and on an agent activation both key on the run
// id, which is exactly why the names must not blur. See the naming note beside TaskEnvelopeSchema.
export const RunEnvelopeSchema = z.object({
  id: z.string(),
  // capUsd = the METERED realized-cost stop (O7: meter + headroom, never a reservation); capRuns = the HARD
  // atomic fan-out cap (claim-first request admission, H6). Enforced in admitCausedWork.
  capUsd: z.number().nonnegative().optional(),
  // RESERVED — DECLARED BUT NOT ENFORCED (H10): no admission path reads capTokens and no DTO can set it
  // today. It stays in the schema as the named token-budget dimension so stamped envelopes stay forward-
  // compatible, but a value here bounds NOTHING — do not present it as a limit until an enforcement point
  // exists (usage metering already records tokens; the gate does not).
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
  // A `command` run's own verdict. A non-zero exit is a RESULT the row keeps (the standing rule for running a
  // file), not a failed run — `failed` is reserved for "we could not run it at all". Kept here rather than in
  // a new column because it is exactly what this kind of run left behind.
  exitCode: z.number().int().optional(),
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
  // Agent worlds (W1): a WORLD session belongs to an environment capability whose versions are image
  // snapshots of this session's filesystem — the durable half of the compute (the container may die; the
  // world persists and the next session boots from its latest snapshot). On the ROW (not just process
  // memory) so the crash-path reaper can still hibernate an orphan through its computeId.
  world: z.string().optional(), // the environment capability id this session snapshots into
  hibernate: z.boolean().optional(), // auto-snapshot at teardown (close/expiry) instead of losing the state
  snapshots: z.array(z.object({ version: z.string(), image: z.string(), at: z.string() })).optional(), // what this session published (capability version + digest-pinned ref), append-only
  // W2: the repository cloned into this session at create — what the working tree IS, and where. No
  // credential ever lands here: a read token is used for the clone and discarded, and a push mints its own.
  repo: z.object({ git: z.string(), ref: z.string().optional(), dir: z.string() }).optional(),
  // W3 loop guard: the agent this session acts for. On the ROW because teardown can happen in a LATER
  // process (the crash-path reaper), and a fact emitted there must carry the same `causedBy` the creation
  // one did — otherwise an orphaned autonomous session's hibernate becomes an event its own agent wakes on.
  agent: z.object({ agentId: z.string(), conversationId: z.string().optional() }).optional(),
  // Playground conversation mode: the session's turns continue ONE conversation (stable workdir + harness
  // resume / session-stable front-door wiring) instead of running independent cases. Set at boot, never flips.
  conversation: z.boolean().optional(),
});
export type RunSession = z.infer<typeof RunSessionSchema>;

export const RunRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  // 이 결과를 만든 팀. 자산과 같은 축이라 "우리 팀이 무엇을 평가했나"를 하네스를 전부 훑지 않고
  // 답할 수 있다. 선택적인 이유는 팀 도입 이전 행과 소유자 없는 실행이 실재하기 때문 — 없음은
  // "모두의 것"이 아니라 "소유자 없음"이다.
  teamId: z.string().optional(),
  harness: z.object({ id: z.string(), version: z.string() }),
  caseId: z.string(),
  status: RunStatusSchema,
  result: CaseResultSchema.optional(),
  // The submitted EvalCase (standalone runs, mig 0051) — boot recovery's re-dispatch basis. Absent on batch
  // children (the batch re-plans from its dataset) and on legacy records (those keep the tombstone path).
  caseSpec: EvalCaseSchema.optional(),
  // Usage summary — not stored, derived from result.trace (filled on read). Lets the client see tokens/cost without parsing the trace.
  usage: RunUsageSummarySchema.optional(),
  // Case verdict — not stored, derived by the APPLICATION query layer (RunService.withVerdicts), never by
  // the DB adapter: which policy judged a record is a domain interpretation a persistence concern cannot
  // know. A standalone run is judged under the live default ladder (it has no stamp by construction); a
  // scorecard CHILD is judged under its PARENT's stamped/composed policy, so the run detail and the
  // scorecard case dialog answer identically about the same evidence. SERVED, never recomputed by a client
  // (the client-side mirrors were deleted in re-architecture P1g — one authority, one answer).
  // Undefined = nothing decided it (no pass-bearing grader, a kind that is not scored, or a child whose
  // parent policy could not be restored — fail-closed, never a silent re-judgement under today's ladder).
  verdict: z.boolean().optional(),
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
  // WHO may read this run — a CREATION-TIME FACT, not an inference. The class-based rule it supersedes was
  // right for today's two cases (background activation = fleet observability, interactive turn = one
  // member's conversation) but class is SCHEDULING semantics: a background personal assistant or an
  // interactive team agent breaks the inference, and privacy must not be decided by a priority knob.
  // Absent = legacy row → runAudience's class/kind fallback (conservative).
  visibility: z.enum(["workspace", "member"]).optional(),
  lifetime: RunLifetimeSchema.optional(), // task (ends by itself) | session (held open)
  origin: RunOriginSchema.optional(), // structured WHY (supersedes the free-string trigger; both stamped)
  envelope: RunEnvelopeSchema.optional(), // the budget drawn from — stamped now, enforced at P4
  placement: RunPlacementSchema.optional(), // whose compute, how isolated
  attach: z.array(RunAttachChannelSchema).optional(), // channels the run exposes while alive
  group: RunGroupRefSchema.optional(), // the orchestration this run belongs to (generalizes parentScorecardId)
  lineage: RunLineageSchema.optional(), // retry/rescore/fork relations to earlier runs
  outputs: RunOutputsSchema.optional(), // what it left behind (artifacts/files/summary)
  session: RunSessionSchema.optional(), // session runs only (P6, mig 0099): image + hard deadline + teardown reason
  // WHICH control-plane replica is driving this run (mig 0135, docs/architecture/multi-replica.md). Stamped by
  // the store at create and re-stamped by whoever claims the run for resume, so boot recovery can tell work
  // whose owner is DEAD from work another live replica is still driving. Absent = written before the column
  // existed (or by the in-memory store), which recovery treats as unowned and reclaims as it always did.
  // A random per-boot id, never a hostname — it identifies a process, it does not describe the infrastructure.
  ownerReplica: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
