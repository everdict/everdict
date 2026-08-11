import { z } from "zod";

// The ownership kernel (trust-kernel O-track, O2/O5/O6) — ownership as a verifiable, transferable PROTOCOL,
// not an imitated person. Three contracts:
//   RoleProfile      — what a role may touch and what "done" means for it (O2: the separations that matter
//                      are role · context · capability · evidence · completion — never "which model").
//   TaskEnvelope     — the decision boundary an autonomous task runs inside (O5: real autonomy is knowing
//                      when to STOP; exceeding scope is a refusal + replan, never quiet continuation).
//   HandoffCheckpoint — a resumable state transfer (O6: a successor decides its next action from evidence
//                      references, not from the predecessor's prose).
// docs: digo-edu reference everdict-ownership-protocol-aplus-queries (B2/B5/B6 acceptance queries).

// ── O2: roles ────────────────────────────────────────────────────────────────────────────────────────
export const OWNERSHIP_ROLES = [
  "observer", // watches systems/runs/issues — never changes anything
  "diagnostician", // assembles evidence into problem/cause hypotheses
  "planner", // writes the change plan + risks + validation + rollback
  "executor", // performs approved changes inside its envelope
  "verifier", // independently checks outcomes — NEVER the actor being checked
  "operator", // deploy/retry/quarantine/recover — runbook actions
  "coordinator", // splits work and hands it to agents or people
] as const;
export const OwnershipRoleSchema = z.enum(OWNERSHIP_ROLES);
export type OwnershipRole = z.infer<typeof OwnershipRoleSchema>;

// What a role's completion MEANS — its 종료조건 vocabulary. An executor finishing is a change_set (its own
// claim); only a verifier's completion is a verified_verdict (the separation invariant lives in the domain
// validator: an executor may not have verified_verdict as its completion).
export const RoleCompletionSchema = z.enum([
  "report", // observer/diagnostician: what was seen / what is believed and why
  "plan", // planner: the change plan artifact
  "change_set", // executor: the changes made — a CLAIM, verified by someone else
  "verified_verdict", // verifier: the independent check's outcome
  "recovery", // operator: the system restored/contained
  "handoff", // coordinator: work distributed with checkpoints
]);
export type RoleCompletion = z.infer<typeof RoleCompletionSchema>;

