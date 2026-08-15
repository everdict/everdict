import type { ProductRecord, ProductSeries, ReleaseRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Product } from "./product.js";
import {
  type BaselineResolution,
  type SeriesContractResolution,
  type SeriesGateReading,
  type SeriesScorecardPoint,
  releaseReadiness,
  seriesContractDigest,
  watchedSeries,
} from "./readiness.js";
import { Release } from "./release.js";

const NOW = "2026-08-08T00:00:00.000Z";

function product(over: Partial<ProductSeries>[] = []): ProductRecord {
  const base: ProductSeries[] = [
    { key: "quality", label: "Quality", dataset: { id: "d" }, harness: { id: "h" }, judges: [] },
    { key: "latency", label: "Latency", dataset: { id: "d2" }, harness: { id: "h" }, judges: [] },
  ];
  return Product.newProduct({
    id: "prod-1",
    tenant: "acme",
    name: "Support Copilot",
    series: base.map((s, i) => ({ ...s, ...(over[i] ?? {}) })),
    createdBy: "dana",
    now: NOW,
  });
}

function release(seriesKeys?: string[]): ReleaseRecord {
  return Release.newRelease({
    id: "rel-1",
    tenant: "acme",
    productId: "prod-1",
    name: "2026.3",
    ...(seriesKeys !== undefined ? { seriesKeys } : {}),
    productSeriesKeys: ["quality", "latency"],
    createdBy: "dana",
    now: NOW,
  });
}

function point(scorecardId: string, passRate?: number): SeriesScorecardPoint {
  return {
    scorecardId,
    ...(passRate !== undefined ? { passRate } : {}),
    createdAt: NOW,
    // Every modern settle pins a scoring revision whose input observation completed vouched — the fixture
    // carries that shape so tests about OTHER concerns are input-trust-neutral (legacy/unvouched pins are
    // exercised by their own dedicated tests, which override `scoring`).
    scoring: { revision: 1, scorePlaneDigest: "sha256:plane", inputObservation: { completed: true } },
  };
}

const gate = (verdict: SeriesGateReading["verdict"], reasons?: string[]): SeriesGateReading => ({
  verdict,
  ...(reasons ? { reasons } : {}),
});

// The baseline the previous ship stood on, found and readable — the ordinary case.
const resolved = (scorecardId: string, passRate?: number): BaselineResolution => ({
  kind: "resolved",
  point: point(scorecardId, passRate),
});

