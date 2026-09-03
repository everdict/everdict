import type { CaseJob, CaseResult, SessionAcquire } from "@everdict/contracts";
import { BadRequestError } from "@everdict/contracts";
import type { WorldCreationStore } from "../ports/world-creation-store.js";
import {
  type CreatedWorld,
  type WorldCreator,
  acquireSharedWorld,
  createWorldFor,
  sharedWorldKey,
} from "./created-world.js";

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
    // What MAKES a world, for the arm that creates one. Bundled rather than optional: a deployment that
    // wired the session provider and forgot this one would meet a `create` case as a silent pass-through,
    // dispatching an agent at a world that was never brought up.
    private readonly creation: {
      creator: WorldCreator;
      store: WorldCreationStore;
      // Putting a SHARED world back between cases. Required rather than optional for the same reason the
      // creator is: a deployment that wired the ledger and forgot this one would meet a `per-run` case as an
      // ordinary create, and the cases of that batch would be a chain rather than a comparison.
      reset: (url: string) => Promise<void>;
      newId: () => string;
      now: () => string;
    },
    private readonly inner: { dispatch(job: CaseJob, opts?: unknown): Promise<CaseResult> },
    // What to do with a close that did not happen. REQUIRED: an optional reporter is how "we could not close
    // it" becomes silence, and silence about a world that may still be running is the expensive kind.
    private readonly onRelease: (outcome: {
      caseId: string;
      endpoint: string;
      // `held` is a SHARED world's ending: this case left and the world is still standing for the cases
      // still in it, released by the reconciler once nobody has been inside it for the idle window. It is
      // its own arm because reporting it as `closed` would be the accepted-is-not-gone lie (rule `protocol`
      // L5) about the one world class this platform actually pays for.
      result: { kind: "closed" } | { kind: "not_closed"; reason: string } | { kind: "held"; holders: number };
    }) => void,
  ) {}

  async dispatch(job: CaseJob, opts?: unknown): Promise<CaseResult> {
    const create = job.evalCase.world?.create;
    if (create !== undefined) return this.dispatchCreated(job, create, opts);
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

  // The CREATED arm: make the world, hand over its coordinates, and tear it down through the ledger's own
  // verified release. The recipe is removed before dispatch for the same reason the acquire spec is.
  private async dispatchCreated(
    job: CaseJob,
    create: NonNullable<NonNullable<CaseJob["evalCase"]["world"]>["create"]>,
    opts?: unknown,
  ): Promise<CaseResult> {
    const runId = job.runId;
    if (runId === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { case: job.evalCase.id },
        "this case creates its world and the job carries no run id — a created world could not be joined to the run that made it",
      );
    const tenant = job.tenant ?? "";
    const target = job.evalCase.placement?.target;
    const world =
      create.lifecycle === "per-run"
        ? await this.joinShared(job, create, { tenant, runId, ...(target !== undefined ? { target } : {}) })
        : await createWorldFor({
            tenant,
            runId,
            ...(target !== undefined ? { target } : {}),
            create,
            creator: this.creation.creator,
            store: this.creation.store,
            newId: this.creation.newId,
            now: this.creation.now,
          });
    const { create: _recipe, ...restWorld } = job.evalCase.world ?? { wiring: {} };
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
      const outcome = await world.release();
      this.onRelease({
        caseId: job.evalCase.id,
        endpoint: create.environment,
        result:
          outcome.kind === "released"
            ? { kind: "closed" }
            : outcome.kind === "held"
              ? { kind: "held", holders: outcome.holders }
              : { kind: "not_closed", reason: outcome.reason },
      });
    }
  }

  // ── THE SHARED ARM: JOIN, RESET, ACT, LEAVE ──────────────────────────────────────────────────────
  //
  // The world belongs to the BATCH, so the key is the batch's — a single run is a batch of one and gets a
  // world of its own, which is the same answer the per-case arm would have given it. What this arm adds over
  // that one is a reset before the case and a refusal when it cannot be performed.
  private async joinShared(
    job: CaseJob,
    create: NonNullable<NonNullable<CaseJob["evalCase"]["world"]>["create"]>,
    where: { tenant: string; runId: string; target?: string },
  ): Promise<CreatedWorld> {
    const perCase = create.perCase;
    if (perCase === undefined)
      throw new BadRequestError(
        "BAD_REQUEST",
        { case: job.evalCase.id, environment: create.environment },
        "this case shares its world with the rest of the batch and declares no reset — case N would start in the state case N-1 left, so the case is refused rather than run in the previous one's leftovers",
      );
    return acquireSharedWorld({
      ...where,
      sharedKey: sharedWorldKey({
        // A batch of one still gets a key of its own: `runId` is unique per case, so a single run's world is
        // shared with nobody, which is exactly what it should be.
        scope: job.batchId ?? where.runId,
        environment: create.environment,
        ...(where.target !== undefined ? { target: where.target } : {}),
      }),
      create,
      creator: this.creation.creator,
      store: this.creation.store,
      reset: async (wiring) => {
        const base = wiring[perCase.from];
        if (base === undefined)
          throw new BadRequestError(
            "BAD_REQUEST",
            { case: job.evalCase.id, from: perCase.from },
            `the reset is sent to wiring key '${perCase.from}', which this world does not publish`,
          );
        await this.creation.reset(resetUrl(base, perCase.reset));
      },
      newId: this.creation.newId,
      now: this.creation.now,
    });
  }
}

// The address the reset is sent to. `new URL(path, base)` resolves against the base rather than concatenating,
// so a path cannot smuggle userinfo past the host — and the origin is compared anyway, because the base is the
// PLATFORM's (a runtime's answer for a world it created) and the path is a WORKSPACE's. The schema already
// refuses anything that is not a single-slash path; this is the second half of the same refusal, at the one
// place a control-plane process actually dials the value (rule `protocol`: a guard the schema states and
// nothing enforces is a guard that moved).
export function resetUrl(base: string, path: string): string {
  const origin = new URL(base);
  const target = new URL(path, origin);
  if (target.origin !== origin.origin)
    throw new BadRequestError(
      "BAD_REQUEST",
      { base: origin.origin, target: target.origin },
      "the world's reset path resolves to a different host than the world — the control plane will not dial an address a case chose",
    );
  return target.toString();
}