// ── O3: WHO holds a role ─────────────────────────────────────────────────────────────────────────────
// A role is not a person, and separation needs both halves: the profile says what the role may do, the
// actor says who is doing it. Without this, "the actor never finally judges its own work" is unprovable —
// two profiles can differ while one process wears them both, which is exactly self-verification with extra
// steps. `id` is the identity the platform already stamps elsewhere (a member subject, or `agent:<agentId>`);
// sessionId/runId narrow it to the concrete execution, so "same actor" and "same context" are both decidable.
export const ActorRefSchema = z.object({
  id: z.string().min(1), // member subject, or agent:<agentId>
  sessionId: z.string().optional(), // the conversation/session the work ran in
  runId: z.string().optional(), // the run/execution the work ran as
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const RoleProfileSchema = z.object({
  role: OwnershipRoleSchema,
  // Capability separation: what this role may READ vs WRITE (capability/tool ids). The domain validator
  // enforces the structural invariants (observer/diagnostician/verifier write NOTHING). `read` mirrors the
  // envelope scope's vocabulary — "all" (unrestricted senses, the executor posture) or an explicit list —
  // so the delegation invariant (assertEnvelopeForRole: an envelope's scope never exceeds its role's
  // ceiling) is decidable without translating between two dialects of the same concern.
  capabilities: z.object({
    read: z.union([z.literal("all"), z.array(z.string())]).default([]),
    write: z.array(z.string()).default([]),
  }),
  // (Context separation has NO field here on purpose — see the note under RoleProfile below.)
  // The evidence the role MUST leave behind to finish — completion without evidence is a claim, not a result.
  requiredEvidence: z.array(z.enum(["trace", "diff", "scorecard", "checkpoint", "report"])).default([]),
  completion: RoleCompletionSchema,
});
export type RoleProfile = z.infer<typeof RoleProfileSchema>;

// Why there is no `contextScopes` here. It existed — `string[]`, "which provenance scopes this role's context
// may draw from" — and nothing ever read it, including the validator right below. Two findings retired it
// rather than wiring it:
//   ① There is no context-ASSEMBLY point to filter. Knowledge, memory and skills do not arrive as a
//      pre-built bundle of classes; the agent PULLS each through a tool it decides to call
//      (get_task_context / use_skill / get_file). The only thing injected unasked is the environment block:
//      workspace, model, date, paths. There is no set of context classes for a role to select among.
//   ② The job it named is done by the envelope's scope. "What may this role draw on" is which tools it may
//      call, which is exactly `TaskEnvelope.scope.reads` — a role that must see evidence only (a verifier,
//      a diagnostician) gets an explicit read list; the default executor posture is `reads: "all"` (reads
//      are the agent's senses). The kernel honors BOTH halves on every call (authorizeToolInvocation) and
//      sub-agents inherit the read scope. A second vocabulary for the same concern would be a false
//      guarantee, not a weaker one.
// The spawn site that fills `scope.reads` is `verifierEnvelopeFor` (@everdict/domain), composed by
// `CheckpointService.requestVerification`; TRUST-31 drives that envelope through both kernel guards. What is
// still unbound is the RUNNER — the `VerifierRunner` port has no implementation, so a deployment that has not
// written one gets a refusal ("verification is a human act here"), never a silent auto-pass.

// A role PLUS the actor holding it — the unit the independence invariant is stated over. A bare RoleProfile
// cannot answer "is the verifier someone else?", so every check that separation matters to takes this.
export const RoleAssignmentSchema = z.object({
  profile: RoleProfileSchema,
  actor: ActorRefSchema,
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

// ── O5: the task envelope — spoken name: the AUTONOMY BOUNDARY ──────────────────────────────────────
// Two unrelated contracts share the word "envelope" and, on an agent activation, even one ID (both key on
// the run id). Keep the CONCEPTS apart by name: a TaskEnvelope is the AUTONOMY BOUNDARY one autonomous task
// runs inside (goal, tool scope, hard budgets, stop/escalation, rollback — enforced by the agent kernel,
// never persisted); a RunEnvelope (records/run.ts) is the CAUSAL BUDGET a run delegates to the work it
// causes (capUsd/capRuns — enforced at the control plane's admission gate, persisted as a spend ledger).
// "An agent run executes inside an AutonomyBoundary; caused work draws from its CausalBudget." The symbol
// rename itself is deferred to a wire-breaking version — the language is not.
// The scope names BOTH halves of what the task may touch, because the runtime enforces both halves:
//   reads  — "all" (the default executor posture: reads are the agent's senses) or an explicit capability
//            list (a verifier/diagnostician sees evidence tools only — context separation as code).
//   writes — the effectful capabilities this task was explicitly granted. An observer/verifier task has [].
// A single `allowedCapabilities` list USED to claim both jobs while the kernel enforced it for writes only —
// a type stating a stronger guarantee than the runtime gave. The legacy shape still parses (reads "all",
// writes = the old list) so in-flight payloads keep validating.
const TaskScopeSchema = z
  .object({
    reads: z.union([z.literal("all"), z.array(z.string())]),
    writes: z.array(z.string()),
    // Deny-precedence: a capability both granted and forbidden is FORBIDDEN — the safer reading always wins.
    forbidden: z.array(z.string()).default([]),
    // WHICH OBJECTS, as opposed to which tools (arch-review 10 P1). `reads`/`writes`/`forbidden` are
    // CAPABILITY names — the strings `authorizeToolInvocation` compares against `tool.name`. "The verifier may
    // see run-42 and scorecard-7" is a different sentence, and putting it in `reads` broke both halves at
    // once: the resource ids matched no tool, so the verifier could call nothing at all, and the guarantee
    // "evidence only" was never enforced because nothing ever compared a tool's TARGET to anything.
    //
    // Absent = no object-level restriction (the executor posture): the capability lists alone decide, which
    // is exactly today's behavior for every envelope that does not set this.
    resources: z.array(z.object({ type: z.string().min(1), id: z.string().min(1) })).optional(),
  })
  .refine((s) => s.reads === "all" || s.reads.length > 0 || s.writes.length > 0, {
    message: "an envelope that may read nothing and write nothing is not a task",
  });
export const TaskEnvelopeSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  role: OwnershipRoleSchema.optional(), // the RoleProfile this task runs as (absent = unprofiled legacy task)
  scope: z.preprocess((value) => {
    if (value !== null && typeof value === "object" && "allowedCapabilities" in (value as Record<string, unknown>)) {
      const legacy = value as { allowedCapabilities: unknown; forbidden?: unknown };
      return { reads: "all", writes: legacy.allowedCapabilities, forbidden: legacy.forbidden ?? [] };
    }
    return value;
  }, TaskScopeSchema),
  // At least one hard budget — an unbounded autonomous task has no decision boundary (domain-validated).
  budgets: z.object({
    timeSec: z.number().int().positive().optional(),
    tokens: z.number().int().positive().optional(),
    usd: z.number().positive().optional(),
  }),
  // What exhaustion does. halt_checkpoint is the only vocabulary: stop AND leave a resumable checkpoint —
  // dying silently mid-task is the exact failure the envelope exists to prevent.
  stop: z.object({
    onBudgetExhausted: z.literal("halt_checkpoint"),
    maxTurns: z.number().int().positive().optional(),
  }),
  // What scope-exceeding does. refuse_and_replan is the only vocabulary: real autonomy is knowing when to
  // stop — proceeding anyway is never an option the type system offers.
  escalation: z.object({
    onScopeExceeded: z.literal("refuse_and_replan"),
    approvers: z.array(z.string()).optional(), // who can approve the replanned scope (absent = workspace admins)
  }),
  rollbackRequired: z.boolean().default(false),
});
export type TaskEnvelope = z.infer<typeof TaskEnvelopeSchema>;

// ── O6: the handoff checkpoint ───────────────────────────────────────────────────────────────────────
export const CheckpointRefSchema = z.object({
  type: z.enum(["run", "scorecard", "commit", "issue", "trace", "file"]),
  id: z.string().min(1),
  // What admission actually CHECKED about this reference — stamped by the checkpoint service, never by the
  // producer (a forged value is overwritten at admission). "verified" = a platform resolver confirmed the
  // record exists; "unverified_external" = no resolver exists for this type (an outside git remote, a
  // tenant-platform trace) and the ref is carried as the unverified pointer it is. The split keeps
  // "evidence-backed" and "evidence-VERIFIED" distinct claims — a successor weighing a fact reads which one
  // it holds. Absent = written before the stamp existed (the reader abstains, never guesses).
  resolution: z.enum(["verified", "unverified_external"]).optional(),
});
export type CheckpointRef = z.infer<typeof CheckpointRefSchema>;

export const HandoffCheckpointSchema = z.object({
  id: z.string().min(1),
  envelopeId: z.string().optional(), // the TaskEnvelope this checkpoint suspends/hands off
  // The role the predecessor was working AS. Envelopes are not persisted, so without this the checkpoint
  // cannot say whether it carries an executor's claim or a verifier's verdict — and the independence check
  // has nothing to key on. Absent = unprofiled work (the legacy shape).
  role: OwnershipRoleSchema.optional(),
  goal: z.string().min(1),
  currentState: z.string().min(1),
  // The facts/hypotheses SPLIT is the checkpoint's core: a "fact" carries at least one evidence reference —
  // a statement without evidence IS a hypothesis, and the schema refuses to let it claim otherwise.
  confirmedFacts: z.array(
    z.object({
      statement: z.string().min(1),
      refs: z.array(CheckpointRefSchema).min(1),
    }),
  ),
  hypotheses: z.array(
    z.object({
      statement: z.string().min(1),
      confidence: z.enum(["low", "medium", "high"]).optional(),
    }),
  ),
  actionsTaken: z.array(z.object({ description: z.string().min(1), refs: z.array(CheckpointRefSchema).default([]) })),
  openDecisions: z.array(z.string()).default([]),
  remainingTasks: z.array(z.string()).default([]),
  requiredCapabilities: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  validationPlan: z.string().min(1), // how the successor verifies the work — a checkpoint without one is a hope
  rollbackPlan: z.string().optional(), // required by the domain validator when the envelope demands rollback
  // The machine-executable way back into the exact state — "re-read the whole conversation" is not a plan.
  reproduction: z.object({ command: z.string().min(1) }).optional(),
  createdAt: z.string(),
  createdBy: z.string(), // member subject or agent:<id>:<conversation> — the ATTRIBUTION string every record carries
  // The same producer as machine identity. `createdBy` is one opaque string a reader displays; `by` is what a
  // check compares, which is why both exist: "agent:fixer:conv-1" cannot be asked whether it is the actor that
  // executed run-42. Absent = written before actor identity existed (the check then abstains, never guesses).
  by: ActorRefSchema.optional(),
});
export type HandoffCheckpoint = z.infer<typeof HandoffCheckpointSchema>;

// The persisted checkpoint — the contract above plus the workspace it belongs to. A handoff is only useful if
// a successor can FIND it, and finding it means a store; the tenant is the isolation boundary every record in
// everdict carries, so it lives on the record rather than beside it.
export const HandoffCheckpointRecordSchema = HandoffCheckpointSchema.extend({
  tenant: z.string().min(1),
});
export type HandoffCheckpointRecord = z.infer<typeof HandoffCheckpointRecordSchema>;

// ── The VERIFICATION DECISION — a judgment, not a state transfer ─────────────────────────────────────
// A HandoffCheckpoint and a verification are related and are NOT the same aggregate (arch-review 10 §10):
//   · a checkpoint transfers RESUMABLE STATE from a predecessor to a successor;
//   · a verification is an INDEPENDENT ACTOR'S IMMUTABLE JUDGMENT about evidence.
// Storing the second as a variant of the first is the same category error `GateDecision` avoided by not being
// a field on `ScorecardRecord`: it makes "who verified this checkpoint, and did the verdict hold" a question
// answered by scanning for a checkpoint that happens to reference another one. Separated, the answer is a
// lookup — and the executor/verifier pair the independence invariant is stated over is a field of the record
// rather than something a reader re-derives.
//
// Immutable by construction: there is no update path. A verifier that changes its mind files a SECOND
// decision, because "the verdict was revised" and "the verdict was always this" are different histories.
export const VerificationDecisionSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  // WHAT was verified — the checkpoint (or other subject) whose claims were under review.
  subject: z.object({ type: z.enum(["checkpoint"]), id: z.string().min(1) }),
  // The EVIDENCE the verifier was given, and nothing else — the same list that became `scope.resources`.
  evidence: z.array(CheckpointRefSchema).min(1),
  // EVERY actor whose work this verdict covers, not one of them (arch-review 11). A checkpoint may cite
  // several runs, and they can have different executors: taking "the first run reference that resolves"
  // produced a decision that compared the verifier against agent A while agent B's own work sat in the same
  // evidence, unchecked — an independence claim with a hole exactly the size of the second executor. The
  // verifier is compared against ALL of them; empty means the linkage could not be resolved at all, which is
  // recorded as `independence: "abstained"` rather than guessed, so a reader can tell "independent" from
  // "we could not check".
  executors: z.array(ActorRefSchema).default([]),
  verifier: ActorRefSchema,
  verdict: z.enum(["verified", "refuted", "inconclusive"]),
  detail: z.string().min(1),
  // Whether the independence invariant was actually applied to EVERY actor in the evidence, to some of them,
  // or to none. `partial` exists because the two-state version collapsed partial knowledge into a binary and
  // the optimistic half won (arch-review 12): evidence citing run-A (resolvable) and run-B (linkage missing)
  // recorded `enforced` — true of A, unknown of B, and read by everyone as true of the verification.
  independence: z.enum(["enforced", "partial", "abstained"]),
  // WHICH internal run references could be turned into an actor and which could not. The counts are the
  // point: `enforced` means every internal run resolved, `partial` names the ones that did not, and a reader
  // can tell "checked" from "could not check" without re-deriving it.
  executorCoverage: z
    .object({
      runRefs: z.number().int().nonnegative(),
      unresolvedRunIds: z.array(z.string()).default([]),
    })
    .optional(),
  // WHAT THE VERIFIER ACTUALLY READ, reported by the RUNTIME rather than claimed by the model
  // (arch-review 12). The resource scope is an upper bound — "it could not look outside the evidence" — and a
  // verdict needs the lower bound too: that it looked INSIDE. Without this a verifier could answer from the
  // question alone, read one of four refs, or read none, and still return "verified".
  //   reviewed    — refs the kernel observed being fetched
  //   unreachable — refs offered as evidence that no wired tool can address (an external commit, a trace on
  //                 someone else's platform). Recorded, never silently dropped: they are the part of the
  //                 claim nobody checked.
  evidenceCoverage: z
    .object({
      offered: z.number().int().nonnegative(),
      reviewed: z.array(CheckpointRefSchema).default([]),
      // Reached for and FAILED — a 404, a timeout, a transport error (arch-review 14 §13). Structurally
      // distinct from `unreachable` (no tool can address it at all) and from never-attempted, because an
      // owner-agent reading this ledger mechanically must be able to tell "nobody looked" from "we looked and
      // the platform could not answer". It lived only in the decision's prose, which is not a field.
      failed: z.array(CheckpointRefSchema).default([]),
      unreachable: z.array(CheckpointRefSchema).default([]),
    })
    .optional(),
  envelopeId: z.string().optional(), // the verifier envelope this ran inside
  createdAt: z.string(),
  createdBy: z.string(), // who REQUESTED the verification (the verifier itself is `verifier` above)
});
export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;

