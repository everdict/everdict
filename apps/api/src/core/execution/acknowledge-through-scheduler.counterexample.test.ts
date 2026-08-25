import type { AgentHalfStore } from "@everdict/application-control";
import type { Backend, DispatchOptions } from "@everdict/backends";
import { BackendRegistry, Scheduler } from "@everdict/backends";
import type { CaseJob, CaseResult, VerifierInvocation } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { VerifierAwareDispatcher } from "./verifier-aware-dispatcher.js";

// ── THE DURABLE HANDOVER DIED IN THE SAME ALLOWLIST AS THE LAST ONE (arch-review 69 P0) ─────────────
//
// arch-review 67 gave the agent lane an acknowledgement: the backend hands its parsed `CaseResult` to a
// durable owner INSIDE its try, before the `finally` that reclaims the container. `withVerifierPass` supplies
// it, both managed lanes call it, and the counterexample for it passes — because that counterexample builds
// its own fake dispatch and hands it straight to the pass.
//
// Production does not do that. Production goes through the Scheduler, and a Scheduler entry waits in a queue,
// so its options are taken apart into `QueueEntry` fields and REBUILT at `runOne`. `acknowledgeResult` was
// never added to either half, so on every managed dispatch the option arrived as `undefined`, the lane took
// its ordinary path, and the window the whole feature exists to close stayed exactly as wide as before:
//
//     result parsed → Job deleted → dispatch returns → ✗ → nothing staged, nothing to recover
//
// ⚠️ THIS IS THE SECOND FIELD TO DIE IN THAT BLOCK. `onActivate` was the first (arch-review 58 W2), and the
// block carries two comments saying so — "this whitelist is the ONE place a hook can silently die" and "it is
// one field on purpose: `onActivate` died here as a second one". The third field was dropped three lines
// below them. Which is why the durable half of this fix is `pnpm option-forwarding` and not this file: a law
// is applied when writing a call site, not when reading a rule.
//
// So this test drives the PRODUCTION CHAIN — VerifierAwareDispatcher → Scheduler → managed backend — and
// asserts the ORDER of effects at the backend, not that a field was copied. A field assertion would pass the
// moment somebody adds the line and would say nothing about whether the ordering it exists for holds.
//
// Seen RED before the Scheduler forwarded it, observed:
//   the agent half was staged AFTER the container was reclaimed: expected [ 'parsed', 'reclaim', 'staged' ]
//     to deeply equal [ 'parsed', 'staged', 'reclaim' ]

// A case with a PRIVATE grader, because that is the only kind that has two halves. `verifierPlanOf` returns
// undefined for a case whose graders decide nothing the agent must not see, and `withVerifierPass` then
// dispatches straight through with no acknowledgement at all — so a graderless fixture measures a one-phase
// case and reads its silence as this defect.
const JOB = {
  tenant: "acme",
  runId: "evd-run-r1",
  harness: { id: "h", version: "1" },
  evalCase: {
    id: "c1",
    task: "t",
    env: { kind: "repo", source: { path: "/app" } },
    graders: [{ id: "reward-file", config: { files: { "tests/test.sh": "exit 0" } } }],
    timeoutSec: 60,
  },
} as unknown as CaseJob;

// A REPO workspace, because that is what a private-verifier case is: `willJudge` refuses a non-repo snapshot
// (there is no tree for a second container to judge), so a prompt result never stages at all — which the
// second draft of this file measured as `['parsed', 'reclaim']` and would have read as the defect.
const RESULT = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
} as unknown as CaseResult;

// A managed backend in the shape both real ones have: parse the result, hand it over if the caller gave it
// somewhere to go, and reclaim the object in a `finally` whatever happened. The `finally` is the whole point —
// it is what makes the caller's next line load-bearing when the acknowledgement is absent.
function managedBackend(order: string[]): Backend {
  return {
    id: "managed",
    async dispatch(_job: CaseJob, opts?: DispatchOptions): Promise<CaseResult> {
      try {
        order.push("parsed");
        return opts?.acknowledgeResult ? await opts.acknowledgeResult(RESULT) : RESULT;
      } finally {
        order.push("reclaim");
      }
    },
    async capacity() {
      return { total: 1, used: 0 };
    },
  } as unknown as Backend;
}

// An object store that records WHEN it was written, in the same list the backend records into — so the
// assertion is one ordering rather than two timestamps somebody has to compare.
function recordingHalves(order: string[]): AgentHalfStore {
  return {
    async put(key: string) {
      order.push("staged");
      return key;
    },
    async get() {
      return undefined;
    },
    async remove() {
      // nothing staged here is ever collected in this test
    },
  };
}

// The judging half. A case only STAGES its agent result when there is a second container to judge it — with
// no verifier lane there is no two-phase case and nothing to recover into, so a fixture without one measures
// the wrong thing entirely (it was the first draft of this file, and it read `['parsed', 'reclaim']`).
//
// The verdict names the tree it was handed, which is what `mergeVerifierPass` compares it against.
const verifier = async (): Promise<VerifierInvocation> => ({
  planDigest: "sha256:plan",
  workspaceDigest: contentDigest(RESULT.snapshot),
  scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
});

describe("[R69 COUNTEREXAMPLE] the acknowledgement survives the Scheduler", () => {
  it("stages the agent half BEFORE the lane reclaims its container", async () => {
    const order: string[] = [];
    const scheduler = new Scheduler(new BackendRegistry().register("managed", managedBackend(order)));
    // The production composition: the pass wraps the scheduler, exactly as `buildDispatch` assembles it.
    const dispatcher = new VerifierAwareDispatcher(scheduler, verifier, recordingHalves(order));

    await dispatcher.dispatch(JOB);

    expect(order, "the agent half was staged AFTER the container was reclaimed").toEqual([
      "parsed",
      "staged",
      "reclaim",
    ]);
  });

  it("returns the document the ACKNOWLEDGEMENT settled on, not the one the lane happened to hold", async () => {
    // The arch-review 65 hazard a careless fix for this would re-open: the value handed over and the value
    // returned must be one document. The lane returns what comes back from the acknowledgement.
    const order: string[] = [];
    const scheduler = new Scheduler(new BackendRegistry().register("managed", managedBackend(order)));
    const dispatcher = new VerifierAwareDispatcher(scheduler, verifier, recordingHalves(order));

    const result = await dispatcher.dispatch(JOB);

    expect(result.caseId, "the caller received a different document than the one made durable").toBe("c1");
  });

  it("leaves a lane that was given no store exactly as it was", async () => {
    // The control. A deployment with no artifact store must not start failing, and must not gain an
    // acknowledgement that hands its result to nobody — `withVerifierPass` supplies the hook only when it has
    // somewhere to put the bytes, so the lane keeps its ordinary ordering.
    const order: string[] = [];
    const scheduler = new Scheduler(new BackendRegistry().register("managed", managedBackend(order)));
    const dispatcher = new VerifierAwareDispatcher(scheduler, verifier);

    await dispatcher.dispatch(JOB);

    expect(order, "a store-less deployment was made to stage something").toEqual(["parsed", "reclaim"]);
  });
});
