import { describe, expect, it } from "vitest";
import { K8sBackend } from "./k8s.js";
import { NomadBackend, type NomadHttp } from "./nomad.js";

// ── UNKNOWN IS UNIGNORABLE, INCLUDING INSIDE THE ADAPTER (arch-review 54, Phase 2) ───────────────────
//
// `AdoptOutcome` has had three values since Wave B, and adoption is the one read where the third matters
// most: adopting HARVESTS a finished job and hands its result back as this execution's own, so an adoption
// that answers wrongly does not merely mis-report — it re-dispatches live compute or attributes a verdict.
//
// K8s gets it right. `jobsByLabel` answers `undefined` when the cluster could not be asked, and `adoptWork`
// maps that to `unknown`; only a successful listing that omits this job's name is `absent`.
//
// Nomad does not, and says otherwise two lines above the bug:
//
//     // Does exactly this job exist? A read that FAILED is `unknown` — re-dispatching on an unestablished
//     // liveness double-spends — while a successful read that finds nothing is `absent` and safe.
//     const found = await this.findJob(work.externalJobId, ns);
//     if (found === undefined) return { status: "absent" };
//
// `findJob` returns `undefined` on `res.status >= 300`. So a Nomad API 500 — a leader election, a rate limit,
// an expired token — reads as "this job is not there", and the caller re-dispatches a job that is still
// running. The comment describes the protocol; the code implements the collapse.
//
// The conformance suite did not catch it because it asks whether the METHOD EXISTS and whether the callback
// order holds, not what the adapter ANSWERS when the cluster errors. Two implementations of one contract are
// exactly where a shared suite has to assert the answer.
//
// The invariant: a failed read is `unknown` in every adapter, and the suite that says so is shared.

const nomadWith = (status: number, text = ""): NomadHttp => ({
  async request() {
    return { status, text };
  },
});

const WORK = { tenant: "acme", runId: "evd-run-1", externalJobId: "everdict-c1-aaaa" };

// RED as of efe3657e, observed: `expected 'absent' to be 'unknown'`.
describe.skip("[R54 PHASE-2 COUNTEREXAMPLE #7] a cluster that could not be asked answers `unknown`, never `absent`", () => {
  it("Nomad: a 500 from the job listing is not evidence the job is gone", async () => {
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http: nomadWith(500, "leader lost") });
    const outcome = await backend.adoptWork(WORK);
    expect(outcome.status, "a Nomad API failure was reported as absence, and the caller re-dispatches on absence").toBe(
      "unknown",
    );
  });

  it("Nomad: a successful listing that does not contain the job IS absence", async () => {
    // The other half, so the fix cannot be "always answer unknown" — that would strand every finished job.
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http: nomadWith(200, "[]") });
    expect((await backend.adoptWork(WORK)).status).toBe("absent");
  });

  it("K8s already distinguishes the two, and must keep doing so", async () => {
    // The reference implementation of the same rung — asserted here so the shared expectation is visible in
    // one place rather than inferred from two adapters that happen to agree.
    const unreachable = new K8sBackend({
      image: "img",
      api: {
        jobsByLabel: async () => undefined,
      } as never,
    });
    expect((await unreachable.adoptWork(WORK)).status).toBe("unknown");
  });
});
