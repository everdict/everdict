import type { CaseRuntimeSample, DispatchOptions, Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult, RuntimeWorkRef, TrackEntry } from "@everdict/contracts";

// The replay RUNTIME plane's producer loop (docs/architecture/replay.md ③ / D5b): while a managed dispatch is in
// flight, poll the orchestrator's per-case resource stats (CaseSampleable behind `sample`) and stream each sample
// onto the recording's `runtime` lane — the plane that answers "did it OOM / thrash", invisible to both the agent
// trace and the environment tracks. Wired around the shared dispatcher (composition/dispatch.ts) so single runs,
// scorecard cases and judges all record without per-caller wiring.
//
// Skips: no CP-minted runId (nothing to key the recording), no placement target, or a self-hosted target (the
// control plane cannot reach a runner's container — that lane pushes its own evidence). Entirely best-effort: a
// failing sample is silently dropped, and the interval always dies with the dispatch (finally).
export class RuntimeSamplingDispatcher implements Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly opts: {
      // Resolve the job's runtime target to a live backend and read one sample (undefined = no live alloc / unsupported).
      // Resolve the job's runtime target and read one sample of EXACTLY this work (arch-review 53, legacy
      // removal). It used to take a case id, which resolved "the newest job of this case" — with two runs of
      // one case live, this recording's runtime lane would carry another run's cpu and memory.
      sample: (tenant: string, target: string, work: RuntimeWorkRef) => Promise<CaseRuntimeSample | undefined>;
      // Append onto the recording (CaseRecorder.recordTrack — best-effort by contract).
      // …and WHICH ATTEMPT the sample belongs to: the job says, because nothing else can (review 39, Phase 4).
      record: (runId: string, item: TrackEntry, generation: number) => void;
      intervalMs?: number;
      now?: () => number; // test injection — the sample stamp
    },
  ) {}

  async dispatch(job: CaseJob, dispatchOpts?: DispatchOptions): Promise<CaseResult> {
    const runId = job.runId;
    const target = job.evalCase.placement?.target;
    if (!runId || !target || target.startsWith("self:")) return this.inner.dispatch(job, dispatchOpts);
    const now = this.opts.now ?? (() => Date.now());
    // The handle this dispatch is about to create — captured from the reservation, which happens BEFORE the
    // external object exists (Wave A). Until it arrives there is nothing exact to sample, so the loop simply
    // does not fire; a sample of the wrong job is worse than a missing one.
    let work: RuntimeWorkRef | undefined;
    const opts: DispatchOptions = {
      ...dispatchOpts,
      onReserved: async (reserved) => {
        work = reserved;
        await dispatchOpts?.onReserved?.(reserved);
      },
    };
    let inFlight = false; // 겹침 가드 — 느린 stats API가 밀리면 샘플을 건너뛰지, 쌓지 않는다
    const timer = setInterval(() => {
      if (inFlight || work === undefined) return;
      inFlight = true;
      void this.opts
        .sample(job.tenant ?? "default", target, work)
        .then((sample) => {
          if (sample && (sample.cpuPct !== undefined || sample.memBytes !== undefined))
            this.opts.record(runId, { track: "runtime", entry: { t: now(), ...sample } }, job.recordingGeneration ?? 0);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, this.opts.intervalMs ?? 10_000);
    // A sampler must never keep the process alive on its own (the dispatch promise is what we wait on).
    timer.unref?.();
    try {
      return await this.inner.dispatch(job, opts);
    } finally {
      clearInterval(timer);
    }
  }
}
