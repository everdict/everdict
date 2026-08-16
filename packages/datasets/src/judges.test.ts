import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBenchmark, getBenchmarkJudge, listBenchmarks } from "./catalog.js";
import { BENCHMARK_JUDGES, type BenchmarkJudge } from "./judges.js";

// The bar these ports have to clear is DISCRIMINATION: a scorer that passes everything is worthless, so every case
// below asserts both directions — the benchmark's own correct answer passes and a wrong one fails. This used to be a
// live script (`scripts/live/benchmark-grading-battery.mjs`) that needed a running control plane, so in practice it
// ran when someone remembered; here it runs on every `pnpm test`.
//
// The judges are executed the way the runtime executes them — as a real process handed a serialized GradeContext
// path, with the last line of stdout read back as Score[] — rather than by importing the logic, because the thing
// under test is the SOURCE that gets frozen into a registered judge version.

const dir = mkdtempSync(join(tmpdir(), "everdict-judges-"));

function runJudge(judge: BenchmarkJudge, ctx: unknown): { pass: boolean; detail: string } {
  const codePath = join(dir, `${judge.id}.mjs`);
  const ctxPath = join(dir, `${judge.id}.ctx.json`);
  writeFileSync(codePath, judge.code);
  writeFileSync(ctxPath, JSON.stringify(ctx));
  const stdout = execFileSync(process.execPath, [codePath, ctxPath], { encoding: "utf8" });
  const lines = stdout.trim().split("\n");
  const scores = JSON.parse(lines[lines.length - 1] ?? "[]") as Array<{ pass?: boolean; detail?: string }>;
  const score = scores[0];
  if (!score) throw new Error(`judge ${judge.id} emitted no score: ${stdout}`);
  return { pass: score.pass === true, detail: score.detail ?? "" };
}

// A GradeContext as the runtime serializes it: the case (carrying `expected`) plus the agent's trace.
const contextOf = (expected: string, answer: string): unknown => ({
  case: { id: "c1", expected },
  trace: [
    { t: 0, kind: "message", role: "user", text: "the question" },
    { t: 1, kind: "message", role: "assistant", text: answer },
  ],
});

describe("GAIA question_scorer port", () => {
  const judge = BENCHMARK_JUDGES.gaia;
  if (!judge) throw new Error("gaia judge missing");

  it("scores a numeric ground truth after stripping $ , % — and rejects a different number", () => {
    expect(runJudge(judge, contextOf("17000", "FINAL ANSWER: $17,000")).pass).toBe(true);
    expect(runJudge(judge, contextOf("17000", "FINAL ANSWER: $17,500")).pass).toBe(false);
  });

  it("compares a comma list element-wise, and a reordered list is wrong", () => {
    expect(runJudge(judge, contextOf("apple, banana", "FINAL ANSWER: apple, banana")).pass).toBe(true);
    expect(runJudge(judge, contextOf("apple, banana", "FINAL ANSWER: banana, apple")).pass).toBe(false);
    // Length mismatch is a fail even when every element the agent DID name is right.
    expect(runJudge(judge, contextOf("apple, banana", "FINAL ANSWER: apple")).pass).toBe(false);
  });

  it("normalizes a string answer by stripping whitespace, case and punctuation", () => {
    expect(runJudge(judge, contextOf("Saint Petersburg", "FINAL ANSWER: saint-petersburg")).pass).toBe(true);
    expect(runJudge(judge, contextOf("Saint Petersburg", "FINAL ANSWER: Moscow")).pass).toBe(false);
  });

  it("does NOT strip articles — that is SQuAD's normalization, and GAIA counts the difference as wrong", () => {
    // The earlier live-script draft removed a/an/the, which would have scored this as a match.
    expect(runJudge(judge, contextOf("answer", "FINAL ANSWER: the answer")).pass).toBe(false);
  });

  it("falls back to the whole final message when the agent omits the FINAL ANSWER marker", () => {
    expect(runJudge(judge, contextOf("42", "42")).pass).toBe(true);
    expect(runJudge(judge, contextOf("42", "I could not determine it")).pass).toBe(false);
  });

  it("an unparseable answer against a numeric truth fails instead of throwing", () => {
    const r = runJudge(judge, contextOf("42", "FINAL ANSWER: forty-two"));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("number");
  });
});

