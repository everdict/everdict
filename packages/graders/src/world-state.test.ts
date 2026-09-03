import type { GradeContext } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { subsetDefects, worldStateGrader } from "./world-state.js";

// A whole family of benchmarks decides a case by what the WORLD looks like afterwards. What this pins is the
// pair that makes such a score trustworthy: it reads the PLATFORM's observation rather than the agent's own
// report, and a world nobody could read is `unmeasured` rather than a zero — a world nobody watched is not a
// world where nothing happened.
const ctx = (over: Partial<GradeContext>): GradeContext =>
  ({
    case: { id: "c1", expected: JSON.stringify({ orders: [{ id: "o1", status: "cancelled" }] }) },
    observations: { kind: "unobserved", reason: "unsupported" },
    ...over,
  }) as unknown as GradeContext;

const account = (text: string) => ({
  kind: "sampled" as const,
  deltas: [{ t: 1, kind: "world-recording" as const, text }],
});

describe("the world-state grader", () => {
  it("passes when every field the case names is true of the world, and ignores what it does not name", async () => {
    const score = await worldStateGrader().grade(
      ctx({ observations: account(JSON.stringify({ orders: [{ id: "o1", status: "cancelled", refund: 42 }] })) }),
    );
    expect(score).toMatchObject({ metric: "world_state", value: 1, pass: true });
  });

  it("fails naming WHICH field differs — a comparison that cannot say is a diff the reader has to compute", async () => {
    const score = await worldStateGrader().grade(
      ctx({ observations: account(JSON.stringify({ orders: [{ id: "o1", status: "pending" }] })) }),
    );
    expect(score).toMatchObject({ value: 0, pass: false });
    expect(String((score as { detail?: string }).detail)).toContain("pending");
  });

  it("is UNMEASURED, never zero, when the world published nothing — the distinction the channel exists for", async () => {
    for (const observations of [
      { kind: "unobserved" as const, reason: "sampling_failed" as const },
      { kind: "sampled" as const, deltas: [{ t: 1, kind: "repo-diff" as const, text: "diff" }] },
      account("not json at all"),
    ]) {
      const score = await worldStateGrader().grade(ctx({ observations }));
      expect(score).toMatchObject({ status: "unmeasured" });
      expect(score, "an unmeasured score carries no value to be read as a failure").not.toHaveProperty("value");
    }
  });

  it("scopes to a path when the world publishes more than the state under test", async () => {
    const score = await worldStateGrader({ path: "db", expect: { seats: 2 } }).grade(
      ctx({ observations: account(JSON.stringify({ db: { seats: 2 }, log: ["…"] })) }),
    );
    expect(score).toMatchObject({ value: 1, pass: true });
    const missing = await worldStateGrader({ path: "nowhere", expect: { seats: 2 } }).grade(
      ctx({ observations: account(JSON.stringify({ db: { seats: 2 } })) }),
    );
    expect(missing).toMatchObject({ status: "unmeasured" });
  });
});

describe("subsetDefects — what a state comparison may claim", () => {
  it("is a SUBSET claim on objects and an exact one on lists", () => {
    expect(subsetDefects({ a: 1 }, { a: 1, b: 2 }, "")).toEqual([]);
    expect(subsetDefects({ a: 1 }, { b: 2 }, "")).toEqual(["a is missing"]);
    // A list is the one place extra entries matter: "the orders are these" is a claim about all of them.
    expect(subsetDefects([1], [1, 2], "")).toEqual(["the state has 2 entries, expected 1"]);
  });
});
