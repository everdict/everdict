import type { IssueChain, IssueRecord } from "@everdict/contracts";
import { ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Issue } from "./issue.js";

// ── DEFAUL-39 S1: THE CHAIN REFUSES (docs/specs/work-chain-invariants-spec.md §2) ────────────────────
//
// Measured 2026-09-18: a session shipped three changes through intent → criteria → code → verification →
// knowledge with NO plan and NO spec. Every gate was green, the record was complete and honest, and the
// design stage did not happen — nothing refused it and nothing noticed. That is the shape the file era paid
// for and wrote down: the design stage ran once in eighteen changes while the system reported it as a note.
//
// ⚠️ THE CENTRAL INVARIANT IS NOT TESTED HERE, AND THAT IS THE POINT. `accept(design, …)` takes `design` as a
// REQUIRED PARAMETER, so "accepted with neither a spec nor a reason there is none" cannot be written by a
// caller at all — there is no runtime path to drive. The compile-time assertion below is its counterexample,
// and a test that constructed the state to check it was refused would be testing a state that cannot exist.
// Unrepresentable beats refused: a refusal lives at a call site somebody might not reach.

const NOW = "2026-09-18T00:00:00.000Z";
const LATER = "2026-09-18T01:00:00.000Z";

function newIssue(chain?: IssueChain): IssueRecord {
  const record = Issue.newIssue({
    id: "iss-1",
    tenant: "acme",
    number: 1,
    identifier: "ENG-1",
    title: "The photo does not open",
    createdBy: "dana",
    now: NOW,
  });
  return chain === undefined ? record : { ...record, chain };
}

// The compile-time half of the invariant. If `design` ever becomes optional, this stops being an error and
// the union has lost the third state it was built to remove — so it is an EXPORTED type-level assertion
// rather than a comment (the repo's own idiom for a guard `noUnusedLocals` would otherwise strip).
type AcceptSignature = Parameters<Issue["accept"]>;
type DesignIsRequired = AcceptSignature extends [infer Design, string, string]
  ? undefined extends Design
    ? "REGRESSED: design became optional, and accepted-with-neither is expressible again"
    : "ok"
  : "REGRESSED: accept's signature changed shape";
// NOT exported (biome refuses an export from a test file) — and it does not need to be: the annotation on
// the const is what forces the check, and the const is read by the assertion below, so `noUnusedLocals` keeps
// it alive without an export.
type DesignIsRequiredGuard = DesignIsRequired extends "ok" ? true : never;
const designIsRequired: DesignIsRequiredGuard = true;

