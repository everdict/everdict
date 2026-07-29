import { type ApprovalRecord, NotFoundError } from "@everdict/contracts";
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
  }): Promise<{ record: ApprovalRecord; delivered: boolean }> {
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
    const record = updated ?? { ...current, ...transition.patch };
    const delivered = (await this.deps.deliver?.(record, input.decision).catch(() => false)) ?? false;
    return { record, delivered };
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

  // Deny-on-expiry — called by the approval workflow's timer (T-a). Already-settled asks skip silently.
  async expire(id: string): Promise<ApprovalRecord | undefined> {
    const record = await this.deps.store.get(id);
    if (!record || !Approval.from(record).isPending()) return record;
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
