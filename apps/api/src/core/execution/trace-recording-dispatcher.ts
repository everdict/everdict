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
  constructor(private readonly inner: Dispatcher) {}

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    const t0 = Date.now();
    const events: TraceEvent[] = [];
    const messages: string[] = []; // 실패 throw 에 증거로 동반되는 문자열판 (classifyFailure → placement.events)
    const mark = (event: string, message: string): void => {
      const now = Date.now();
      messages.push(message);
      events.push({
        t: Math.max(0, now - t0),
        kind: "infra",
        scope: "placement",
        event,
        message,
        at: new Date(now).toISOString(),
      });
    };
    const target = job.evalCase.placement?.target ?? "default";
    mark("accepted", `case accepted by the control plane — target ${target}`);
    const wrapped: DispatchOptions = {
      ...opts,
      // 대기 사유(러너 오프라인·배치 blocked·용량 대기)는 콜백으로만 흐르던 진단 — 궤적에도 남긴다.
      // 백엔드가 같은 판정을 자기 이벤트로 봉인하는 경우(Nomad blocked)는 문구가 달라 두 평면 모두에 사실로 남는다.
      onWaiting: (reason) => {
        if (messages[messages.length - 1] !== reason) mark("waiting", reason);
        opts?.onWaiting?.(reason);
      },
      // 스케줄러 큐를 벗어나 백엔드가 제출을 시작한 순간 — 큐 대기 시간이 여기서 확정된다.
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
