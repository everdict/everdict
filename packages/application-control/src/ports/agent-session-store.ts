import type {
  AgentMessageRecord,
  AgentPermissionMode,
  AgentRunStatus,
  AgentSessionRecord,
  AgentTeammateConfig,
  AgentWakeIntent,
} from "@everdict/contracts";

// Persistence for Everdict's own agent conversations. Sessions are owner-scoped (a member's own chat history)
// within a workspace; messages form an append-only, seq-ordered transcript per session. async — Postgres honors
// the same contract. See docs/architecture/agent-conversations.md.
export interface AgentSessionStore {
  createSession(record: AgentSessionRecord): Promise<void>;
  getSession(tenant: string, owner: string, id: string): Promise<AgentSessionRecord | undefined>;
  // Visibility-aware lookup: the session when `subject` is its owner OR it is workspace-visible
  // (visibility === "workspace", e.g. a comment-thread discussion session any member may read/continue).
  // The owner path behaves exactly like getSession; owner-only surfaces (list/rename/delete) keep getSession.
  getVisibleSession(tenant: string, subject: string, id: string): Promise<AgentSessionRecord | undefined>;
  // Newest first (updatedAt descending) — the owner's own sessions in this workspace.
  listSessions(tenant: string, owner: string): Promise<AgentSessionRecord[]>;
  // Bump updatedAt (activity) and optionally set the title (e.g. first user message → session title).
  touchSession(tenant: string, id: string, updatedAt: string, title?: string): Promise<void>;
  // Set the conversation's model override (null clears it → falls back to the workspace/server default) and bump updatedAt.
  setSessionModel(tenant: string, id: string, model: string | null, updatedAt: string): Promise<void>;
  // Set the conversation's standing permission mode (null clears it → "default": ask for every mutation) and bump updatedAt.
  setSessionPermissionMode(
    tenant: string,
    id: string,
    mode: AgentPermissionMode | null,
    updatedAt: string,
  ): Promise<void>;
  // Set the session's running memory: the digest of the oldest span + the highest message seq it covers, and bump
  // updatedAt. The next turn replays memory + only the messages AFTER throughSeq (bounded replay for long
  // conversations). Maintained by the chat host at turn boundaries; only ever moves forward.
  setSessionMemory(tenant: string, id: string, memory: string, throughSeq: number, updatedAt: string): Promise<void>;
  // Headless-run lifecycle transition (agent-automation A4) — owned by the agent service's activation wrapper.
  setSessionStatus(tenant: string, id: string, status: AgentRunStatus, updatedAt: string): Promise<void>;
  // Point the session at its LATEST ledger run (P3 — an activation/turn = a Run{kind:"agent"}).
  setSessionRunId(tenant: string, id: string, runId: string, updatedAt: string): Promise<void>;
  // The fleet view (agent-automation A5): every session with an origin (= every agent RUN, newest first),
  // workspace-wide — unlike listSessions, which is a member's own chat history.
  listRuns(tenant: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]>;
  // Arm or clear a conversation's wake intent (LESSON 051). Set when a turn ends with stopReason "waiting" — the
  // agent parked itself on an event; cleared the moment the conversation is resumed. Persisting the intent (rather
  // than holding a timer in memory) is what makes the promise survive an agent-service restart.
  setSessionWakeIntent(tenant: string, id: string, intent: AgentWakeIntent | null, updatedAt: string): Promise<void>;
  // Atomically CLAIM a parked conversation: clear its wake intent and report whether this caller is the one that
  // cleared it. An arriving event and the deadline sweep (or two service replicas) can select the same session at
  // the same instant; exactly one of them may resume it. The loser sees false and stands down — a wake intent is a
  // one-shot claim, not a subscription.
  claimWakeIntent(tenant: string, id: string, updatedAt: string): Promise<boolean>;
  // Every conversation in this workspace currently waiting on the world, so an arriving event (or the deadline
  // sweep) can find the ones it should resume. Workspace-wide and small by nature — one row per parked agent.
  listWaitingSessions(tenant: string): Promise<AgentSessionRecord[]>;
  // Every waiting conversation across ALL workspaces whose deadline has passed at `now` — the restart-proof sweep
  // (W3): a job that dies without emitting a terminal fact must never strand its watcher.
  listExpiredWakeIntents(now: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]>;
  // Standing permission rules (LESSON 059 P4): replace the session's tool→allow|deny rule set — written
  // through on every rule change so "always allow" survives a service restart (the in-memory PermissionRules
  // map is the hot path; this row is its durability).
  setSessionPermissionRules(
    tenant: string,
    id: string,
    rules: Record<string, "allow" | "deny">,
    updatedAt: string,
  ): Promise<void>;
  // Teammate durability (LESSON 059 P2): stamp or clear a session's standing-teammate config — the durable
  // half of the roster (the execution token stays process-memory and is re-minted on restore; `keyId` is what
  // lets the restore revoke the stale key). null = the teammate was dismissed.
  setSessionTeammate(tenant: string, id: string, config: AgentTeammateConfig | null, updatedAt: string): Promise<void>;
  // Every session carrying a teammate config, across ALL workspaces — the boot restore's read (cross-tenant
  // like the other reapers: an operator-side scan, small by nature — one row per standing teammate).
  listTeammateSessions(opts?: { limit?: number }): Promise<AgentSessionRecord[]>;
  // Crash reconcile (LESSON 059 P0): every headless run stranded in status "running" from BEFORE `before` —
  // a previous process died mid-turn, so nothing in-process will ever settle them. `before` is the sweeping
  // process's boot instant: anything newer is owned by a live in-process activation whose own try/catch
  // settles it. Cross-tenant like listExpiredWakeIntents — an operator-side reaper, not a workspace read.
  listOrphanedRuns(before: string, opts?: { limit?: number }): Promise<AgentSessionRecord[]>;
  // Atomically CLAIM one stranded run: settle it as "failed" only while it is still "running" AND still stale
  // (updatedAt < before), reporting whether this caller won — concurrent sweepers (or the run settling by
  // itself) collapse to exactly one claim, the same one-shot shape as claimWakeIntent. The claimer then tries
  // to RESUME the session (a continuation turn flips it back to running and settles it for real); an
  // unresumable one stays "failed" — fail-closed: never left "running", never silently re-activated. Recovery
  // works by resumption, NOT by re-activation, because the durable (agent, event) dedup keys on the session's
  // existence: deduping on "did this start?" while recovering on "did this finish?" is what turned a crash
  // into a permanently-blocked activation.
  claimOrphanedRun(tenant: string, id: string, before: string, updatedAt: string): Promise<boolean>;
  // Durable activation dedup (agent-automation A3): has this crafted agent already run for this platform event?
  // At-least-once delivery (push + reconcile) collapses here, surviving agent-service restarts.
  hasTriggerSession(tenant: string, agentId: string, eventId: string): Promise<boolean>;
  // The dedup's read side (T-d): a reaction-step retry needs the EXISTING run back, not just a boolean —
  // the returned session's id/status let the durable executor keep watching instead of double-running.
  findTriggerSession(tenant: string, agentId: string, eventId: string): Promise<AgentSessionRecord | undefined>;
  deleteSession(tenant: string, owner: string, id: string): Promise<void>;
  appendMessages(records: AgentMessageRecord[]): Promise<void>;
  // Oldest first (seq ascending). With sinceSeq, only messages whose seq is strictly greater (polling).
  listMessages(tenant: string, sessionId: string, sinceSeq?: number): Promise<AgentMessageRecord[]>;
}