// ── O5 decisions (pure, beside the contract — the isMeasured precedent) ──────────────────────────────
export type EnvelopeDecision =
  | { allowed: true }
  // Refusals are DATA the runtime acts on — refuse_and_replan (build a new plan + risk analysis and request
  // approval / hand off), never a soft warning a loop can ignore.
  | { allowed: false; reason: "forbidden" | "out_of_scope"; action: "refuse_and_replan" };

// THE tool-invocation decision — the one owner of "may this task call this tool". The runtime executes the
// answer verbatim; it never re-reads the scope underneath this function (the previous shape had the kernel
// discard out_of_scope for read tools, quietly narrowing `allowedCapabilities` to writes-only — a downstream
// reinterpretation of the invariant's own decision function). forbidden refuses regardless of access kind;
// reads check `scope.reads` ("all" = the executor posture); writes check `scope.writes`. A tool with no
// isReadOnly declaration is treated as a WRITE — unknown effects get the stricter gate, never the looser.
// `intrinsic` marks a KERNEL cognition tool (todo list, plan, sub-agent spawn, result paging, wait): part of
// how the agent thinks, not a workspace capability, so the scope lists do not govern it — an evidence-only
// verifier can still keep a todo list. An explicit `forbidden` entry still wins (deny precedence is total).
export function authorizeToolInvocation(
  tool: { name: string; isReadOnly?: boolean; intrinsic?: boolean },
  envelope: TaskEnvelope,
): EnvelopeDecision {
  const scope = envelope.scope;
  // Deny precedence: forbidden beats every grant — when a capability appears on both lists, the safer reading wins.
  if (scope.forbidden.includes(tool.name)) return { allowed: false, reason: "forbidden", action: "refuse_and_replan" };
  if (tool.intrinsic === true) return { allowed: true };
  if (tool.isReadOnly === true) {
    if (scope.reads === "all" || scope.reads.includes(tool.name)) return { allowed: true };
    return { allowed: false, reason: "out_of_scope", action: "refuse_and_replan" };
  }
  if (!scope.writes.includes(tool.name)) return { allowed: false, reason: "out_of_scope", action: "refuse_and_replan" };
  return { allowed: true };
}