describe("the work chain refuses (DEFAUL-39 S1)", () => {
  it("cannot express an acceptance with no design at all", () => {
    // The whole assertion is that the line above compiles to `true`. A runtime expect is here so the file
    // states its claim in the test output rather than only in the type system.
    expect(designIsRequired).toBe(true);
  });

  it("accepts on a spec, and the design travels on the record", () => {
    const issue = Issue.from(newIssue());
    const { patch } = issue.accept({ kind: "spec", path: "docs/specs/work-chain-invariants-spec.md" }, "dana", NOW);

    expect(patch.chain).toEqual({
      state: "accepted",
      at: NOW,
      by: "dana",
      design: { kind: "spec", path: "docs/specs/work-chain-invariants-spec.md" },
    });
    // The move is in the durable history, so a later refusal to re-accept does not erase when it happened.
    expect(patch.history?.at(-1)).toMatchObject({ by: "dana", detail: { changed: ["chain"], chain: "accepted" } });
  });

  it("accepts on a DECLINATION, which is a decision and not a gap", () => {
    const issue = Issue.from(newIssue());
    const { patch } = issue.accept({ kind: "declined", why: "a one-line rename; the diff is the design" }, "dana", NOW);

    expect(patch.chain).toEqual({
      state: "accepted",
      at: NOW,
      by: "dana",
      design: { kind: "declined", why: "a one-line rename; the diff is the design" },
    });
  });

  // ⚠️ The invariant with teeth. `shipped` is reachable only THROUGH an acceptance, which is what gives a
  // shipped request an acceptance with a TIME behind it — and that time is what the commit-order witness
  // (spec §3, slice S2) compares against. A request that could ship from draft would let a commit claim an
  // acceptance that never happened.
  it("refuses to ship a request nobody accepted, and says so rather than inventing an acceptance", () => {
    const fromDraft = Issue.from(newIssue({ state: "draft" }));
    expect(() => fromDraft.ship("dana", NOW)).toThrow(/only an accepted request ships/);

    const record = newIssue();
    const chainless = Issue.from(record);
    expect(() => chainless.ship("dana", NOW)).toThrow(/predates the work chain and has never been accepted/);

    // …and the world is read back: a refusal that still moved the record is not a refusal. The aggregate
    // returns a patch rather than mutating, so the check is that the record it was built from is untouched.
    expect(() => chainless.ship("dana", NOW)).toThrow(ConflictError);
    expect(record.chain).toBeUndefined();
  });

  it("ships from accepted", () => {
    const accepted = newIssue({ state: "accepted", at: NOW, by: "dana", design: { kind: "declined", why: "small" } });
    const { patch } = Issue.from(accepted).ship("erin", LATER);
    expect(patch.chain).toEqual({ state: "shipped", at: LATER, by: "erin" });
  });

  it("keeps a rejection's reason — the ideas turned down are half of what an intent home is for", () => {
    const issue = Issue.from(newIssue());
    const { patch } = issue.reject("the reporter withdrew it; the photo opens on the current build", "dana", NOW);

    expect(patch.chain).toEqual({
      state: "rejected",
      at: NOW,
      by: "dana",
      reason: "the reporter withdrew it; the photo opens on the current build",
    });
  });

  it("refuses to re-accept, because re-dating an acceptance re-dates every commit that claims it", () => {
    const accepted = newIssue({ state: "accepted", at: NOW, by: "dana", design: { kind: "declined", why: "small" } });
    const issue = Issue.from(accepted);

    expect(() => issue.accept({ kind: "declined", why: "again" }, "erin", LATER)).toThrow(/already accepted/);
    // The original acceptance stands, with its original time and author — re-dating it is the thing refused.
    expect(accepted.chain).toEqual({
      state: "accepted",
      at: NOW,
      by: "dana",
      design: { kind: "declined", why: "small" },
    });
  });

  it("refuses to accept a rejected request without the reversal being on the record", () => {
    const rejected = newIssue({ state: "rejected", at: NOW, by: "dana", reason: "out of scope" });
    const issue = Issue.from(rejected);

    expect(() => issue.accept({ kind: "declined", why: "reconsidered" }, "erin", LATER)).toThrow(
      /move it back to draft/,
    );
    // …and redraft is that reversal, which then accepts.
    const redrafted = { ...rejected, ...Issue.from(rejected).redraft("erin", LATER).patch };
    expect(redrafted.chain).toEqual({ state: "draft" });
    expect(Issue.from(redrafted).accept({ kind: "declined", why: "reconsidered" }, "erin", LATER).patch.chain).toEqual({
      state: "accepted",
      at: LATER,
      by: "erin",
      design: { kind: "declined", why: "reconsidered" },
    });
  });

  it("refuses to reject or redraft what already shipped — a shipped chain is history", () => {
    const shipped = newIssue({ state: "shipped", at: NOW, by: "dana" });
    expect(() => Issue.from(shipped).reject("changed our minds", "erin", LATER)).toThrow(/cannot be rejected/);
    expect(() => Issue.from(shipped).redraft("erin", LATER)).toThrow(/history, not a draft/);
  });

  // The two axes never move each other. A convenience that flipped one from the other would be a second
  // authority on one fact, and the board's category is what every rollup decides on.
  it("leaves the workflow status alone, and the workflow status leaves the chain alone", () => {
    const issue = Issue.from(newIssue());
    const accepted = issue.accept({ kind: "declined", why: "small" }, "dana", NOW);
    expect(accepted.patch.status).toBeUndefined();

    const withChain = {
      ...newIssue({ state: "accepted", at: NOW, by: "dana", design: { kind: "declined", why: "s" } }),
    };
    const moved = Issue.from(withChain).setStatus("in_progress", "dana", LATER);
    expect(moved.patch.status).toBe("in_progress");
    expect(moved.patch.chain).toBeUndefined();
  });
});
