import type { PlatformEventRecord } from "@everdict/contracts";
import type { EventConsumerStateStore } from "../ports/event-consumer-store.js";
import type { PlatformEventStore } from "../ports/platform-event-store.js";

// One log, N durable cursors (event-plumbing.md E1): each consumer walks the deployment-wide event log at
// its own persisted position. Delivery is AT-LEAST-ONCE — a crash between handle and cursor-save redelivers,
// and a deliberate rewind (replay) redelivers everything — so effects must be idempotent via natural keys
// (e.g. a feed row keyed by the event id). A poison event dead-letters after maxAttempts and the cursor
// moves on: one bad fact never dams the log. Polling is the correctness path; nudge() is the latency
// optimization (in-process push today; Pg LISTEN/NOTIFY is the multi-replica rung).
export interface PlatformEventConsumer {
  name: string;
  kinds?: string[]; // restrict to these kinds (store-side filter); unset = every fact
  handle(event: PlatformEventRecord): Promise<void>;
}

export interface EventConsumerRunnerDeps {
  events: PlatformEventStore;
  state: EventConsumerStateStore;
  intervalMs?: number; // poll cadence (default 3s — the bell already client-polls at this order)
  batch?: number; // events per poll per consumer (default 200)
  maxAttempts?: number; // immediate retries per event before dead-lettering (default 3)
  onDeadLetter?: (consumer: string, event: PlatformEventRecord, error: string) => void; // observability hook
}

export class EventConsumerRunner {
  private readonly consumers: PlatformEventConsumer[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  constructor(private readonly deps: EventConsumerRunnerDeps) {}

  register(consumer: PlatformEventConsumer): void {
    this.consumers.push(consumer);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.deps.intervalMs ?? 3_000);
    this.timer.unref?.(); // never hold the process open for the poll loop
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // The latency nudge — push paths call this after persisting; the next poll would catch up anyway.
  nudge(): void {
    void this.drain();
  }

  // One full pass over every consumer (also the test/nudge entry). Re-entrancy-guarded: an overlapping
  // poll tick must not double-deliver within one process.
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const consumer of this.consumers) {
        await this.runConsumer(consumer).catch(() => {
          // a store outage mid-walk — the persisted cursor makes the next tick resume exactly here
        });
      }
    } finally {
      this.draining = false;
    }
  }

  // Per-consumer lag (latest seq − cursor) — the first-class backpressure observable (§ delivery semantics:
  // the log is a buffer; backpressure shows up as cursor lag, never as dropped facts).
  async lag(): Promise<Record<string, number>> {
    const latest = (await this.deps.events.listAll({ limit: 1, order: "desc" }))[0]?.seq ?? 0;
    const out: Record<string, number> = {};
    for (const consumer of this.consumers) {
      const cursor = await this.deps.state.getCursor(consumer.name);
      out[consumer.name] = Math.max(0, latest - cursor);
    }
    return out;
  }

  private async runConsumer(consumer: PlatformEventConsumer): Promise<void> {
    const batch = this.deps.batch ?? 200;
    // Keep walking until the consumer catches up (bounded per batch — a long backlog drains across passes).
    for (;;) {
      const cursor = await this.deps.state.getCursor(consumer.name);
      const events = await this.deps.events.listAll({
        afterSeq: cursor,
        ...(consumer.kinds ? { kinds: consumer.kinds } : {}),
        limit: batch,
        order: "asc",
      });
      if (events.length === 0) return;
      for (const event of events) {
        await this.deliver(consumer, event);
        // Cursor per event: a crash redelivers at most ONE event (idempotent effects absorb it).
        await this.deps.state.setCursor(consumer.name, event.seq);
      }
      if (events.length < batch) return;
    }
  }

  private async deliver(consumer: PlatformEventConsumer, event: PlatformEventRecord): Promise<void> {
    const attempts = Math.max(1, this.deps.maxAttempts ?? 3);
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await consumer.handle(event);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    // Poison event: park it visibly and move on — the dead letter is the honest record, not a silent skip.
    await this.deps.state
      .recordDeadLetter({
        consumer: consumer.name,
        eventId: event.id,
        seq: event.seq,
        error: lastError,
        createdAt: new Date().toISOString(),
      })
      .catch(() => {});
    this.deps.onDeadLetter?.(consumer.name, event, lastError);
  }
}
