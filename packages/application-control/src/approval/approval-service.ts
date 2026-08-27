import { type ApprovalRecord, ConflictError, NotFoundError } from "@everdict/contracts";
import { Approval } from "@everdict/domain";
import { stampFacts } from "../platform-event/outbox.js";
import type { ApprovalListFilter, ApprovalStore } from "../ports/approval-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";

// Durable agent approvals (agent-automation A6): the agent service PARKS here (create — the ask survives an
// agent-service restart as a record), members DECIDE here (decide — one audited settlement, first write wins),
// and the decision is DELIVERED back to the agent's in-process wait through the injected bridge. The days-long
// expiry belongs to the approval:<id> workflow (T-a), which calls expire(). Facts (approval.requested/decided)
// ride the E0 outbox via the Approval transitions.
export interface ApprovalServiceDeps {
  store: ApprovalStore;
  events?: PlatformEventEmitter; // pushPersisted latency nudge — the outbox rows are the durable half
  // CP→agent-service bridge: resolve the live in-process wait (requestId) with the decision. Returns false
  // when no live wait exists (the loop died — an agent-service restart; the continuation turn picks it up
  // in the A6 resume leg). Absent = record-only deployments (no agent service wired).
  deliver?: (approval: ApprovalRecord, decision: "approve" | "deny") => Promise<boolean>;
  // The durable WAIT (orchestration.md T-a): start approval:<id> at the park (deny-on-expiry timer that
  // survives every process), signal it on decide (prompt completion — correctness never depends on it,
  // expire skips a settled record). Absent = the local in-process timeout is the only expiry (rung-1 behavior).
  workflow?: {
    start(record: ApprovalRecord): Promise<void>;
    signalDecided(id: string): Promise<void>;
  };
  // The resume leg (A6): when delivery finds NO live wait (the loop died), ask the agent service to run a
  // continuation turn on the session, seeded with the decision. Returns whether a resume was started.
  resume?: (approval: ApprovalRecord, decision: "approve" | "deny", decidedBy?: string) => Promise<boolean>;
  newId?: () => string;
  now?: () => string;
}

export class ApprovalService {
  private readonly newId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // The park (called by the agent service over the internal bridge). ttlSec bounds the wait — the workflow's
  // deny-on-expiry timer reads expiresAt; default 7 days (the "approve it Monday" window the 10-minute
  // in-process park never had).
  async create(input: {
    tenant: string;
    sessionId: string;
    agentId?: string;
    requestId: string;
    request: { name: string; input?: unknown };
    ttlSec?: number;
  }): Promise<ApprovalRecord> {
    const now = this.now();
    const ttlMs = (input.ttlSec ?? 7 * 24 * 3600) * 1000;
    const record = Approval.newPending({
      id: this.newId(),
      tenant: input.tenant,
      sessionId: input.sessionId,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      requestId: input.requestId,
      request: input.request,
      expiresAt: new Date(new Date(now).getTime() + ttlMs).toISOString(),
      now,
    });
    const creation = stampFacts(record.tenant, Approval.creationFacts(record), {
      newId: this.newId,
      now: this.now,
    });
    await this.deps.store.create(
      record,
      creation.map((c) => c.record),
    );
    if (creation.length > 0) void this.deps.events?.pushPersisted?.(creation);
    // Durable expiry (T-a): best-effort — a Temporal outage never blocks the park (the agent's local
    // timeout still bounds the wait at expiresAt while its process lives).
    void this.deps.workflow?.start(record).catch(() => {});
    return record;
  }

  async list(tenant: string, filter?: ApprovalListFilter): Promise<ApprovalRecord[]> {
    return this.deps.store.list(tenant, filter);
  }

  async get(tenant: string, id: string): Promise<ApprovalRecord> {
    const record = await this.deps.store.get(id);
    if (!record || record.tenant !== tenant)
      throw new NotFoundError("NOT_FOUND", { approval: id }, "Approval not found.");
    return record;
  }