describe("GSM8K exact-match port", () => {
  const judge = BENCHMARK_JUDGES.gsm8k;
  if (!judge) throw new Error("gsm8k judge missing");

  it("takes the marked final answer over any number quoted while reasoning", () => {
    expect(runJudge(judge, contextOf("18", "She has 16 eggs, eats 3, bakes 4.\nFINAL ANSWER: 18")).pass).toBe(true);
    expect(runJudge(judge, contextOf("18", "She has 18 eggs to start.\nFINAL ANSWER: 9")).pass).toBe(false);
  });

  it("falls back to the LAST number when the answer is unmarked", () => {
    expect(runJudge(judge, contextOf("18", "16 - 3 - 4 = 9, doubled is 18")).pass).toBe(true);
    expect(runJudge(judge, contextOf("18", "16 - 3 - 4 = 9")).pass).toBe(false);
  });

  it("reads a thousands separator and a currency marker as the same number", () => {
    expect(runJudge(judge, contextOf("70000", "FINAL ANSWER: $70,000")).pass).toBe(true);
  });

  it("an answer with no number at all fails rather than throwing", () => {
    expect(runJudge(judge, contextOf("18", "I am not sure.")).pass).toBe(false);
  });
});

describe("getBenchmarkJudge — the registerable body", () => {
  it("hands over a code judge ready for POST /judges, carrying the evaluator it reproduces", () => {
    const judge = getBenchmarkJudge("gaia");
    expect(judge).toBeDefined();
    expect(judge?.kind).toBe("code");
    expect(judge?.language).toBe("node");
    expect(judge?.id).toBe("gaia-question-scorer");
    expect(judge?.version).toBe("1.0.0");
    expect(judge?.description).toContain("question_scorer");
    expect(judge?.code.length).toBeGreaterThan(0);
  });

  it("returns undefined for a benchmark that ships no official port — never a silent stand-in", () => {
    // osworld's evaluator is a per-task python checker over its own VM state; approximating it and calling the
    // result official is exactly the claim this package refuses to make.
    expect(getBenchmarkJudge("osworld")).toBeUndefined();
  });

  it("throws for a benchmark the catalog does not know", () => {
    expect(() => getBenchmarkJudge("not-a-benchmark")).toThrow(/unknown benchmark/);
  });
});

describe("listBenchmarks exposure", () => {
  it("states scoring semantics and points at the official judge without shipping its source", () => {
    const gaia = listBenchmarks().find((b) => b.id === "gaia");
    expect(gaia?.scoring?.kind).toBe("official");
    expect(gaia?.officialJudge?.id).toBe("gaia-question-scorer");
    // A listing carrying every judge's body would be mostly code — the pointer is the contract here.
    expect(gaia?.officialJudge).not.toHaveProperty("code");
  });

  it("a proxy-scored benchmark says so and offers no official judge", () => {
    const trek = listBenchmarks().find((b) => b.id === "trek");
    expect(trek?.scoring?.kind).toBe("proxy");
    expect(trek?.officialJudge).toBeUndefined();
  });
});

describe("catalog wiring", () => {
  it("every shipped judge is attached to the benchmark it scores, and both claim `official`", () => {
    for (const [benchmarkId, judge] of Object.entries(BENCHMARK_JUDGES)) {
      // getBenchmark throws on an id the catalog does not know — a judge for a benchmark nobody can import is
      // exactly the drift this assertion exists to catch.
      const adapter = getBenchmark(benchmarkId);
      expect(adapter.officialJudge?.id).toBe(judge.id);
      // A port that reproduces the benchmark's decision is what lets the adapter claim official — the two
      // statements have to move together, or the catalog advertises a comparability it does not ship.
      expect(adapter.scoring?.kind).toBe("official");
      expect(adapter.scoring?.officialEvaluator).toBe(judge.officialEvaluator);
    }
  });
});
