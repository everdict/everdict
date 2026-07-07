import type { CallbackRendezvous } from "./front-door-driver.js";

// The inbound (receiving) side of callback — the HTTP receiver (control-plane route / self-hosted runner) calls this on a matching POST.
// Role-separated from the outbound (driver) side CallbackRendezvous (url/wait): one instance implements both to pair up within a single process.
export interface CallbackSink {
  deliver(runId: string, body: unknown): void;
}

// in-process callback rendezvous — for the callback completion model. Queues the inbound POST body per run and hands it to the waiter (driver).
// Transport (HTTP receive) is separated: the receiver (self-hosted runner / control-plane) takes the matching POST and calls deliver(runId, body).
// For a single host/process (self-hosted, dev). SaaS implements the same interface with a control-plane endpoint + a store.
// Design: docs/architecture/completion-stream-callback.md.
export class InProcessCallbackRendezvous implements CallbackRendezvous, CallbackSink {
  // runId → queue of not-yet-consumed inbound bodies (when a POST arrives before its waiter).
  private readonly pending = new Map<string, unknown[]>();
  // runId → pending resolver (when a waiter arrives before its POST). One waiter per run (a single driver).
  private readonly waiters = new Map<string, (body: unknown) => void>();

  constructor(private readonly baseUrl: string) {}

  url(runId: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${runId}`;
  }

  // Deliver an inbound POST — called by the receiver. Wake the waiter immediately if present, otherwise queue (order preserved).
  deliver(runId: string, body: unknown): void {
    const waiter = this.waiters.get(runId);
    if (waiter) {
      this.waiters.delete(runId);
      waiter(body);
      return;
    }
    const queue = this.pending.get(runId) ?? [];
    queue.push(body);
    this.pending.set(runId, queue);
  }

  // Wait for the next inbound POST. Return immediately if already queued, otherwise wait up to timeoutMs (undefined on timeout).
  async wait(runId: string, timeoutMs: number): Promise<{ body: unknown } | undefined> {
    const queue = this.pending.get(runId);
    if (queue && queue.length > 0) {
      const body = queue.shift();
      if (queue.length === 0) this.pending.delete(runId);
      return { body };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(runId) === onBody) this.waiters.delete(runId);
        resolve(undefined);
      }, timeoutMs);
      const onBody = (body: unknown): void => {
        clearTimeout(timer);
        resolve({ body });
      };
      this.waiters.set(runId, onBody);
    });
  }
}
