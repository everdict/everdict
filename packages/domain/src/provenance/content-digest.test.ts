import { describe, expect, it } from "vitest";
import { contentDigest } from "./content-digest.js";

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
});
