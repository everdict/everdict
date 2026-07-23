import { BadRequestError, type EvalCase, type GradeContext, type StoreReadQuery } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { StoreStateGrader } from "./store-state.js";

const CASE: EvalCase = { id: "c", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] };

function ctx(over: Partial<GradeContext> = {}): GradeContext {
  return { case: CASE, trace: [], snapshot: { kind: "prompt", output: "" }, ...over };
}

describe("StoreStateGrader", () => {
  it("passes when the post-run store read contains the expected value + forwards the query", async () => {
    const g = new StoreStateGrader({
      store: "postgres",
      role: "world",
      query: "SELECT status FROM orders",
      expect: "shipped",
    });
    const reads: StoreReadQuery[] = [];
    const score = await g.grade(
      ctx({
        readStore: async (q) => {
          reads.push(q);
          return "shipped\n";
        },
      }),
    );
    expect(score).toMatchObject({ graderId: "store-state", metric: "store-state", value: 1, pass: true });
    expect(reads[0]).toEqual({ store: "postgres", role: "world", query: "SELECT status FROM orders" });
  });

  it("fails when the read does not contain the expected value", async () => {
    const g = new StoreStateGrader({ store: "postgres", query: "SELECT status", expect: "shipped" });
    const score = await g.grade(ctx({ readStore: async () => "pending" }));
    expect(score).toMatchObject({ value: 0, pass: false });
  });

  it("supports exact mode (trimmed)", async () => {
    const g = new StoreStateGrader({ store: "postgres", query: "x", expect: "abc", mode: "exact" });
    expect((await g.grade(ctx({ readStore: async () => " abc " }))).pass).toBe(true);
    expect((await g.grade(ctx({ readStore: async () => "abcd" }))).pass).toBe(false);
  });

  it("falls back to the case's expected when config.expect is absent", async () => {
    const g = new StoreStateGrader({ store: "postgres", query: "x" });
    const withExpected: EvalCase = { ...CASE, expected: "done" };
    const score = await g.grade(ctx({ case: withExpected, readStore: async () => "all done" }));
    expect(score.pass).toBe(true);
  });

  it("throws when the context has no store reader (non-store runtime)", async () => {
    const g = new StoreStateGrader({ store: "postgres", query: "x", expect: "y" });
    await expect(g.grade(ctx())).rejects.toThrow(BadRequestError);
  });

  it("throws when there is no expected value to compare", async () => {
    const g = new StoreStateGrader({ store: "postgres", query: "x" });
    await expect(g.grade(ctx({ readStore: async () => "z" }))).rejects.toThrow(/expected/);
  });
});
