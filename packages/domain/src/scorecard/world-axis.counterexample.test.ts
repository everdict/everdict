import { type CaseResult, MANIFEST_IDENTITY_VERSION, type ScorecardManifest } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { experimentIdentity } from "./experiment-identity.js";
import { type GateInput, evaluateGate } from "./gate.js";

// ── THE WORLD A CASE RAN IN IS A CONFOUND AXIS (arch-review 58, follow-through) ──────────────────────
//
// Two waves built the vocabulary for "did these two runs happen in the same world" and neither gave it a
// consumer. `sameResolvedImages` — the function that decides whether two executions ran the same image
// BYTES — had no caller outside its own test. `VerifierReceipt.complete` — whether the deciding half can
// say where it ran and from which image — had no reader anywhere in the repo. Both are exactly the shape
// this review series is about: the right noun, produced correctly, consumed by nobody.
//
// The consumer was already here. `experimentIdentity` answers, per axis, whether a baseline↔candidate pair
// HELD an axis, is CONFOUNDED on it (verified different — the gate refuses unless the caller acknowledges
// it), or cannot verify it. `allowConfounds` is how a caller says "yes, the dataset content moved, compare
// anyway". A candidate that ran different image bytes than its baseline is the same kind of claim: a
// different experiment, not a treatment comparison. Attributing that delta to the code under test is the
// false green light the whole gate exists to prevent.
//
// So `execution_world` joins the axes, and the two orphaned nouns become its reading:
//
//   held        — every compared case resolved to the same bytes on both sides
//   confound    — both sides resolved, and some case ran DIFFERENT bytes
//   unverified  — a side could not pin its bytes (`none`/`unresolved`, or a legacy-era manifest), or the
//                 verdict came from a verifier whose receipt cannot say where it ran
//
// The third answer is why this is safe to ship: an old scorecard verifies nothing on this axis and rides as
// information, exactly as an unsealed side already does — it does not retroactively refuse history.
//
// Seen RED before the axis existed, observed:
//   a candidate that ran different image bytes was not a confound: expected [] to have a length of 1

// The same split-seal shape production submit stamps — copied from `experiment-identity.test.ts` rather
// than invented, so the OTHER axes read as held and this file is only ever about the world one.
const sealed = (over: Partial<ScorecardManifest> = {}): ScorecardManifest => ({
  identityVersion: MANIFEST_IDENTITY_VERSION,
  dataset: { id: "bench", version: "7.0.0", digest: "sha256:composite-a" },
  cases: { c1: "sha256:case-c1", c2: "sha256:case-c2" },
  grading: "sha256:grading-a",
  harness: { id: "agent", version: "1.0.0", specDigest: "sha256:hhhh" },
  ...over,
});

// A case result as an era-2 lane writes one: the manifest states which bytes it ran from.
const ranFrom = (caseId: string, digest: string | "unpinned"): CaseResult =>
  ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
    execution: {
      os: "linux",
      osResolved: "declared",
      manifestVersion: 2,
      imageProvenance:
        digest === "unpinned"
          ? { kind: "unresolved", images: [{ ref: "tasks/repro:latest" }], reason: "no_digest", detail: "d" }
          : { kind: "resolved", by: "driver", images: [{ ref: "tasks/repro:1", digest }] },
    },
  }) as unknown as CaseResult;

const axisOf = (id: ReturnType<typeof experimentIdentity>, axis: string) => ({
  held: id.held.includes(axis as never),
  confound: id.confounds.filter((c) => c.axis === axis),
  unverified: id.unverified.filter((u) => u.axis === axis),
});

