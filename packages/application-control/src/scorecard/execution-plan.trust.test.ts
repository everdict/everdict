import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase, HarnessSpec, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { ExecutionPlan } from "./execution-plan.js";

// Trust suite (docs/trust-certification.md) — TRUST-119 · TRUST-120.
//
// ONE PLAN, CONSUMED MANY TIMES — NEVER RE-DERIVED.
//
// Submit seals an identity; four later paths (the Temporal plan, the in-process resume, a retry, a re-score)
// execute under it. Each used to reconstruct that identity by hand off the manifest: read the facets it knew
// about, verify the ones it checked, carry the ones it carried. The defect that produces is not exotic — it
// is the last four waves of this review series, every one of them a field that existed and one consumer that
// had not been taught about it: verification on the resume path but not the Temporal one (18 P0-2), model
// pins on the Temporal job but not the in-process one (20 P0-2), harness model digests in the series contract
// type but not its digest (21 P0-1).
//
// Every one was found by a reviewer. None could be found by a compiler, because reconstruction is not a type
// error. So the facets get ONE owner, and the second half of this file is the part that keeps it that way.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const CASE = { id: "c1", graders: [{ id: "tests-pass" }] } as unknown as Pick<EvalCase, "id" | "graders">;
const SPEC = { kind: "command", id: "cli", version: "1.0.0", command: "run" } as unknown as HarnessSpec;

const sealed = (over: Partial<ScorecardRecord["manifest"]> = {}): ScorecardRecord =>
  ({
    id: "sc-1",
    harness: { id: "cli", version: "1.0.0" },
    manifest: {
      identityVersion: 1,
      dataset: { id: "d", version: "1.0.0", digest: "sha256:ds" },
      cases: { c1: contentDigest({ ...CASE, graders: undefined }) },
      gradingCases: { c1: contentDigest(CASE.graders) },
      harness: {
        id: "cli",
        version: "1.0.0",
        specDigest: contentDigest(SPEC),
        modelDigest: "sha256:model",
        serviceModelDigests: { api: "sha256:svc" },
      },
      judges: [{ id: "quality", version: "1.0.0", specDigest: "sha256:judge" }],
      judgeRunModelDigest: "sha256:judge-run",
      ...over,
    },
  }) as unknown as ScorecardRecord;

describeTrust("TRUST-119 — the plan is the one reader of what a batch sealed", () => {
  it("refuses a selection that gained, lost or changed a case", () => {
    const plan = ExecutionPlan.of(sealed());
    expect(() => plan.assertSelection([CASE])).not.toThrow();
    expect(() => plan.assertSelection([CASE, { id: "c2", graders: [] } as never])).toThrow(/CONFLICT|no longer/);
    expect(() => plan.assertSelection([])).toThrow();
    expect(() => plan.assertSelection([{ ...CASE, graders: [{ id: "other" }] } as never])).toThrow();
  });

  it("refuses a harness document that moved — and does NOT read an empty case list as a deletion", () => {
    const plan = ExecutionPlan.of(sealed());
    // The harness check runs at a different moment from the selection check on both paths, so it must not
    // drag the selection half in with an empty list — that would refuse every harness verification.
    expect(() => plan.assertHarness(SPEC)).not.toThrow();
    expect(() => plan.assertHarness({ ...SPEC, command: "something else" } as never)).toThrow();
  });

  it("carries every model DOCUMENT the manifest pinned, in the shape the job takes", () => {
    // The three live at two levels of the manifest and are consumed by two different dispatcher seams; a
    // consumer assembling them by hand is exactly how one of them reached a single execution path.
    expect(ExecutionPlan.of(sealed()).modelPins).toEqual({
      model: "sha256:model",
      serviceModels: { api: "sha256:svc" },
      judgeRun: "sha256:judge-run",
    });
    expect(ExecutionPlan.of(sealed()).sealedJudges).toEqual([
      { id: "quality", version: "1.0.0", specDigest: "sha256:judge" },
    ]);
  });

  it("a record sealed before any of this verifies nothing and carries nothing — never a claim of sameness", () => {
    const legacy = { id: "sc-0", harness: { id: "cli", version: "1.0.0" } } as unknown as ScorecardRecord;
    const plan = ExecutionPlan.of(legacy);
    expect(() => plan.assertSelection([CASE])).not.toThrow();
    expect(plan.modelPins).toBeUndefined();
    expect(plan.sealedJudges).toBeUndefined();
  });
});

describeTrust("TRUST-120 — no execution path re-derives the plan", () => {
  // The structural half. A decision function with one owner stays correct; a decision function anyone may
  // re-implement drifts, and this package has proved that four times. So the sealed facets are readable in
  // exactly one file, and this test is what says so — a compiler cannot.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");

  const sources = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
      }
    };
    walk(root);
    return out;
  };

  // Where each facet is ALLOWED to be read: the plan (the reader), and the sealer that writes it.
  const OWNED: Array<{ pattern: RegExp; what: string; allow: string[] }> = [
    { pattern: /manifest\??\.harness\.modelDigest/, what: "the harness model pin", allow: ["execution-plan.ts"] },
    {
      pattern: /manifest\??\.harness\.serviceModelDigests/,
      what: "the per-service model pins",
      allow: ["execution-plan.ts"],
    },
    { pattern: /manifest\??\.judgeRunModelDigest/, what: "the judge-run model pin", allow: ["execution-plan.ts"] },
    {
      pattern: /verifySealedSelection\s*\(/,
      what: "sealed-document verification",
      allow: ["execution-plan.ts"],
    },
    {
      pattern: /pinHarnessSpecToClosure\s*\(/,
      what: "applying the sealed model closure to a spec",
      allow: ["execution-plan.ts", "scorecard-plan.ts", "scorecard-service.ts"],
    },
  ];

  for (const { pattern, what, allow } of OWNED)
    it(`${what} is read in one place`, () => {
      const offenders = sources()
        .filter((file) => !allow.some((name) => file.endsWith(name)))
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => path.relative(root, file));
      expect(offenders).toEqual([]);
    });
});
