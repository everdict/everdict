import type { Dataset, EvalCase, HarnessSpec, ScorecardManifest } from "@everdict/contracts";
import { contentDigest, sealGrading, verifySealedCaseDocuments, verifySealedSelection } from "@everdict/domain";
import { describe, expect, it } from "vitest";

// Trust suite (docs/trust-certification.md) — TRUST-72 · TRUST-73.
//
// THE DOCUMENT A BATCH RE-READS IS THE DOCUMENT IT SEALED.
//
// A registry version is immutable inside ONE namespace, and lookup is owner-first with a `_shared` fallback —
// so `support@1` has a hidden third coordinate: which namespace answered. Everything that re-resolves after
// submit (the Temporal plan, a resume, a retry, a detached re-score) reads by (tenant, id, version), so a
// workspace registering its own `support@1` afterwards silently hands those paths different bytes under the
// same name. The manifest keeps certifying the original.
//
// Resume is the sharpest form: finished cases are kept and only the unfinished ones re-run, so ONE scorecard
// can hold cases evaluated under two different datasets — two experiments inside one revision, certified as
// one. That is not a weakened reproducibility claim; it is a false one.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const caseOf = (task: string, graders: EvalCase["graders"] = []): EvalCase =>
  ({ id: "c1", env: { kind: "prompt" }, task, graders, timeoutSec: 60, tags: [] }) as unknown as EvalCase;

const harnessOf = (command: string): HarnessSpec =>
  ({
    kind: "command",
    id: "agent",
    version: "1",
    command,
    model: { ref: "m" },
    trace: { kind: "none" },
    setup: [],
    params: {},
  }) as unknown as HarnessSpec;

// The manifest as SUBMIT seals it — same functions, so the fixture cannot drift from production.
const sealedManifest = (dataset: Dataset, spec: HarnessSpec): ScorecardManifest =>
  ({
    identityVersion: 1,
    dataset: { id: dataset.id, version: dataset.version, digest: contentDigest(dataset.cases) },
    cases: Object.fromEntries(dataset.cases.map((c) => [c.id, contentDigest({ ...c, graders: undefined })])),
    ...sealGrading(undefined, dataset.cases),
    harness: { id: spec.id, version: spec.version, specDigest: contentDigest(spec) },
  }) as unknown as ScorecardManifest;

const datasetOf = (cases: EvalCase[]): Dataset => ({ id: "support", version: "1.0.0", cases, tags: [] });

describeTrust("TRUST-72/73 — a shadowed registry document cannot execute under a held name", () => {
  const original = datasetOf([caseOf("book a flight to Seoul")]);
  const spec = harnessOf("run {{task}}");
  const manifest = sealedManifest(original, spec);

  it("holds when the same documents come back — the guard is a check, not a wall", () => {
    expect(verifySealedSelection(manifest, { cases: original.cases, harnessSpec: spec })).toEqual([]);
  });

  it("TRUST-72 — a shadowed DATASET is caught: the tasks are the question", () => {
    const shadowed = datasetOf([caseOf("book a train to Busan")]);
    const mismatches = verifySealedSelection(manifest, { cases: shadowed.cases });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ subject: "dataset_case", id: "c1" });
  });

  it("TRUST-72 — …and so is a shadow that changes only what a case is GRADED by", () => {
    // The case content is byte-identical; only the default graders moved. Sealed on its own axis precisely so
    // this cannot hide behind an unchanged task — a change to the graders is a change to what "passed" means.
    const regraded = datasetOf([caseOf("book a flight to Seoul", [{ id: "answer-match", config: { expect: "x" } }])]);
    const mismatches = verifySealedSelection(manifest, { cases: regraded.cases });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ subject: "grading", id: "c1" });
  });

  it("TRUST-73 — a shadowed HARNESS is caught even with an identical model closure", () => {
    // Same id, same version, same `model: {ref}` — a different script. The closure pin cannot see this, which
    // is why the document's own digest has to be verified rather than assumed from an immutable version.
    const mismatches = verifySealedSelection(manifest, {
      cases: original.cases,
      harnessSpec: harnessOf("run --v2 {{task}}"),
    });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ subject: "harness" });
  });

  it("TRUST-74 — an ADDED case is caught: the sealed selection is part of the document", () => {
    // The membership hole. The first version walked the ACTUAL cases and compared any the manifest also had,
    // so a shadow that added a case had nothing to compare it to and slipped through — the batch would then
    // run a selection the manifest does not certify, with `requested` still describing the old one.
    const grown = datasetOf([caseOf("book a flight to Seoul"), caseOf("and a hotel")]);
    grown.cases[1] = { ...grown.cases[1], id: "c2" } as EvalCase;
    const mismatches = verifySealedSelection(manifest, { cases: grown.cases });
    expect(mismatches).toEqual([{ subject: "selection", id: "c2", sealed: "absent", current: "present" }]);
  });

  it("TRUST-74 — and a REMOVED case is caught, which the old loop could never even meet", () => {
    const shrunk = verifySealedSelection(manifest, { cases: [] });
    expect(shrunk).toEqual([{ subject: "selection", id: "c1", sealed: "present", current: "absent" }]);
  });

  it("TRUST-75 — a re-score whose judged case vanished from the current dataset refuses", () => {
    // The sharpest form: the pass has ALREADY stripped that case's judge rows when the judge stream skips it
    // for having no EvalCase, so the case ends the pass with its verdict deleted and nothing in its place.
    const gone = verifySealedCaseDocuments(manifest, ["c1"], []);
    expect(gone).toEqual([{ subject: "selection", id: "c1", sealed: "present", current: "absent" }]);
    // …while a dataset that legitimately GREW is not a change to any judged case.
    const grown = datasetOf([caseOf("book a flight to Seoul"), caseOf("new case")]);
    grown.cases[1] = { ...grown.cases[1], id: "c2" } as EvalCase;
    expect(verifySealedCaseDocuments(manifest, ["c1"], grown.cases)).toEqual([]);
  });

  it("a legacy manifest with no per-case seal verifies nothing rather than inventing a comparison", () => {
    // Absence here is a GENERATION gap, not a claim of sameness — reporting drift the seal never claimed to
    // exclude would make every pre-split batch unresumable.
    const legacy = {
      dataset: manifest.dataset,
      harness: { id: "agent", version: "1" },
    } as unknown as ScorecardManifest;
    expect(verifySealedSelection(legacy, { cases: datasetOf([caseOf("anything else")]).cases })).toEqual([]);
  });
});