describe("releaseReadiness — the SCORECARD GATE's verdicts, composed; never a second truth", () => {
  it("watches every product series by default, and only the selection when one was made", () => {
    expect(watchedSeries(product(), release()).map((series) => series.key)).toEqual(["quality", "latency"]);
    expect(watchedSeries(product(), release(["latency"])).map((series) => series.key)).toEqual(["latency"]);
  });

  it("carries the gate's verdict per series — a block blocks, a pass passes, and the reasons ride along", () => {
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([
        ["quality", point("sc-2", 0.6)],
        ["latency", point("sc-4", 0.9)],
      ]),
      new Map([
        ["quality", resolved("sc-1", 0.8)],
        ["latency", resolved("sc-3", 0.9)],
      ]),
      new Map([
        ["quality", gate("block", ["1 regression over the shared cases"])],
        ["latency", gate("pass")],
      ]),
      0,
    );
    expect(readiness.regressedSeries).toEqual(["quality"]);
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "block",
      regressed: true,
      reasons: ["1 regression over the shared cases"],
    });
    expect(readiness.series.find((s) => s.key === "latency")).toMatchObject({ verdict: "pass", regressed: false });
    expect(readiness.ready).toBe(false);
  });

  it("NOT EVALUATED IS NEVER GREEN — a required series that never ran blocks the release (arch-review 7 P0)", () => {
    // The pre-verdict arithmetic read "absence of evidence as not regressed" and shipped on zero
    // evaluations — the exact false green this rewrite exists to kill.
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([["latency", point("sc-2", 0.5)]]),
      new Map([["latency", resolved("sc-1", 0.5)]]),
      new Map([["latency", gate("pass")]]),
      0,
    );
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "not_evaluated",
      regressed: true,
    });
    expect(readiness.regressedSeries).toEqual(["quality"]);
    expect(readiness.ready).toBe(false);
  });

  it("opting a series out of the gate is the EXPLICIT requiredForRelease policy — never inferred from absence", () => {
    const readiness = releaseReadiness(
      release(),
      product([{ requiredForRelease: false }]), // quality declared non-gating — a recorded product choice
      new Map([["latency", point("sc-2", 0.5)]]),
      new Map([["latency", resolved("sc-1", 0.5)]]),
      new Map([["latency", gate("pass")]]),
      0,
    );
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "not_evaluated",
      regressed: false, // informational, not blocking — because the product SAID so
    });
    expect(readiness.ready).toBe(true);
  });

  // arch-review 8 P1: "no comparison is possible" is not "shipping is fine". The first ship of a REQUIRED
  // series blocks until someone approves it, because the alternative let a batch with nothing verdicted
  // through — the same absence-read-as-green shape the verdict work existed to close.
  it("the first ship of a required series BLOCKS until the bootstrap is approved", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", point("sc-1", 0.9)]]),
      new Map(),
      new Map(),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "bootstrap_required", regressed: true });
    expect(readiness.ready).toBe(false);
  });

  it("ships the first evaluation once the series policy allows it — a recorded decision, not a default", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", point("sc-1", 0.9)]]),
      new Map(),
      new Map(),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "no_baseline", regressed: false });
    expect(readiness.ready).toBe(true);
  });

  it("still refuses an approved bootstrap whose only evidence carries NO verdict", () => {
    // A pipeline-level `succeeded` batch where every case infra-failed: a record exists, a pass rate does
    // not. Approving a bootstrap approves shipping on absolute evidence — not on the absence of any.
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", { scorecardId: "sc-1", createdAt: "2026-01-01T00:00:00.000Z" }]]),
      new Map(),
      new Map(),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "bootstrap_required", regressed: true });
    expect(readiness.ready).toBe(false);
  });

  // arch-review 10 P0: `baseline: undefined` used to mean three different things at once, and the weakest
  // reading won. `allowNoBaseline` is an approval to ship the FIRST time; it must not silently license
  // shipping after the evidence of the last ship disappeared. Both tests below PASS on the collapsed model.
  it("LOST historical evidence refuses even under an approved bootstrap — absence of history is not a first ship", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]), // the bootstrap IS approved — and it does not reach this state
      new Map([["quality", point("sc-2", 0.9)]]),
      new Map([["quality", { kind: "missing_historical_evidence", pin: undefined, scorecardId: "sc-1" }]]),
      new Map(),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "not_comparable", regressed: true });
    expect(readiness.series[0]?.reasons?.[0]).toContain("sc-1");
    expect(readiness.ready).toBe(false);
  });

  it("a baseline RE-SCORED since the last ship refuses — the pinned judgment is no longer the readable one", () => {
    const pin = { revision: 1, scorePlaneDigest: "sha256:then" };
    const current = { revision: 2, scorePlaneDigest: "sha256:now" };
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", point("sc-2", 0.9)]]),
      new Map([["quality", { kind: "revision_unavailable", pin, current, scorecardId: "sc-1" }]]),
      new Map(),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "not_comparable", regressed: true });
    expect(readiness.series[0]?.reasons?.[0]).toContain("revision 1");
    expect(readiness.ready).toBe(false);
  });

  // arch-review 10 P0: the decision records the pins the GATE read, not the ones the trend list happened to
  // show first. A re-score between those two reads used to stamp a decision with a revision that did not
  // produce the verdict recorded next to it.
  it("records the GATE's own scoring pins over the trend list's, on both sides", () => {
    const listPin = { revision: 1, scorePlaneDigest: "sha256:list" };
    const gatePin = { revision: 2, scorePlaneDigest: "sha256:gate" };
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", { ...point("sc-2", 0.9), scoring: listPin }]]),
      new Map([["quality", { kind: "resolved", point: { ...point("sc-1", 0.8), scoring: listPin } }]]),
      new Map([["quality", { verdict: "pass", baselineScoring: gatePin, candidateScoring: gatePin }]]),
      0,
    );
    expect(readiness.series[0]?.latest?.scoring).toEqual(gatePin);
    expect(readiness.series[0]?.baseline?.scoring).toEqual(gatePin);
  });

  // arch-review 46: a scoring revision now records what its judges READ, and whether the receipt ledger still
  // vouches for it. A green gate over verdicts derived from executions that have since been replaced is an
  // answer about something else — and until now the ship path could not see the difference at all.
  it("REFUSES a green series whose pinned judgment disowns its own input", () => {
    const diverged = {
      revision: 2,
      scorePlaneDigest: "sha256:plane",
      inputObservation: { setDigest: "sha256:judged", completed: true, diverged: 3 },
    };
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", point("sc-2", 0.95)]]),
      new Map([["quality", resolved("sc-1", 0.9)]]),
      // The gate itself is perfectly happy — it compares judgments, not the executions beneath them
      new Map([["quality", { verdict: "pass" as const, candidateScoring: diverged }]]),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "not_comparable", regressed: true });
    expect(readiness.series[0]?.reasons?.[0]).toContain("3 case(s)");
    expect(readiness.ready).toBe(false);
  });

  it("refuses on the BASELINE side too — either end of the comparison is enough", () => {
    const diverged = {
      revision: 1,
      scorePlaneDigest: "sha256:plane",
      inputObservation: { completed: true, diverged: 1 },
    };
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", point("sc-2", 0.95)]]),
      new Map([["quality", { kind: "resolved" as const, point: { ...point("sc-1", 0.9), scoring: diverged } }]]),
      new Map([["quality", gate("pass")]]),
      0,
    );
    expect(readiness.series[0]?.reasons?.[0]).toContain("baseline");
    expect(readiness.ready).toBe(false);
  });

  it("an UNVERIFIED observation blocks the ship — recorded doubt is enforced doubt (arch-review 47 P0-3)", () => {
    // The pass RAN its observation and states that no receipt vouches for what its judges read (an ingest
    // batch, a ledger outage at judging time). The 46차 reading treated that as "says nothing" — which made
    // unvouched evidence implicitly green on the strictest surface. It is not_comparable now; only a LEGACY
    // pin (no observation at all — pre-feature history) still says nothing, pinned below.
    const unverified = {
      revision: 2,
      scorePlaneDigest: "sha256:plane",
      inputObservation: { setDigest: "sha256:judged", completed: false },
    };
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", { ...point("sc-2", 0.95), scoring: unverified }]]),
      new Map([["quality", resolved("sc-1", 0.9)]]),
      new Map([["quality", gate("pass")]]),
      0,
    );
    expect(readiness.series[0]?.verdict).toBe("not_comparable");
    expect(readiness.series[0]?.reasons?.[0]).toContain("no receipt vouches");
    expect(readiness.ready).toBe(false);
  });

  it("a LEGACY pin blocks the ship too — nothing states what its judges read (owner decision); a re-score revouches it", () => {
    const legacy = { revision: 2, scorePlaneDigest: "sha256:plane" };
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", { ...point("sc-2", 0.95), scoring: legacy }]]),
      new Map([["quality", resolved("sc-1", 0.9)]]),
      new Map([["quality", gate("pass")]]),
      0,
    );
    expect(readiness.series[0]?.verdict).toBe("not_comparable");
    expect(readiness.series[0]?.reasons?.[0]).toContain("predates judgment input observation");
    expect(readiness.ready).toBe(false);
  });

  it("a comparable pair with NO gate reading refuses — the seam being unconfigured is never a pass", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", point("sc-2", 0.9)]]),
      new Map([["quality", resolved("sc-1", 0.8)]]),
      new Map(), // no gate reading handed in
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "not_comparable", regressed: true });
    expect(readiness.ready).toBe(false);
  });

  it("blocked_missing and not_comparable from the gate block exactly like a regression", () => {
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([
        ["quality", point("sc-2", 0.9)],
        ["latency", point("sc-4", 0.9)],
      ]),
      new Map([
        ["quality", resolved("sc-1", 0.8)],
        ["latency", resolved("sc-3", 0.9)],
      ]),
      new Map([
        ["quality", gate("blocked_missing", ["the candidate skipped 2 of the baseline's cases"])],
        ["latency", gate("not_comparable", ["experiment identity confounded: judge_set"])],
      ]),
      0,
    );
    expect(readiness.regressedSeries).toEqual(["quality", "latency"]);
    expect(readiness.ready).toBe(false);
  });

  it("stays not-ready while linked issues are open even when every series holds", () => {
    const readiness = releaseReadiness(release(), product(), new Map(), new Map(), new Map(), 2);
    expect(readiness.openIssues).toBe(2);
    expect(readiness.ready).toBe(false);
  });
});

