import type { CaseJob, CaseResult, SessionAcquire } from "@everdict/contracts";
import { BadRequestError } from "@everdict/contracts";

// ── OPENING THE WORLD A CASE ACTS ON, AND CLOSING IT AFTER (world-and-engagement-model.md, axis 1) ────
//
// A world the actor reaches by coordinates comes in two forms. A STATIC one already exists and the resolution
// hands over its coordinates; a SESSION one is opened per case, and that is what this seam owns: acquire
// before the dispatch, hand the coordinates to the job, ask for the close after.
//
// WHO OWNS THE LIFETIME. The session service does. It hands out a session and it expires one; this platform
// asks it to close early when the case ends. That ask can fail, and a failure is REPORTED through `onRelease`
// rather than swallowed — which is strictly more than the browser-session lane does today, and strictly less
// than a teardown this platform could certify. Saying which of those it is matters more than the mechanism:
// a world Everdict CREATED would owe a durable worklist and a verified zero (rule `protocol` L5), and this
// arm deliberately creates nothing.
export interface OpenedWorld {
  wiring: Record<string, string>;
  // Ask the session service to close early. Resolves with what happened, never throws — the case is already
  // over by the time this runs, and turning a courtesy's failure into the case's failure would report the
  // agent as having failed a task it completed.
  release(): Promise<{ kind: "closed" } | { kind: "not_closed"; reason: string }>;
}

export interface WorldSessionProvider {
  open(input: { endpoint: string; acquire: SessionAcquire; runId: string }): Promise<OpenedWorld>;
}

// The dispatch decorator. Placed like `SeedingDispatcher` — outside the harness, inside the dispatch — because
// the world must exist before the actor starts and stop mattering after it finishes.
export class WorldProvidingDispatcher {
  constructor(
    private readonly provider: WorldSessionProvider,
    private readonly inner: { dispatch(job: CaseJob, opts?: unknown): Promise<CaseResult> },
    // What to do with a close that did not happen. REQUIRED: an optional reporter is how "we could not close
    // it" becomes silence, and silence about a world that may still be running is the expensive kind.
    private readonly onRelease: (outcome: {
      caseId: string;
      endpoint: string;
      result: { kind: "closed" } | { kind: "not_closed"; reason: string };
    }) => void,
  ) {}

  async dispatch(job: CaseJob, opts?: unknown): Promise<CaseResult> {
    const session = job.evalCase.world?.session;
    if (session === undefined) return this.inner.dispatch(job, opts);
    const runId = job.runId;
    if (runId === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { case: job.evalCase.id },
        "this case opens its world through a session API and the job carries no run id — the session could not be correlated with the run that opened it",
      );
    // Acquire BEFORE the dispatch. A world that could not be opened refuses the case: running it against
    // whatever the harness's own default happens to be would measure a different experiment and report the
    // number as if nothing had changed.
    const world = await this.provider.open({ endpoint: session.endpoint, acquire: session.acquire, runId });
    // The coordinates travel; the MEANS of minting more of them does not. `session` is removed here, so the
    // acquire spec never crosses the process boundary into a runner.
    const { session: _dropped, ...restWorld } = job.evalCase.world ?? { wiring: {} };
    const dispatched: CaseJob = {
      ...job,
      evalCase: {
        ...job.evalCase,
        world: { ...restWorld, wiring: { ...restWorld.wiring, ...world.wiring } },
      },
    };
    try {
      return await this.inner.dispatch(dispatched, opts);
    } finally {
      const result = await world.release();
      this.onRelease({ caseId: job.evalCase.id, endpoint: session.endpoint, result });
    }
  }
}