// THE object-access decision — the SECOND guard, and a different question from the one above (arch-review 10
// P1). `authorizeToolInvocation` answers "may this task call get_scorecard?"; this answers "may it call it on
// sc-8?". A verifier holding `get_scorecard` and evidence `scorecard:sc-7` passes the first and must fail the
// second, and until the two lived apart the guarantee "a verifier sees the evidence and nothing else" had no
// enforcement anywhere — the evidence ids sat in the capability list, where they matched no tool name and
// governed no object.
//
// An envelope with no `resources` declares no object restriction and admits everything: the executor posture,
// and what every pre-existing envelope means. The list is a WHITELIST when present — fail-closed, because an
// evidence-scoped role that silently admitted an unlisted object would be the exact failure this closes.
export function authorizeResourceAccess(
  target: { type: string; id: string },
  envelope: TaskEnvelope,
): EnvelopeDecision {
  const resources = envelope.scope.resources;
  if (resources === undefined) return { allowed: true };
  if (resources.some((r) => r.type === target.type && r.id === target.id)) return { allowed: true };
  return { allowed: false, reason: "out_of_scope", action: "refuse_and_replan" };
}

export interface EnvelopeSpend {
  timeSec?: number;
  tokens?: number;
  usd?: number;
}

export type BudgetDecision =
  | { exhausted: false }
  | { exhausted: true; budget: "timeSec" | "tokens" | "usd"; action: "halt_checkpoint" };

export function budgetExhausted(envelope: TaskEnvelope, spent: EnvelopeSpend): BudgetDecision {
  const b = envelope.budgets;
  if (b.timeSec !== undefined && (spent.timeSec ?? 0) >= b.timeSec)
    return { exhausted: true, budget: "timeSec", action: "halt_checkpoint" };
  if (b.tokens !== undefined && (spent.tokens ?? 0) >= b.tokens)
    return { exhausted: true, budget: "tokens", action: "halt_checkpoint" };
  if (b.usd !== undefined && (spent.usd ?? 0) >= b.usd)
    return { exhausted: true, budget: "usd", action: "halt_checkpoint" };
  return { exhausted: false };
}