// arch-review 12 P0. A release is "a date and a scope somebody committed to", and the scope was re-derived
// from the product's CURRENT series on every read — so deleting a series did not FAIL the gate, it DELETED
// it. Every test here PASSES on the old `filter` and is the bypass sitting underneath every invariant above.
describe("release scope — a promised gate cannot be deleted into a pass", () => {
  const planned = (keys: string[], mode: "all" | "explicit" = "explicit"): ReleaseRecord => ({
    ...release(mode === "explicit" ? keys : undefined),
    plannedSeriesKeys: keys,
    seriesSelection: mode,
  });

  it("BLOCKS when a promised series is gone from the product — never an empty watch list and ready", () => {
    const gutted = { ...product(), series: [] }; // the edit that used to make a red release green
    const readiness = releaseReadiness(planned(["quality"]), gutted, new Map(), new Map(), new Map(), 0);
    expect(readiness.series).toHaveLength(1);
    expect(readiness.series[0]).toMatchObject({ key: "quality", verdict: "scope_invalid", regressed: true });
    expect(readiness.ready).toBe(false);
  });

  it("blocks regardless of requiredForRelease — the flag lives on the declaration that disappeared", () => {
    // Otherwise the same edit that removes the gate also gets to decide the gate never mattered.
    const gutted = { ...product([{ requiredForRelease: false }]), series: [] };
    const readiness = releaseReadiness(planned(["quality"]), gutted, new Map(), new Map(), new Map(), 0);
    expect(readiness.series[0]).toMatchObject({ verdict: "scope_invalid", required: true, regressed: true });
  });

  it("an `all` release keeps watching series ADDED after it was planned — more gates is never unsafe", () => {
    const readiness = releaseReadiness(
      planned(["quality"], "all"), // planned when only `quality` existed
      product(), // …and `latency` has since been added
      new Map(),
      new Map(),
      new Map(),
      0,
    );
    expect(readiness.series.map((s) => s.key).sort()).toEqual(["latency", "quality"]);
  });

  it("protects a release planned BEFORE the freeze existed, from its live selection alone", () => {
    // No plannedSeriesKeys — the degraded path still refuses to filter a named series into nothing.
    const gutted = { ...product(), series: [] };
    const readiness = releaseReadiness(release(["quality"]), gutted, new Map(), new Map(), new Map(), 0);
    expect(readiness.series[0]).toMatchObject({ verdict: "scope_invalid", regressed: true });
  });

  it("says nothing when the promise still holds — the guard is silent on the healthy path", () => {
    const readiness = releaseReadiness(planned(["quality"]), product(), new Map(), new Map(), new Map(), 0);
    expect(readiness.series.every((s) => s.verdict !== "scope_invalid")).toBe(true);
  });
});

