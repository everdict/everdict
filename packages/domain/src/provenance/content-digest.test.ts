import { EvalCaseSchema, ScoreSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { contentDigest, digestHex, digestUnder, digestsMatch } from "./content-digest.js";

describe("contentDigest — canonical identity stamp", () => {
  it("is key-order independent and undefined-stripping (shape canonicalization)", () => {
    expect(contentDigest({ a: 1, b: "x" })).toBe(contentDigest({ b: "x", a: 1 }));
    expect(contentDigest({ a: 1 })).toBe(contentDigest({ a: 1, gone: undefined }));
  });

  it("is order-SENSITIVE for arrays and distinguishes null from absence", () => {
    expect(contentDigest([1, 2])).not.toBe(contentDigest([2, 1]));
    expect(contentDigest({ a: null })).not.toBe(contentDigest({}));
  });

  it("refuses a top-level undefined with a typed error instead of a bare TypeError", () => {
    // Pre-fix: canonicalize(undefined) returned the VALUE undefined (JSON.stringify's honest answer typed as
    // string) and .length blew up as a TypeError far from the caller.
    expect(() => contentDigest(undefined)).toThrow(/JSON-serializable document/);
  });

  it("stays stable for the shapes provenance actually stamps (a policy-like document)", () => {
    const policy = { id: "authority-ladder", version: "1.0.0", metrics: [{ match: { metric: "state" } }] };
    expect(contentDigest(policy)).toBe(contentDigest(JSON.parse(JSON.stringify(policy))));
  });

  it("stamps sha256 — an algorithm-prefixed 64-hex digest, never a bare FNV word", () => {
    // Given any document; then the NEW stamp names its algorithm, so a reader can tell the eras apart.
    expect(contentDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digestHex strips the algorithm prefix so a short content identity keeps 12 characters of identity", () => {
    const digest = contentDigest({ a: 1 });
    expect(digestHex(digest)).toBe(digest.slice("sha256:".length));
    expect(digestHex("0123456789abcdef")).toBe("0123456789abcdef"); // a legacy stamp has no prefix to strip
  });
});

describe("digestsMatch — dual-read verification (a stamp is verified under its OWN algorithm)", () => {
  // The exact FNV-1a stamp the pre-sha256 sealer wrote for this document — a stored fixture, never
  // regenerated: it stands in for every row sealed before sha256 existed.
  const LEGACY_DOCUMENT = { id: "authority-ladder", version: "1.0.0", metrics: [{ match: { metric: "state" } }] };
  const LEGACY_STAMP = "c5e5c158210d0f5a";

  it("verifies a legacy 16-hex stamp against its document forever (history keeps verifying)", () => {
    // Regression: comparing everything against contentDigest() would fail every pre-sha256 stamp closed —
    // and for the fail-closed policy resolver, a closed stamp means the batch's verdicts vanish.
    expect(digestsMatch(LEGACY_STAMP, LEGACY_DOCUMENT)).toBe(true);
  });

  it("verifies a new sha256 stamp against its document", () => {
    expect(digestsMatch(contentDigest(LEGACY_DOCUMENT), LEGACY_DOCUMENT)).toBe(true);
  });

  it("refuses a tampered document under BOTH algorithms", () => {
    const tampered = { ...LEGACY_DOCUMENT, metrics: [{ match: { metric: "tests_pass" } }] };
    expect(digestsMatch(LEGACY_STAMP, tampered)).toBe(false);
    expect(digestsMatch(contentDigest(LEGACY_DOCUMENT), tampered)).toBe(false);
  });

  it("refuses an unrecognized stamp format instead of guessing an algorithm (fail closed)", () => {
    expect(digestsMatch("md5:whatever", LEGACY_DOCUMENT)).toBe(false);
    expect(digestsMatch("", LEGACY_DOCUMENT)).toBe(false);
  });

  it("digestUnder reports the current digest in the stamp's algorithm, so a verification can show both", () => {
    // A verification that displayed a sha256 `current` beside a legacy `stored` would read as a mismatch
    // that is only an algorithm change.
    expect(digestUnder(LEGACY_STAMP, LEGACY_DOCUMENT)).toBe(LEGACY_STAMP);
    expect(digestUnder(contentDigest(LEGACY_DOCUMENT), LEGACY_DOCUMENT)).toBe(contentDigest(LEGACY_DOCUMENT));
  });
});

// A digest is only re-derivable if the SAME canonical form is produced at seal time and at verify time. Two
// things can break that without anyone noticing, and both are read-time rewrites rather than edits: a Zod
// `.default()` filling a field the raw document never had, and the Score normalizer (`ScoreSchema`'s
// z.preprocess) rewriting a pre-status score row on its way in. These tests pin the rule that keeps both
// harmless — digest the SCHEMA-PARSED document, and never digest a subject that carries scores.
describe("what a digest may be computed over", () => {
  const rawCase = { id: "c1", env: { kind: "prompt" }, task: "do the thing" };

  it("parse is what a digest must be taken over — the raw document hashes differently", () => {
    // EvalCaseSchema fills graders/tags/timeoutSec by `.default()`, so the parsed document is genuinely a
    // different document from the raw one. Both the seal (registry-resolved dataset) and the verify (the same
    // registry read) hand over parsed cases, which is the only reason the two agree.
    const parsed = EvalCaseSchema.parse(rawCase);
    expect(contentDigest(parsed)).not.toBe(contentDigest(rawCase));
    // …and parsing is idempotent, so re-reading the same registry row never drifts the digest.
    expect(contentDigest(EvalCaseSchema.parse(parsed))).toBe(contentDigest(parsed));
  });

  it("the Score normalizer really does rewrite a legacy row — which is why no digest subject carries scores", () => {
    // A genuine pre-status score row: the `[grader-error]` detail sentinel plus the placeholder value the
    // union removed. Reading it back through ScoreSchema stamps a status and drops the value, so a digest
    // taken over a parsed result would NOT match one taken over the raw jsonb for any pre-union batch.
    const legacyScore = { graderId: "tests", metric: "tests_pass", value: 0, detail: "[grader-error] boom" };
    const normalized = ScoreSchema.parse(legacyScore);
    expect(contentDigest(normalized)).not.toBe(contentDigest(legacyScore));

    // The manifest's subjects are case bundles, resolved harness/judge specs, grading plans and policy
    // documents — none of which can hold a Score (ScoreSchema is referenced by exactly one field in
    // contracts: CaseResult.scores), and a CaseResult is never digested. So the rewrite above cannot move a
    // byte under any stamp we take. A future subject that DOES embed scores must digest the parsed form.
    const bundle = [EvalCaseSchema.parse(rawCase)];
    expect(JSON.stringify(bundle)).not.toContain("grader-error");
    expect(digestsMatch(contentDigest(bundle), bundle)).toBe(true);
  });
});
