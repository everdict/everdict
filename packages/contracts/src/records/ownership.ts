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
  // enforces the structural invariants (observer/diagnostician/verifier write NOTHING).
  capabilities: z.object({
    read: z.array(z.string()).default([]),
    write: z.array(z.string()).default([]),
  }),
  // Which provenance scopes this role's context may draw from (context separation — O3's axis).
  contextScopes: z.array(z.string()).default([]),
  // The evidence the role MUST leave behind to finish — completion without evidence is a claim, not a result.
  requiredEvidence: z.array(z.enum(["trace", "diff", "scorecard", "checkpoint", "report"])).default([]),
  completion: RoleCompletionSchema,
});
export type RoleProfile = z.infer<typeof RoleProfileSchema>;

// A role PLUS the actor holding it — the unit the independence invariant is stated over. A bare RoleProfile
// cannot answer "is the verifier someone else?", so every check that separation matters to takes this.
export const RoleAssignmentSchema = z.object({
  profile: RoleProfileSchema,
  actor: ActorRefSchema,
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

// ── O5: the task envelope ────────────────────────────────────────────────────────────────────────────
export const TaskEnvelopeSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  role: OwnershipRoleSchema.optional(), // the RoleProfile this task runs as (absent = unprofiled legacy task)
  scope: z.object({
    allowedCapabilities: z.array(z.string()).min(1), // an envelope with no capabilities is not a task
    // Deny-precedence: a capability both allowed and forbidden is FORBIDDEN — the safer reading always wins.
    forbidden: z.array(z.string()).default([]),
  }),
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

// ── O5 decisions (pure, beside the contract — the isMeasured precedent) ──────────────────────────────
export type EnvelopeDecision =
  | { allowed: true }
  // Refusals are DATA the runtime acts on — refuse_and_replan (build a new plan + risk analysis and request
  // approval / hand off), never a soft warning a loop can ignore.
  | { allowed: false; reason: "forbidden" | "out_of_scope"; action: "refuse_and_replan" };

export function envelopeAllows(envelope: TaskEnvelope, capabilityId: string): EnvelopeDecision {
  // Deny precedence: forbidden beats allowed — when a capability appears on both lists, the safer reading wins.
  if (envelope.scope.forbidden.includes(capabilityId))
    return { allowed: false, reason: "forbidden", action: "refuse_and_replan" };
  if (!envelope.scope.allowedCapabilities.includes(capabilityId))
    return { allowed: false, reason: "out_of_scope", action: "refuse_and_replan" };
  return { allowed: true };
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
