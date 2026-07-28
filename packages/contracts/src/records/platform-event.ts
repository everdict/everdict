import { z } from "zod";

// Platform events — immutable FACTS the control plane records at lifecycle points (docs/architecture/agent-automation.md).
// One recorded fact feeds three readers: the personal feed / Mattermost (via NotificationService), the agent service
// (trigger matching wakes subscribed agents), and the event log itself (audit + replay-into-a-draft-agent).
// Facts only — inference ("regressed", "flaky") is the agent's job; the control plane never emits a judgment.
// The vocabulary is CLOSED (add a kind here when a new emit point ships — never emit an ad-hoc string).
export const PLATFORM_EVENT_KINDS = [
  "run.submitted",
  "run.completed",
  "run.failed",
  "scorecard.submitted",
  "scorecard.case.completed", // one case of a streaming batch finished — payload carries caseId + verdict
  "scorecard.completed",
  "scorecard.failed",
  "scorecard.cancelled",
  "report.completed", // a scheduled analysis report was produced (analysis-studio V4)
  "comment.created",
  // Agent-run lifecycle facts (reported BY the agent service) — observable in the feed/fleet view, but NEVER
  // trigger-matchable in v1 (agents watching agents is a runaway vector; see the loop-prevention guardrails).
  "agent.run.started",
  "agent.run.awaiting_approval",
  "agent.run.completed",
  "agent.run.failed",
] as const;
export const PlatformEventKindSchema = z.enum(PLATFORM_EVENT_KINDS);
export type PlatformEventKind = z.infer<typeof PlatformEventKindSchema>;

// What the fact is about — a pointer, never the document. Detail is read back through the normal (RBAC-gated)
// tools at consumption time, so authorization stays authoritative at read time, not emit time.
export const PlatformEventSubjectSchema = z.object({
  type: z.string().min(1), // "scorecard" | "run" | "comment" | "agent_session" | …
  id: z.string().min(1),
});
export type PlatformEventSubject = z.infer<typeof PlatformEventSubjectSchema>;

export const PlatformEventRecordSchema = z.object({
  id: z.string(),
  // Store-assigned monotonic cursor (per deployment) — the agent service reconciles missed events with
  // `seq > lastSeen` (at-least-once + id dedup), so delivery needs no broker.
  seq: z.number().int().nonnegative(),
  tenant: z.string(),
  kind: PlatformEventKindSchema,
  subject: PlatformEventSubjectSchema,
  actor: z.string().optional(), // the subject (user / agent principal) whose action produced the fact
  // Minimal pointers only (ids + status + counts) — never full documents (see subject note above).
  payload: z.record(z.unknown()).default({}),
  // Provenance: the agent run whose action caused this fact. Trigger matching skips events caused by the
  // same agent (loop prevention) unless that agent opted into self-cause chains.
  causedBy: z.string().optional(),
  message: z.string(), // one-line human/agent-readable rendering (what a woken agent reads first)
  createdAt: z.string(),
});
export type PlatformEventRecord = z.infer<typeof PlatformEventRecordSchema>;
