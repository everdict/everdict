import { BadRequestError, type GradeContext, type Grader, type Score, type StoreReadQuery } from "@everdict/contracts";

// Grades a run on the POST-RUN state of a purpose:"data" store (P2). It reads the case's isolation slice via
// ctx.readStore — a co-located runtime exec (an internal store URL never reaches a remote grader, see
// docs/architecture/judge-placement-locality.md) — and compares the output to the expected value. The store-side
// sibling of AnswerMatchGrader: it closes the seed→operate→JUDGE loop for data-store evals.
export interface StoreStateConfig {
  store: string;
  role?: string; // disambiguate when several dependencies share a store kind
  query: string; // the read (a SQL SELECT for postgres)
  expect?: string; // expected read output; falls back to case.expected
  mode?: "contains" | "exact"; // default contains
}

export class StoreStateGrader implements Grader {
  readonly id = "store-state";
  constructor(private readonly cfg: StoreStateConfig) {}

  async grade(ctx: GradeContext): Promise<Score> {
    // A store-state grader needs a store-capable runtime (topology). Missing readStore = a config/placement error, like
    // an outcome grader with no compute — surfaced loud, not silently passed.
    if (!ctx.readStore) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { grader: this.id },
        "store-state grading needs a store-capable runtime — this context has no readStore.",
      );
    }
    const expected = this.cfg.expect ?? ctx.case.expected;
    if (expected === undefined) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { grader: this.id },
        "store-state grading needs an expected value (config.expect or the case's expected).",
      );
    }
    const q: StoreReadQuery = {
      store: this.cfg.store,
      ...(this.cfg.role ? { role: this.cfg.role } : {}),
      query: this.cfg.query,
    };
    const actual = (await ctx.readStore(q)).trim();
    const want = expected.trim();
    const pass = this.cfg.mode === "exact" ? actual === want : actual.includes(want);
    return { graderId: this.id, metric: "store-state", value: pass ? 1 : 0, pass, detail: { actual, expected: want } };
  }
}
