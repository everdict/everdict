import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnalysisCard, AnalysisConfig, AnalysisGridResult } from "./analysis.js";
import { computeAnalysis } from "./analysis.js";

// ── THE SERVER HALF OF A DUPLICATED ENGINE ───────────────────────────────────────────────────────────
//
// This pivot exists TWICE: here (behind `POST /scorecards/query`) and in the web's analysis studio, which
// pivots an already-loaded list so a filter toggle costs no round trip. That duplication is load-bearing
// and stays. What did NOT hold was the lockstep: each file carried a comment saying the other is kept in
// step with it, which is a claim about another component with nothing checking it — and a census then found
// that only the web's copy is ever called, so a divergence here would have been invisible for as long as
// nobody used the route.
//
// `fixtures/analysis-parity.json` is the one question both engines answer. The web has its own test over the
// same file. Neither imports the other — the web may not import `@everdict/domain` at all — so the fixture
// is what they meet at. docs/architecture/web-runtime-gap-census-spec.md

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures/analysis-parity.json"), "utf8"),
) as {
  cards: AnalysisCard[];
  cases: {
    name: string;
    config: AnalysisConfig;
    expect: { kind: string; rows: { key: string; value: number | null }[]; total: number };
  }[];
};

describe("computeAnalysis — the shared parity fixture", () => {
  it("has cases to check — an empty fixture would pass this suite while proving nothing", () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const out = computeAnalysis(fixture.cards, testCase.config) as AnalysisGridResult;
      expect(out.kind).toBe(testCase.expect.kind);
      expect(out.total).toBe(testCase.expect.total);
      // `null` in the fixture is JSON's only way to write "no measured value" — which is NOT zero, and the
      // difference is the whole point of the second case.
      // `row.value` is the group's measure; `cells` is per PIVOT column and is empty with no pivotBy —
      // reading cells[0] here answered null for every case, which is the fixture asking the wrong field
      // rather than the engine disagreeing.
      expect(out.rows.map((r) => ({ key: r.key, value: r.value ?? null }))).toEqual(testCase.expect.rows);
    });
  }
});
