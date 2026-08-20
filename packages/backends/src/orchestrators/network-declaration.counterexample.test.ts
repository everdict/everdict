import type { CaseJob } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { buildK8sJob } from "./k8s.js";
import { NomadBackend } from "./nomad.js";
import { buildNomadJob } from "./nomad.js";

// ── AN AXIS WE CANNOT ENFORCE IS REFUSED BEFORE ANYTHING IS CREATED (arch-review 58, W5) ─────────────
//
// `EvalCase.network` is part of what a benchmark MEASURES, not an ops knob: an offline reasoning task that
// quietly ran with internet access measured retrieval, and its score is not comparable to one that did not.
// The contract is therefore enforce-or-refuse.
//
// Neither managed lane enforces it. Nomad and K8s read `resources` and ignore `network` entirely, and
// `withWorldProof` correctly declines to claim the axis — so the refusal happens where the proof is CHECKED,
// which is `LocalDriver.provision` inside the container that was already placed. The case is refused, which
// is right, after paying for a scheduling slot, an image pull and a container start, and the operator sees a
// failure attributed to the run rather than to the lane's capability.
//
// A refusal that arrives after the effect is the shape this review series keeps finding. This is the same
// decision, moved to where it can be made for free: the job SPEC builders, which are pure, already refuse a
// millicore declaration this cluster cannot convert, and this is the second axis with the same answer.
//
// Enforcement itself is a deployment-shaped change (CNI policies on K8s, per-task network config on Nomad)
// and is deliberately NOT what this closes. What it closes is the ordering: an axis we do not enforce is one
// we say so about before we spend anything.
//
// Seen RED before the refusal existed, observed:
//   a lane that enforces no network declaration placed the case anyway: expected [Function] to throw

const job = (network?: unknown): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: {
      id: "c1",
      task: "t",
      env: { kind: "prompt" },
      graders: [],
      timeoutSec: 60,
      ...(network ? { network } : {}),
    },
  }) as unknown as CaseJob;

const NOMAD = { addr: "http://nomad.test:4646", image: "runner:1" };

describe("[R58 W5 COUNTEREXAMPLE] a network declaration is enforced or refused before placement", () => {
  it("REFUSES an offline case on the nomad lane, naming the axis", () => {
    expect(
      () => buildNomadJob(job({ mode: "none", allowedHosts: [] }), NOMAD),
      "a lane that enforces no network declaration placed the case anyway",
    ).toThrow(/network/i);
  });

  it("REFUSES an allowlist case on the k8s lane too — the answer cannot depend on the orchestrator", () => {
    expect(() =>
      buildK8sJob(job({ mode: "allowlist", allowedHosts: ["api.example.com"] }), { image: "runner:1" }, "n", "ns"),
    ).toThrow(/network/i);
  });

  it("places a case that declares the DEFAULT world — silence is not a declaration", () => {
    // `public` with no hosts is what every workload got before the axis existed, so it is the one shape a
    // lane satisfies by doing nothing. Refusing it would break every case that declares nothing.
    expect(() => buildNomadJob(job(), NOMAD)).not.toThrow();
    expect(() => buildNomadJob(job({ mode: "public", allowedHosts: [] }), NOMAD)).not.toThrow();
  });

  it("refuses BEFORE any external object is named", () => {
    // The point of moving the decision here: the spec builders are pure. A refusal at this seam has spent a
    // scheduling slot's worth of nothing, where the in-container check has already paid for the container.
    expect(() => buildNomadJob(job({ mode: "none", allowedHosts: [] }), NOMAD)).toThrow(/cannot enforce/i);
  });

  it("refuses before the RESERVATION is spent, not after", async () => {
    // The ordering is the property, and the spec builder alone did not have it: both lanes build the spec
    // AFTER `requireReservation` and `requireActivation`, so a refusal there had already consumed a durable
    // reservation and burned an activation on a case that will never place. A refusal that arrives after an
    // effect is the shape this whole review series keeps finding.
    const asked: string[] = [];
    const backend = new NomadBackend({
      addr: "http://nomad.test:4646",
      image: "runner:1",
      http: {
        request: async () => {
          asked.push("cluster");
          return { status: 200, text: "{}" };
        },
      },
    } as never);

    await expect(
      backend.dispatch(job({ mode: "none", allowedHosts: [] }), {
        authority: {
          reserve: async (work) => {
            asked.push("reserve");
            return { attemptId: "a1", work, persistedAt: new Date(0).toISOString() };
          },
          activate: async () => {
            asked.push("activate");
            return { kind: "activate" };
          },
        },
      }),
    ).rejects.toThrow(/network/i);

    expect(asked, "the lane spent a reservation on a case it was always going to refuse").toEqual([]);
  });
});
