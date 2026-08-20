import type { DispatchOptions, Dispatcher } from "@everdict/application-control";
import { withVerifierPass } from "@everdict/application-control";
import type { CaseJob, CaseResult, Score, VerifierInvocation, VerifierJob } from "@everdict/contracts";

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
  ) {}

  async dispatch(job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
    return await withVerifierPass(job, {
      dispatch: (agentJob: CaseJob) => this.inner.dispatch(agentJob, opts),
      ...(this.dispatchVerifier ? { dispatchVerifier: this.dispatchVerifier } : {}),
    });
  }
}
