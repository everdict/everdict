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

  it("refuses when the sealed harness has VANISHED — absence is not a built-in", () => {
    // `embedHarnessSpec` turns a registry NotFound into `undefined` so an unregistered/built-in harness can
    // still be dispatched by id, and a batch that never sealed a document arrives the same way. The manifest
    // is what tells them apart: a `specDigest` is proof a registry document was read here.
    expect(() => ExecutionPlan.of(sealed()).assertHarness(undefined)).toThrow(/no longer registered/);
    // …while a batch that sealed no harness document keeps dispatching by id, exactly as at submit.
    const builtin = sealed({
      harness: { id: "cli", version: "1.0.0" },
    } as never);
    expect(() => ExecutionPlan.of(builtin).assertHarness(undefined)).not.toThrow();
  });

  it("the re-score variant asks a DIFFERENT question of the same artifact", () => {
    const plan = ExecutionPlan.of(sealed());
    // A larger current dataset is fine — re-score judges the cases that already have results…
    expect(() => plan.assertJudgedCases(["c1"], [CASE, { id: "c2", graders: [] } as never])).not.toThrow();
    // …but one of THOSE going missing is not.
    expect(() => plan.assertJudgedCases(["c1"], [])).toThrow();
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

  it("an UNSEALED record does not execute — absence stopped being a tolerated state", () => {
    // It used to pass every check by having nothing to check, which is the shape this review generation has
    // removed everywhere else. "A record from before sealing" is a statement about our history, not a reason
    // to run a batch whose identity nobody can state.
    const legacy = { id: "sc-0", harness: { id: "cli", version: "1.0.0" } } as unknown as ScorecardRecord;
    const plan = ExecutionPlan.of(legacy);
    expect(() => plan.assertSelection([CASE])).toThrow(/sealed no execution identity/);
    expect(() => plan.assertJudgedCases(["c1"], [CASE])).toThrow(/sealed no execution identity/);
    // The READS stay honest — nothing pinned, nothing carried. Refusing to execute and lying about what was
    // sealed are different things.
    expect(plan.modelPins).toBeUndefined();
    expect(plan.sealedJudges).toBeUndefined();
  });

  it("a manifest with no ERA declared does not execute — rules it may never have followed", () => {
    const noEra = sealed();
    const record = { ...noEra, manifest: { ...noEra.manifest, identityVersion: undefined } } as ScorecardRecord;
    expect(() => ExecutionPlan.of(record).assertSelection([CASE])).toThrow(/identity era/);
  });

  it("a RETRY carries the source's seal — the same experiment, not a new one and not an unsealed one", () => {
    // A retry re-runs the source's experiment, and the record used to inherit its lineage without its
    // identity: `retryOf` said which batch it came from while the new record could not state what it WAS.
    // Sealing a second time would be worse than not sealing — it would re-resolve today's registry and turn a
    // retry into a different question.
    const source = sealed();
    const retry = { id: "sc-retry", harness: source.harness, manifest: source.manifest } as ScorecardRecord;
    expect(() => ExecutionPlan.of(retry).assertSelection([CASE])).not.toThrow();
    expect(ExecutionPlan.of(retry).modelPins).toEqual(ExecutionPlan.of(source).modelPins);
  });

  it("a manifest with no PER-CASE seal does not execute — the selection would be unverifiable", () => {
    const noCases = sealed();
    const record = { ...noCases, manifest: { ...noCases.manifest, cases: undefined } } as ScorecardRecord;
    expect(() => ExecutionPlan.of(record).assertSelection([CASE])).toThrow(/per-case documents/);
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
    // …and the facets the claim named but the scan did not check (arch-review 22 P1). A guarantee whose name
    // is wider than its implementation is the same defect one level up: it tells the next author the question
    // has been asked when it has not.
    {
      pattern: /verifySealedCaseDocuments\s*\(/,
      what: "re-score selection verification",
      allow: ["execution-plan.ts"],
    },
    // THE WHOLE CLAIM, not a sample of it (arch-review 22 P1). The scan named a handful of facets while the
    // test was called "no execution path re-derives the plan" — a guarantee whose name is wider than its
    // implementation, which is the same defect one level up: it tells the next author the question has been
    // asked. Reading ANY sealed facet off a record's manifest is now the violation.
    //
    // Two files are allowed to, and for opposite reasons: `scorecard-service.ts` WRITES the manifest at
    // submit, and `scorecard-score-service.ts` REWRITES the judge closure on a re-score. Authorship is not
    // reconstruction — the plan is the reader, not the owner of the bytes.
    {
      pattern:
        /\bmanifest\??\.(cases|gradingCases|grading|harness|judges|judgeRun|judgeRunModelDigest|verdictPolicy|dataset)\b/,
      what: "any sealed manifest facet",
      // `campaign-service.ts` reads ONE facet and re-derives nothing (arch-review 71 P0-evolution): the
      // candidate's sealed `harness.specDigest`, recorded onto the round as WHAT WAS EVALUATED so an
      // adoption can be checked against the bytes rather than against a version label. It executes nothing
      // from the manifest — no selection, no pins, no closure — which is the distinction this guard is
      // about: re-deriving the plan is forbidden, quoting the seal's own answer for the record is not.
      allow: [
        "execution-plan.ts",
        "scorecard-service.ts",
        "scorecard-score-service.ts",
        "evolution/campaign-service.ts",
      ],
    },
  ];

  for (const { pattern, what, allow } of OWNED)
    it(`${what} is read in one place`, () => {
      // CODE lines only. This file's own subject matter gets discussed in prose all over the package, and a
      // scan that reads comments reports the explanation of a rule as a violation of it — which trains
      // people to widen the allow-list until the guard means nothing.
      const codeOf = (file: string): string =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
            // …and TRAILING comments, which is where this package explains a field beside the field.
            const comment = line.indexOf("//");
            return comment === -1 ? line : line.slice(0, comment);
          })
          .join("\n");
      const offenders = sources()
        .filter((file) => !allow.some((name) => file.endsWith(name)))
        .filter((file) => pattern.test(codeOf(file)))
        .map((file) => path.relative(root, file));
      expect(offenders).toEqual([]);
    });
});