  // A member's decision: settle the record (409 if already settled — first write wins against the expiry
  // timer), then deliver to the live in-process wait. `delivered:false` = the loop is gone (restart) — the
  // record still holds the decision for the resume leg.
  async decide(input: {
    tenant: string;
    id: string;
    decision: "approve" | "deny";
    decidedBy?: string;
  }): Promise<{ record: ApprovalRecord; delivered: boolean; resumed: boolean }> {
    const current = await this.get(input.tenant, input.id);
    const transition = Approval.from(current).decide(
      input.decision,
      input.decidedBy !== undefined ? { actor: input.decidedBy } : {},
      this.now(),
    );
    const stamped = stampFacts(current.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      current.id,
      transition.patch,
      stamped.map((f) => f.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    // ── ZERO ROWS IS A REFUSAL, NOT A MISSING RETURN VALUE (arch-review 97) ─────────────────────────
    //
    // The UPDATE is fenced on `status = 'pending'` now, so `undefined` means somebody else decided this ask
    // between our read and our write. `updated ?? { ...current, ...transition.patch }` synthesized the
    // record we WANTED and carried on: the caller was told its decision landed, the delivery and resume legs
    // ran for a decision that does not exist, and the ask's real outcome was the other writer's.
    //
    // A decision that rests on a conditional write consumes its answer (rule `protocol` L1). This is the
    // same 409 a second decision gets from the aggregate — the race just makes it arrive later.
    if (updated === undefined)
      throw new ConflictError(
        "CONFLICT",
        { approval: current.id },
        "this approval was decided by somebody else — read it back for the decision that landed",
      );
    const record = updated;
    void this.deps.workflow?.signalDecided(record.id).catch(() => {}); // prompt workflow completion (best-effort)
    const delivered = (await this.deps.deliver?.(record, input.decision).catch(() => false)) ?? false;
    // The resume leg: no live wait → the run died with a restart; a continuation turn picks the decision up
    // from the transcript (the durable state). Best-effort — the decision itself is already settled above.
    const resumed = delivered
      ? false
      : ((await this.deps.resume?.(record, input.decision, input.decidedBy).catch(() => false)) ?? false);
    return { record, delivered, resumed };
  }

  // The agent side settling a park that was decided through the LEGACY in-process channel (POST /permission)
  // or that timed out locally — keeps the ledger convergent with the loop. Already-settled records skip
  // silently (the CP decide path got there first — that is the normal race, not an error).
  async settleFromAgent(input: {
    tenant: string;
    id: string;
    decision: "approve" | "deny";
  }): Promise<ApprovalRecord | undefined> {
    const record = await this.deps.store.get(input.id);
    if (!record || record.tenant !== input.tenant) return undefined;
    if (!Approval.from(record).isPending()) return record;
    const transition = Approval.from(record).decide(input.decision, {}, this.now());
    const stamped = stampFacts(record.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      record.id,
      transition.patch,
      stamped.map((f) => f.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    return updated;
  }

  // Deny-on-expiry — called by the approval workflow's timer (T-a). Already-settled asks skip silently;
  // tenant-scoped (the internal bridge carries the workflow's tenant — a mismatch reads as missing).
  async expire(input: { tenant: string; id: string }): Promise<ApprovalRecord | undefined> {
    const record = await this.deps.store.get(input.id);
    if (!record || record.tenant !== input.tenant) return undefined;
    if (!Approval.from(record).isPending()) return record;
    const transition = Approval.from(record).expire(this.now());
    const stamped = stampFacts(record.tenant, transition.facts, { newId: this.newId, now: this.now });
    const updated = await this.deps.store.update(
      record.id,
      transition.patch,
      stamped.map((f) => f.record),
    );
    if (stamped.length > 0) void this.deps.events?.pushPersisted?.(stamped);
    // The loop (if still alive) hears the deny through the delivery bridge — expiry must not hang it.
    if (updated) await this.deps.deliver?.(updated, "deny").catch(() => false);
    return updated;
  }
}
