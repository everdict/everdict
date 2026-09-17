import { describe, expect, it } from "vitest";
import { IssueLinkSchema, issueLinkDefects, normaliseIssueLinkId, sameIssueLink } from "./tracker.js";

// ── A COMMIT IS AN ADDRESS, NOT AN ID ────────────────────────────────────────────────────────────────
//
// Every other link kind names something inside the workspace, so its `id` is an id and the reader already
// knows where to look. A commit is the first whose target is somebody's repository, and a sha is unique only
// within one — so a link carrying a sha and nothing else is a pointer that can never be followed, and it
// would be stored, listed and rendered without anything noticing.
describe("a commit link carries the repository, because a sha alone has no address", () => {
  it("refuses a commit link with no repository, and says what is missing", () => {
    expect(issueLinkDefects({ type: "commit", id: "e4fe66e" })).toEqual([
      'a commit link names its repository (`repository`, "owner/name") — a sha alone has no address',
    ]);
  });

  it("refuses a repository that is not owner/name", () => {
    expect(issueLinkDefects({ type: "commit", id: "e4fe66e", repository: "digo-mobile" })).toEqual([
      '`repository` is written "owner/name" (got "digo-mobile")',
    ]);
  });

  // The id IS the sha, so a value that cannot be one is a link that can never resolve. Refusing it at birth
  // is the whole difference between a pointer that 404s (allowed by design — the target may not exist yet)
  // and a pointer that was never an address.
  it("refuses an id that is not sha-shaped", () => {
    for (const id of ["e4fe66", "not-hex-at-all", "zzzzzzz"])
      expect(issueLinkDefects({ type: "commit", id, repository: "PPP-Atelier/digo-mobile" })).toContain(
        "a commit link's id is the sha — hex, 7 to 64 characters",
      );
  });

  it("accepts an abbreviation and a full sha alike", () => {
    for (const id of ["e4fe66e", "e4fe66e8bfcbebc342115226033654cd2280f07b"])
      expect(issueLinkDefects({ type: "commit", id, repository: "PPP-Atelier/digo-mobile" })).toEqual([]);
  });

  // `version` on a commit is a second answer to a question the sha already answers, and two answers is the
  // shape that lets them disagree.
  it("refuses a version on a commit link", () => {
    expect(issueLinkDefects({ type: "commit", id: "e4fe66e", repository: "a/b", version: "1.0.0" })).toContain(
      "a commit link carries no `version` — the sha IS the version",
    );
  });

  // The mirror of the rule that already kept `dataset` on case links only. Without it, a repository on a
  // harness link would be stored and read by nothing — the quiet kind of wrong.
  it("refuses a repository or a host on any other kind", () => {
    expect(issueLinkDefects({ type: "harness", id: "browser-suite", repository: "a/b" })).toEqual([
      "`repository` belongs to commit links only (this link is a harness)",
    ]);
    expect(issueLinkDefects({ type: "issue", id: "i-1", host: "ghe.internal" })).toEqual([
      "`host` belongs to commit links only (this link is a issue)",
    ]);
  });

  it("still holds the case rule it was added beside", () => {
    expect(issueLinkDefects({ type: "case", id: "c1" })).toHaveLength(2);
    expect(issueLinkDefects({ type: "case", id: "c1", dataset: "tb", version: "3" })).toEqual([]);
  });

  it("is a shape the record schema accepts", () => {
    const parsed = IssueLinkSchema.safeParse({
      type: "commit",
      id: "e4fe66e8bfcbebc342115226033654cd2280f07b",
      repository: "PPP-Atelier/digo-mobile",
      addedBy: "dana",
      addedAt: "2026-09-17T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });
});

// ── ONE COMMIT IS ONE LINK, IN WHICHEVER CASE IT WAS WRITTEN ─────────────────────────────────────────
describe("a sha is compared lowercase", () => {
  it("normalises a commit id and leaves every other kind's id alone", () => {
    expect(normaliseIssueLinkId("commit", " E4FE66E ")).toBe("e4fe66e");
    expect(normaliseIssueLinkId("dataset", "Terminal-Bench")).toBe("Terminal-Bench");
  });

  it("treats the same commit written in two cases as one link", () => {
    const lower = { type: "commit" as const, id: "e4fe66e", repository: "a/b" };
    expect(sameIssueLink(lower, { type: "commit", id: "E4FE66E", repository: "a/b" })).toBe(true);
  });
});

// ── THE IDENTITY IS THE WHOLE COORDINATE ────────────────────────────────────────────────────────────
//
// Before `sameIssueLink` existed, `unlink` filtered on type and id alone. The defect was already reachable
// through case links — two datasets can each hold a case called `c1`, and removing one removed both — and a
// second two-part coordinate is what made it worth one owner instead of two comparisons.
describe("two links that differ only in their second coordinate are two links", () => {
  it("does not confuse the same sha in two repositories", () => {
    expect(
      sameIssueLink(
        { type: "commit", id: "abc1234", repository: "acme/app" },
        { type: "commit", id: "abc1234", repository: "acme/api" },
      ),
    ).toBe(false);
  });

  it("does not confuse the same case id in two datasets", () => {
    expect(sameIssueLink({ type: "case", id: "c1", dataset: "tb" }, { type: "case", id: "c1", dataset: "gaia" })).toBe(
      false,
    );
  });
});
