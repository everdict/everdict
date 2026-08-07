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
