import type { CaseRuntimeSample, DispatchOptions, Dispatcher } from "@everdict/backends";
import type { CaseJob, CaseResult, PersistedWorkIntent, RuntimeWorkRef, TrackEntry } from "@everdict/contracts";

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
    // Observing the reservation must not ABSORB it, and must not IMPERSONATE it either (arch-review 54,
    // Phase 1). This wrapper wants the handle so it can sample the right container; the proof belongs to the
    // backend, which refuses to create the job without it.
    //
    // So the hook is installed only when there is an inner one to forward to, and its answer is returned
    // verbatim. Wrapping an ABSENT inner hook would be worse than useless: it would turn "nobody is recording
    // this placement" — which `requireReservation` refuses at the effect boundary, where the decision belongs
    // — into "a hook exists and it threw", moving one protocol's enforcement into a diagnostics decorator.
    const inner = dispatchOpts?.authority;
    const opts: DispatchOptions = {
      ...dispatchOpts,
      ...(inner
        ? {
            // Observe the reservation, carry the activation through untouched — the authority is ONE object
            // precisely so a decorator cannot keep half of it (arch-review 58 W2).
            authority: {
              reserve: async (reserved): Promise<PersistedWorkIntent> => {
                work = reserved;
                return await inner.reserve(reserved);
              },
              activate: inner.activate.bind(inner),
            },
          }
        : {}),
    };
    // Overlap guard — when a slow stats API falls behind, skip the sample rather than queue them up.
    let inFlight = false;
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
