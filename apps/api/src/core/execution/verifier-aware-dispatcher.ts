import type { DispatchOptions, Dispatcher } from "@everdict/application-control";
import type { AgentHalfStore, VerifierPassDeps } from "@everdict/application-control";
import { withVerifierPass } from "@everdict/application-control";
import type { CaseJob, CaseResult, VerifierInvocation, VerifierJob } from "@everdict/contracts";

// ── THE CASE'S TWO HALVES, AT THE DISPATCH SEAM (arch-review 56, Wave K) ─────────────────────────────
//
// A decorator rather than a change inside `RuntimeDispatcher`, for the reason the split itself is a domain
// function: every lane that dispatches a case has to make the same decision, and a decorator makes "the agent
// gets the remainder" true for all of them at once instead of once per dispatcher.
//
// What it wraps is exactly `withVerifierPass`: if the case carries no material the agent must not see, the
// inner dispatcher runs unchanged and nothing pays for a second unit. If it does, the agent's job is the
// remainder and the verdict comes back from a lane the harness was never in.
//
// `dispatchVerifier` absent = this deployment has no such lane. The pass then records the verdict as
// `unmeasured` rather than omitting it, because a case whose verdict never happened must not read as a case
// that was graded.
export class VerifierAwareDispatcher implements Dispatcher {
  constructor(
    private readonly inner: Dispatcher,
    private readonly dispatchVerifier?: (job: VerifierJob) => Promise<VerifierInvocation>,
    // Where the agent's half is staged before the second container exists (arch-review 60 follow-through).
    // Absent means a crash between the two halves loses the agent's evidence, which is what it did before.
    private readonly agentHalves?: AgentHalfStore,
    // ── AND THE LEDGER, BECAUSE THE PASS CORRECTS A ROW (arch-review 64 P1-high) ────────────────────
    //
    // `withVerifierPass` has taken an optional `attempts` since arch-review 63, to correct the attempt of a
    // verdict its merge refused. This constructor had no parameter to pass one through, so the dep was
    // `undefined` in every production dispatch and the correction was a no-op — while its counterexample,
    // which builds its own deps object, passed. An optional dependency with no producer is a plan (rule
    // `protocol`); this is the producer.
    private readonly attempts?: VerifierPassDeps["attempts"],
    // …and where the staged bytes are OWED until the settlement discharges them (arch-review 67 P1-high).
    // Same shape as the argument above and the same history: the capability existed, the tests passed one
    // in, and production had no parameter to carry it — so every case staged artifacts nothing owned.
    private readonly cleanup?: VerifierPassDeps["cleanup"],
  ) {}

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    return await withVerifierPass(job, {
      // The pass's own options are MERGED over the caller's, so the acknowledgement it supplies reaches the
      // backend alongside whatever the caller asked for (arch-review 67 P0-lifecycle).
      dispatch: (agentJob: CaseJob, passOpts?: DispatchOptions) =>
        this.inner.dispatch(agentJob, { ...opts, ...passOpts }),
      ...(this.dispatchVerifier ? { dispatchVerifier: this.dispatchVerifier } : {}),
      ...(this.agentHalves ? { agentHalves: this.agentHalves } : {}),
      ...(this.attempts ? { attempts: this.attempts } : {}),
      ...(this.cleanup ? { cleanup: this.cleanup } : {}),
    });
  }
}