// arch-review 13 P0. `seriesKey` is the TREND's identity — deliberately stable so relabeling never re-keys
// history — and readiness selected release evidence by it. So editing a series to a new dataset/harness/judge
// left yesterday's green standing as today's evidence: the same key, a different question. Worse for
// version-less refs, where `latest` moves with the product row untouched, so no CAS and no policy digest
// could ever see it. Every test here PASSES on the key-only selection.
describe("series evaluation contract — evidence must answer the question the series asks NOW", () => {
  const CONTRACT = "sha256:today";
  const OLD = "sha256:yesterday";
  const plan = {
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1.0.0" },
    judges: [],
  };
  const contracts = new Map<string, SeriesContractResolution>([
    ["quality", { status: "resolved", digest: CONTRACT, contract: plan, documents: [] }],
  ]);

  const pointWith = (digest?: string): SeriesScorecardPoint => ({
    scorecardId: "sc-1",
    passRate: 1,
    createdAt: NOW,
    // Input-trust-neutral, like point(): these tests are about the CONTRACT axis.
    scoring: { revision: 1, scorePlaneDigest: "sha256:plane", inputObservation: { completed: true } },
    ...(digest !== undefined ? { contractDigest: digest } : {}),
  });

  it("BLOCKS when the newest evidence ran under a different contract — a green answer to another question", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", pointWith(OLD)]]),
      new Map(),
      new Map(),
      0,
      contracts,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "contract_stale", regressed: true });
    expect(readiness.ready).toBe(false);
  });

  it("BLOCKS unstamped evidence too — a batch that cannot say which question it answered is not current", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", pointWith(undefined)]]),
      new Map(),
      new Map(),
      0,
      contracts,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "contract_stale", regressed: true });
    expect(readiness.series[0]?.reasons?.[0]).toContain("does not record");
  });

  it("passes evidence produced under the CURRENT contract", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", pointWith(CONTRACT)]]),
      new Map(),
      new Map(),
      0,
      contracts,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "no_baseline", regressed: false });
  });

  it("ABSTAINS when the deployment cannot resolve the contract — never blocks on our own inability to look", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", pointWith(OLD)]]),
      new Map(),
      new Map(),
      0,
      new Map(), // no entry — this deployment has no resolver at all
    );
    expect(readiness.series[0]?.verdict).not.toBe("contract_stale");
  });

  // arch-review 14 P0: "we could not resolve the question" travelled to "do not check the answer", which is
  // the unknown→absence→safe collapse in the one place that decides whether a release ships. A deleted
  // dataset or a registry outage made stale evidence pass, in the direction of green.
  it("BLOCKS when the current contract cannot be resolved — unknown is never green", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product([{ allowNoBaseline: true }]),
      new Map([["quality", pointWith(CONTRACT)]]), // evidence that would otherwise pass
      new Map(),
      new Map(),
      0,
      new Map([["quality", { status: "unresolvable", reason: "dataset 'support' was deleted" }]]),
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "contract_unverifiable", regressed: true });
    expect(readiness.series[0]?.reasons?.[0]).toContain("deleted");
    expect(readiness.ready).toBe(false);
  });
});

// The identity itself: a judge REORDER is not a different question, and a version change is.
describe("seriesContractDigest — what counts as the same question", () => {
  const base = {
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "2.0.0" },
    judges: [
      { id: "quality", version: "1.0.0" },
      { id: "safety", version: "1.0.0" },
    ],
  };
  it("is stable under judge ORDER — a selection is a set, and a reorder is not a contract change", () => {
    expect(seriesContractDigest(base)).toBe(seriesContractDigest({ ...base, judges: [...base.judges].reverse() }));
  });
  it("moves when a resolved version moves — which is what `latest` drifting looks like", () => {
    expect(seriesContractDigest({ ...base, dataset: { id: "d", version: "2.0.0" } })).not.toBe(
      seriesContractDigest(base),
    );
  });
});
