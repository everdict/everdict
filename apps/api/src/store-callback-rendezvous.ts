import type { CallbackStore } from "@everdict/db";
import type { CallbackSink, CallbackRendezvous as OutboundRendezvous } from "@everdict/topology";

// Store-backed callback rendezvous — the multi-replica form of InProcessCallbackRendezvous
// (docs/architecture/completion-stream-callback.md). The inbound POST /frontdoor-callback/:runId may land on a
// replica that isn't driving the run: deliver() persists to the shared store, and the driving replica's wait()
// polls a CLAIM (atomic single-consume) until its timeout. Same object implements both roles, so the route and
// the topology backend wire it exactly like the in-process one.
export class StoreCallbackRendezvous implements OutboundRendezvous, CallbackSink {
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly store: CallbackStore,
    opts: { pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.pollMs = opts.pollMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  url(runId: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${runId}`;
  }

  deliver(runId: string, body: unknown): void {
    // Fire-and-forget persist — the route replies 202 regardless (the waiter's claim is the consumer).
    void this.store.deliver(runId, body).catch(() => {});
  }

  async wait(runId: string, timeoutMs: number): Promise<{ body: unknown } | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const claimed = await this.store.claim(runId).catch(() => undefined);
      if (claimed) return claimed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await this.sleep(Math.min(this.pollMs, remaining));
    }
  }
}
