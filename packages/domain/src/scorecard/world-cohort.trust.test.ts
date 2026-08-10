import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { crossWorldReason, worldCohortDigest, worldCohortOf } from "./world-cohort.js";

// Trust suite (docs/trust-certification.md) — TRUST-102.
//
// THE WORLD IS A COMPARISON AXIS, NOT AN IDENTITY.
//
// The evaluation contract seals what is being ASKED. Where it ran is a different question, and folding it in
// would be the too-broad guard: every infrastructure move would invalidate a product's whole evidence base,
// and a signal that cries wolf on migrations is one people route around. That decision stands.
//
// What was missing is the other half. With no world axis at all, two runs of one contract on different
// operating systems or drivers land on the same trend line as though nothing differed — so a regression
// caused by a migration is indistinguishable, afterwards, from one caused by the change. Stratify: compare
// within a cohort, and when a comparison crosses one, SAY so.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const ran = (os: "linux" | "windows" | "macos", driver?: string): CaseResult =>
  ({
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [],
    execution: { os, osResolved: "declared", ...(driver ? { driver } : {}) },
  }) as unknown as CaseResult;

const ranNowhere = (): CaseResult =>
  ({
    caseId: "c2",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [],
  }) as unknown as CaseResult;

describeTrust("TRUST-102 — a cross-world comparison says so, and a same-world one stays silent", () => {
  it("derives the cohort from what the cases reported, and claims nothing when none did", () => {
    expect(worldCohortOf([ran("linux", "docker")])).toMatchObject({
      os: "linux",
      drivers: ["docker"],
      mixed: false,
      observed: 1,
    });
    // A batch whose cases never ran in a recorded world has NO cohort — absence is "not recorded", never
    // "linux", which is the same rule the per-case execution manifest already lives by.
    expect(worldCohortOf([ranNowhere()])).toBeUndefined();
  });

  it("a batch spread over two operating systems is MIXED, not a majority", () => {
    const cohort = worldCohortOf([ran("linux"), ran("windows")]);
    expect(cohort?.mixed).toBe(true);
    expect(cohort?.os).toBeUndefined(); // picking one would be inventing agreement
  });

  it("the same world compares silently — the axis must not fire on every release", () => {
    const a = worldCohortOf([ran("linux", "docker")]);
    const b = worldCohortOf([ran("linux", "docker")]);
    expect(worldCohortDigest(a)).toBe(worldCohortDigest(b));
    expect(crossWorldReason(a, b)).toBeUndefined();
  });

  it("a DIFFERENT world names itself — a difference across it cannot be attributed to the change", () => {
    const reason = crossWorldReason(worldCohortOf([ran("linux")]), worldCohortOf([ran("windows")]));
    expect(reason).toContain("different execution worlds");
    expect(reason).toContain("linux");
    expect(reason).toContain("windows");
  });

  it("an UNRECORDED world is not a known difference — legacy evidence does not read as suspect", () => {
    // Otherwise every comparison against a batch from before this existed would carry the warning, which is
    // how a true signal becomes noise.
    expect(crossWorldReason(undefined, worldCohortOf([ran("linux")]))).toBeUndefined();
    expect(crossWorldReason(worldCohortOf([ran("linux")]), undefined)).toBeUndefined();
  });
});