describe("[R58 FOLLOW-THROUGH] the image bytes a comparison ran on are an identity axis", () => {
  it("HOLDS when both sides resolved to the same bytes", () => {
    const id = experimentIdentity(sealed(), sealed(), {
      baseline: [ranFrom("c1", "sha256:img")],
      candidate: [ranFrom("c1", "sha256:img")],
    });
    expect(axisOf(id, "execution_world").held).toBe(true);
  });

  it("is a CONFOUND when a case ran different bytes on the two sides", () => {
    // The defect this axis exists for. Both sides know exactly what they ran, and they are not the same
    // world — so a regression here is not evidence about the change under test.
    const id = experimentIdentity(sealed(), sealed(), {
      baseline: [ranFrom("c1", "sha256:img-A")],
      candidate: [ranFrom("c1", "sha256:img-B")],
    });
    const world = axisOf(id, "execution_world");
    expect(world.confound, "a candidate that ran different image bytes was not a confound").toHaveLength(1);
    expect(world.confound[0]?.detail).toMatch(/c1/);
    expect(world.held).toBe(false);
  });

  it("is UNVERIFIED when a side could not pin its bytes — not a confound, and not held", () => {
    // "We cannot say" is the third answer, and the reason it exists: claiming sameness would be as unfounded
    // as claiming difference, so it downgrades what a gate may claim without rewriting history as a refusal.
    const id = experimentIdentity(sealed(), sealed(), {
      baseline: [ranFrom("c1", "unpinned")],
      candidate: [ranFrom("c1", "sha256:img")],
    });
    const world = axisOf(id, "execution_world");
    expect(world.unverified, "an unpinnable world was resolved into a verdict about sameness").toHaveLength(1);
    expect(world.confound).toHaveLength(0);
    expect(world.held).toBe(false);
  });

  it("is UNVERIFIED when the deciding verdict's receipt cannot say where it ran", () => {
    // The verifier's own half. A case whose `tests_pass` came from a second container is only as attributable
    // as that container's receipt — `complete: false` means the lane could not name the work or the image,
    // so the world of the DECIDING half is unknown even when the agent's half pinned perfectly.
    const withVerifier = (caseId: string, complete: boolean): CaseResult =>
      ({
        ...ranFrom(caseId, "sha256:img"),
        verifier: {
          planDigest: "sha256:plan",
          workspaceDigest: "sha256:ws",
          scoreDigest: "sha256:scores",
          scores: [{ graderId: "reward-file", metric: "tests_pass", value: 1, pass: true }],
          complete,
        },
      }) as unknown as CaseResult;

    const id = experimentIdentity(sealed(), sealed(), {
      baseline: [withVerifier("c1", true)],
      candidate: [withVerifier("c1", false)],
    });
    const world = axisOf(id, "execution_world");
    expect(world.unverified, "a verdict from an unattributable container counted as a verified world").toHaveLength(1);
    expect(world.held).toBe(false);
  });

  it("compares only the cases the two sides SHARE", () => {
    // A case only one side ran is missingness, which the diff already reports on its own axis. Reading it
    // here would turn every subset run into a world confound.
    const id = experimentIdentity(sealed(), sealed(), {
      baseline: [ranFrom("c1", "sha256:img"), ranFrom("c2", "sha256:only-baseline")],
      candidate: [ranFrom("c1", "sha256:img")],
    });
    expect(axisOf(id, "execution_world").held).toBe(true);
  });

  it("ABSTAINS when neither side's records say what they ran on", () => {
    // The rollout half, and it is deliberate: the gate REFUSES an unverified axis by default, so an axis
    // that read "unverified" whenever both sides were silent would retroactively block every comparison made
    // before lanes recorded image provenance — including a `/scorecards/ingest` pair, which scores somebody
    // else's runtime and has no world to record by construction. Those pairs are exactly as verifiable as
    // they were yesterday, and a new axis must not change the answer for data that did not change.
    const bare = (caseId: string) =>
      ({
        caseId,
        harness: "h@1",
        trace: [],
        snapshot: { kind: "prompt", output: "" },
        scores: [],
      }) as unknown as CaseResult;
    const id = experimentIdentity(sealed(), sealed(), { baseline: [bare("c1")], candidate: [bare("c1")] });
    const world = axisOf(id, "execution_world");
    expect(world.held, "a silent pair claimed a verified world").toBe(false);
    expect(world.confound).toHaveLength(0);
    expect(world.unverified, "a silent pair was refused on an axis its records never spoke to").toHaveLength(0);
  });

  it("does NOT abstain when only ONE side recorded a world", () => {
    // Asymmetry is information: one side knows what it ran and the other does not, so sameness cannot be
    // claimed. This is the case the abstention must not swallow.
    const bare = (caseId: string) =>
      ({
        caseId,
        harness: "h@1",
        trace: [],
        snapshot: { kind: "prompt", output: "" },
        scores: [],
      }) as unknown as CaseResult;
    const id = experimentIdentity(sealed(), sealed(), {
      baseline: [ranFrom("c1", "sha256:img")],
      candidate: [bare("c1")],
    });
    expect(axisOf(id, "execution_world").unverified).toHaveLength(1);
  });

  it("verifies nothing on an entirely unsealed side, like every other axis", () => {
    const id = experimentIdentity(undefined, sealed(), {
      baseline: [ranFrom("c1", "sha256:img")],
      candidate: [ranFrom("c1", "sha256:img")],
    });
    expect(axisOf(id, "execution_world").unverified).toHaveLength(1);
  });
});

// ── AND THE GATE ACTUALLY REFUSES ON IT ─────────────────────────────────────────────────────────────
//
// The axis is only worth adding if it reaches a decision. It does, without new gate code: `evaluateGate`
// already refuses any confound the policy has not acknowledged, so `execution_world` inherits the exact
// treatment `dataset_content` has. This is the difference between shipping a flag and shipping a consumer.
describe("[R58 FOLLOW-THROUGH] a world confound reaches the release gate", () => {
  const gateInput = (over: Partial<GateInput>): GateInput => ({
    baseline: "b",
    candidate: "c",
    metrics: [],
    regressions: [],
    improvements: [],
    caseTransitions: [],
    metricCoverage: [],
    missing: {
      casesOnlyInBaseline: [],
      casesOnlyInCandidate: [],
      metricsOnlyInBaseline: [],
      metricsOnlyInCandidate: [],
    },
    incomparable: [],
    overlap: { sharedCases: 1, baselineCases: 1, candidateCases: 1 },
    comparability: "full",
    ...over,
  });

  const worldConfound = () =>
    experimentIdentity(sealed(), sealed(), {
      baseline: [ranFrom("c1", "sha256:img-A")],
      candidate: [ranFrom("c1", "sha256:img-B")],
    });

  it("REFUSES a clean comparison whose two sides ran different bytes", () => {
    // Zero regressions and a green light would be the false green light: the candidate did not fail, and it
    // also did not run the same experiment.
    const g = evaluateGate(gateInput({ experiment: worldConfound() }), { maxRegressions: 0 });
    expect(g.decision, "a comparison across different image bytes was allowed to pass").toBe("not_comparable");
    expect(g.reasons.some((r) => r.kind === "confounded")).toBe(true);
  });

  it("passes once the caller ACKNOWLEDGES the axis, like every other confound", () => {
    // Acknowledgement is the point: a caller who knows the image moved and wants the comparison anyway says
    // so, and the decision records that they did.
    const g = evaluateGate(gateInput({ experiment: worldConfound() }), {
      maxRegressions: 0,
      allowConfounds: ["execution_world"],
    });
    expect(g.decision).toBe("pass");
  });

  it("acknowledging a DIFFERENT axis does not let a world confound through", () => {
    const g = evaluateGate(gateInput({ experiment: worldConfound() }), {
      maxRegressions: 0,
      allowConfounds: ["dataset_content"],
    });
    expect(g.decision).toBe("not_comparable");
  });
});
