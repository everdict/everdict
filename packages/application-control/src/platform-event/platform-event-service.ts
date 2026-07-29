import type { PlatformEventRecord } from "@everdict/contracts";
import type { AgentEventSink } from "../ports/agent-event-sink.js";
import type { EmitPlatformEventInput, PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { PlatformEventListOptions, PlatformEventStore } from "../ports/platform-event-store.js";

export interface PlatformEventServiceDeps {
  store?: PlatformEventStore; // unset → facts are not persisted (push-only, dev without a DB)
  agentEvents?: AgentEventSink; // unset → no agent push (log still writes)
  newId?: () => string;
  now?: () => string;
}

// The ONE emit seam for platform facts (docs/architecture/agent-automation.md A1): append to the durable event
// log, then push to the agent service — both best-effort, so emitting a fact can NEVER affect the business
// result it describes. Everything Everdict monitors calls this; the feed/Mattermost user notifications stay in
// NotificationService (a reader beside the log, not a replacement).
export class PlatformEventService implements PlatformEventEmitter {
  private readonly newId: () => string;
  private readonly nowIso: () => string;

  constructor(private readonly deps: PlatformEventServiceDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.nowIso = deps.now ?? (() => new Date().toISOString());
  }

  // Push-only for E0 outbox events: the fact is ALREADY in the log (persisted atomically with the state
  // change by the store); this only nudges the live consumers, with the persisted id so dedup holds.
  async pushPersisted(events: Array<{ record: Omit<PlatformEventRecord, "seq">; recipient?: string }>): Promise<void> {
    if (!this.deps.agentEvents) return;
    for (const { record, recipient } of events) {
      try {
        await this.deps.agentEvents.emit({
          workspace: record.tenant,
          ...(recipient !== undefined ? { recipient } : {}),
          kind: record.kind,
          source: `${record.subject.type} ${record.subject.id}`,
          message: record.message,
          eventId: record.id,
          subject: record.subject,
          payload: record.payload ?? {},
          ...(record.causedBy !== undefined ? { causedBy: record.causedBy } : {}),
        });
      } catch {
        // Push is a latency optimization; the cursor reconcile is the correctness path.
      }
    }
  }

  // Record + push one fact. Returns the appended record (with its seq) when the log is configured — callers
  // that don't need the cursor ignore it. Never throws.
  async emit(input: EmitPlatformEventInput): Promise<PlatformEventRecord | undefined> {
    const id = this.newId();
    let appended: PlatformEventRecord | undefined;
    if (this.deps.store) {
      try {
        appended = await this.deps.store.append({
          id,
          tenant: input.workspace,
          kind: input.kind,
          subject: input.subject,
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          payload: input.payload ?? {},
          ...(input.causedBy !== undefined ? { causedBy: input.causedBy } : {}),
          message: input.message,
          createdAt: this.nowIso(),
        });
      } catch {
        // The log is an observer of the business result, never a participant.
      }
    }
    if (this.deps.agentEvents) {
      try {
        await this.deps.agentEvents.emit({
          workspace: input.workspace,
          ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
          kind: input.kind,
          source: `${input.subject.type} ${input.subject.id}`,
          message: input.message,
          eventId: appended?.id ?? id,
          subject: input.subject,
          payload: input.payload ?? {},
          ...(input.causedBy !== undefined ? { causedBy: input.causedBy } : {}),
        });
      } catch {
        // An unreachable agent service never affects the result.
      }
    }
    return appended;
  }

  // Cursor read for the agent service's reconcile loop (and the fleet/replay surfaces). Ascending by seq.
  list(workspace: string, opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]> {
    return this.deps.store?.list(workspace, opts) ?? Promise.resolve([]);
  }

  // Deployment-wide cursor walk (no tenant filter) — the agent service's single global reconcile loop.
  listAll(opts?: PlatformEventListOptions): Promise<PlatformEventRecord[]> {
    return this.deps.store?.listAll(opts) ?? Promise.resolve([]);
  }

  get(workspace: string, id: string): Promise<PlatformEventRecord | undefined> {
    return this.deps.store?.get(workspace, id) ?? Promise.resolve(undefined);
  }
}
