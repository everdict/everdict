import type { DispatchOptions, Dispatcher } from "@everdict/backends";
import { AppError, type CaseJob, type CaseResult, type TraceEvent } from "@everdict/contracts";

// The CONTROL-PLANE half of the infra-plane trace record. The backends already seal their own account
// (Nomad/K8s: submitted → blocked → placed → task events; the topology backend: ready → seed → target → drive;
// the runner lane: leased → finished), but everything BEFORE a backend sees the job — accepting the dispatch,
// which target it is routed to, how long it waited in the Scheduler queue, and every waiting diagnostic
// (runner offline, placement blocked) — happened only in callbacks and log lines. This decorator records that
// segment as `infra` events and prepends it to the result's trace, so a sealed trajectory starts at "the
// control plane accepted this case", not at the cluster's first sighting of it.
//
// One seam for every path (single runs, scorecard cases, judges) — wired around the shared dispatcher in
// composition/dispatch.ts, OUTSIDE RuntimeDispatcher so the recorded target is the name the user chose
// (the runtime id / self:<runner>), not the rewritten internal backend name.
export class TraceRecordingDispatcher implements Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    // Live tee (observability ⑨, optional): each mark ALSO lands in the live-trace buffer keyed by the CP-minted
    // job.runId, so the run detail's live view opens with the dispatch account before any agent event arrives.
    // The prepend below stays the durable record; this is the same events' preview.
    private readonly live?: { append: (runId: string, events: TraceEvent[]) => void },
  ) {}

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    const t0 = Date.now();
    const events: TraceEvent[] = [];
    const messages: string[] = []; // the string plane that rides a failure throw as evidence (classifyFailure → placement.events)
    const mark = (event: string, message: string): void => {
      const now = Date.now();
      messages.push(message);
      const traceEvent: TraceEvent = {
        t: Math.max(0, now - t0),
        kind: "infra",
        scope: "placement",
        event,
        message,
        at: new Date(now).toISOString(),
      };
      events.push(traceEvent);
      if (job.runId) this.live?.append(job.runId, [traceEvent]);
    };
    const target = job.evalCase.placement?.target ?? "default";
    mark("accepted", `case accepted by the control plane — target ${target}`);
    const wrapped: DispatchOptions = {
      ...opts,
      // Waiting reasons (runner offline, placement blocked, capacity wait) used to flow only through the
      // callback — record them on the trace too. A backend that seals the same verdict as its own event
      // (Nomad blocked) words it differently, so both planes keep it as fact.
      onWaiting: (reason) => {
        if (messages[messages.length - 1] !== reason) mark("waiting", reason);
        opts?.onWaiting?.(reason);
      },
      // The moment the job leaves the scheduler queue and the backend starts submitting — queue wait time is fixed here.
      onStarted: () => {
        mark("started", `left the dispatch queue after ${Date.now() - t0}ms — the backend is submitting`);
        opts?.onStarted?.();
      },
    };
    try {
      const result = await this.inner.dispatch(job, wrapped);
      return { ...result, trace: [...events, ...result.trace] };
    } catch (err) {
      // Failure evidence rides the throw (backends rule): attach the control-plane marks under placement.events
      // (merging after any backend-captured lines) so failedCaseResult seals them too. Best-effort — extra is a
      // readonly reference, so an error thrown without one keeps only its own account.
      if (err instanceof AppError && err.extra) {
        const extra = err.extra as Record<string, unknown>;
        const placement =
          extra.placement !== null && typeof extra.placement === "object"
            ? (extra.placement as Record<string, unknown>)
            : {};
        const existing = Array.isArray(placement.events)
          ? placement.events.filter((e): e is string => typeof e === "string")
          : [];
        extra.placement = { ...placement, events: [...messages, ...existing] };
      }
      throw err;
    }
  }
}
