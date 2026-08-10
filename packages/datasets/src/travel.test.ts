import { DatasetSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { BENCHMARK_CATALOG, adapterToDataset } from "./catalog.js";
import { TRAVEL_BENCHMARKS } from "./travel.js";

// Row fixtures use the field names verified against each benchmark's released data files. If a benchmark renames a
// column upstream these fixtures still pass but the adapter breaks in production, so the field names are the contract
// under test — keep them literal rather than deriving them from the mapping.
const rubricOf = (graders: ReadonlyArray<{ id: string; config?: Record<string, unknown> }>): string => {
  const rubric = graders.find((g) => g.id === "judge")?.config?.rubric;
  if (typeof rubric !== "string") throw new Error("expected a judge grader carrying a string rubric");
  return rubric;
};

describe("travel benchmarks: catalog wiring", () => {
  it("every travel adapter is reachable through BENCHMARK_CATALOG under its own id", () => {
    for (const [key, adapter] of Object.entries(TRAVEL_BENCHMARKS)) {
      expect(key).toBe(adapter.id);
      expect(BENCHMARK_CATALOG[key as keyof typeof BENCHMARK_CATALOG]).toBe(adapter);
    }
  });

  it("all five produce environment-less planning cases (prompt env), not browser cases", () => {
    for (const adapter of Object.values(TRAVEL_BENCHMARKS)) {
      const ds = adapterToDataset(adapter, [{}], { id: adapter.id, version: adapter.defaultVersion });
      expect(ds.cases[0]?.env).toEqual({ kind: "prompt" });
    }
  });

  it("only TravelPlanner has a HuggingFace mirror; the rest ship data in-repo and need a jsonl upload", () => {
    expect(TRAVEL_BENCHMARKS.travelplanner.source).toEqual({
      kind: "huggingface",
      dataset: "osunlp/TravelPlanner",
      config: "validation",
      split: "validation",
    });
    for (const id of ["flex-travelplanner", "trek", "travelbench", "traveleval"] as const) {
      expect(TRAVEL_BENCHMARKS[id].source.kind).toBe("jsonl");
    }
  });
});

describe("travelplanner (sole-planning mode)", () => {
  it("composes the task from the query plus the row's reference information", () => {
    const ds = adapterToDataset(
      BENCHMARK_CATALOG.travelplanner,
      [
        {
          org: "St. Petersburg",
          dest: "Rockford",
          days: 3,
          people_number: 1,
          budget: 1700,
          local_constraint: "{'house rule': None, 'cuisine': None}",
          query: "Plan a trip from St. Petersburg to Rockford.",
          level: "easy",
          reference_information: "[{'Description': 'Attractions in Rockford'}]",
        },
      ],
      { id: "tp", version: "validation" },
    );
    const c = ds.cases[0];
    expect(DatasetSchema.safeParse(ds).success).toBe(true);
    expect(c?.env).toEqual({ kind: "prompt" });
    expect(c?.task).toContain("Plan a trip from St. Petersburg to Rockford.");
    expect(c?.task).toContain("Attractions in Rockford"); // reference info is what makes it sole-planning
    expect(c?.tags).toEqual(["easy"]);
    // No id column upstream → positional fallback, same as gsm8k.
    expect(c?.id).toBe("tp-0");
  });

  it("restates the row's own budget and local constraints in the rubric", () => {
    const ds = adapterToDataset(
      BENCHMARK_CATALOG.travelplanner,
      [{ org: "A", dest: "B", days: 3, people_number: 2, budget: 1700, local_constraint: "{'cuisine': 'Mexican'}" }],
      { id: "tp", version: "validation" },
    );
    const rubric = rubricOf(ds.cases[0]?.graders ?? []);
    expect(rubric).toContain("1700");
    expect(rubric).toContain("Mexican");
    expect(rubric).toContain("2 traveler(s)");
  });
});

describe("trek: infeasible tasks invert the grading polarity", () => {
  const solvable = { query: "Plan 3 days in Kyoto.", level: "medium", hard_constraints: "budget 900 USD" };

  it("a solvable task is graded on satisfying constraints and the persona's unstated needs", () => {
    const ds = adapterToDataset(
      BENCHMARK_CATALOG.trek,
      [{ ...solvable, implicit_keywords: "with children", impossible: "False" }],
      { id: "trek", version: "1.0.0" },
    );
    const rubric = rubricOf(ds.cases[0]?.graders ?? []);
    expect(rubric).toContain("budget 900 USD");
    expect(rubric).toContain("with children");
    expect(rubric).toContain("UNSTATED");
    expect(rubric).not.toContain("INFEASIBLE");
    expect(ds.cases[0]?.tags).toEqual(["medium", "with children"]);
  });

  it("an infeasible task PASSES only on a reasoned refusal — producing a plan is the failure being measured", () => {
    const ds = adapterToDataset(
      BENCHMARK_CATALOG.trek,
      [{ ...solvable, implicit_keywords: "foodie", impossible: "True" }],
      { id: "trek", version: "1.0.0" },
    );
    const rubric = rubricOf(ds.cases[0]?.graders ?? []);
    expect(rubric).toContain("INFEASIBLE");
    expect(rubric).toContain("declines to produce a plan");
    expect(rubric).toContain("is a FAIL");
  });

  it("flag spellings that mean 'not impossible' never select the refusal rubric", () => {
    for (const flag of ["", "0", "false", "False", "None", "nan"]) {
      const ds = adapterToDataset(BENCHMARK_CATALOG.trek, [{ ...solvable, impossible: flag }], {
        id: "trek",
        version: "1.0.0",
      });
      expect(rubricOf(ds.cases[0]?.graders ?? [])).not.toContain("INFEASIBLE");
    }
    // Truthy spellings the released CSV and a JSON conversion can both produce.
    for (const flag of ["True", "true", "1", 1, true]) {
      const ds = adapterToDataset(BENCHMARK_CATALOG.trek, [{ ...solvable, impossible: flag }], {
        id: "trek",
        version: "1.0.0",
      });
      expect(rubricOf(ds.cases[0]?.graders ?? [])).toContain("INFEASIBLE");
    }
  });
});

describe("travelbench: the unsolvable subset is scored on recognizing the boundary", () => {
  const base = { trace_id: "t-1", query: "帮我订一张去东京的机票", primary_intent: "flight", intent: "book" };

  it("a solvable row is graded on serving the request, keyed by trace_id", () => {
    const ds = adapterToDataset(BENCHMARK_CATALOG.travelbench, [{ ...base, no_actionable: "False" }], {
      id: "tb",
      version: "1.0.0",
    });
    expect(ds.cases[0]?.id).toBe("t-1");
    expect(ds.cases[0]?.tags).toEqual(["flight", "book"]);
    expect(rubricOf(ds.cases[0]?.graders ?? [])).not.toContain("CANNOT be fulfilled");
  });

  it.each(["no_actionable", "missing_tool", "missing_info"])(
    "%s marks the row unsolvable, so fabricating an answer is a FAIL",
    (field) => {
      const ds = adapterToDataset(BENCHMARK_CATALOG.travelbench, [{ ...base, [field]: "True" }], {
        id: "tb",
        version: "1.0.0",
      });
      const rubric = rubricOf(ds.cases[0]?.graders ?? []);
      expect(rubric).toContain("CANNOT be fulfilled");
      expect(rubric).toContain("Fabricating a confident answer is a FAIL");
    },
  );

  it("does not penalize the Chinese-language answer the Chinese-language dataset expects", () => {
    for (const row of [{ ...base }, { ...base, no_actionable: "True" }]) {
      const ds = adapterToDataset(BENCHMARK_CATALOG.travelbench, [row], { id: "tb", version: "1.0.0" });
      expect(rubricOf(ds.cases[0]?.graders ?? [])).toContain("must not be penalized");
    }
  });
});

describe("flex-travelplanner: hard constraints outrank preferences", () => {
  it("carries the new constraints into both the task and the rubric, keyed by idx", () => {
    const ds = adapterToDataset(
      BENCHMARK_CATALOG["flex-travelplanner"],
      [
        {
          idx: "42",
          org: "A",
          dest: "B",
          days: 3,
          people_number: 2,
          budget: 11300,
          local_constraint: "{'room type': 'entire room'}",
          query: "Plan a trip.",
          reference_information: "[]",
          new_constraints: "[{'budget': 11300}]",
          level: "hard",
        },
      ],
      { id: "flex", version: "1.0.0" },
    );
    const c = ds.cases[0];
    expect(c?.id).toBe("42");
    expect(c?.task).toContain("[{'budget': 11300}]");
    const rubric = rubricOf(c?.graders ?? []);
    expect(rubric).toContain("[{'budget': 11300}]");
    // The paper's headline failure mode: breaking the budget to honor a preference.
    expect(rubric).toContain("OUTRANKS");
  });
});

describe("traveleval: the rubric spans all six official dimensions", () => {
  it("restates the structured constraints and names each dimension", () => {
    const ds = adapterToDataset(
      BENCHMARK_CATALOG.traveleval,
      [
        {
          uid: "e-7",
          tag: "easy",
          start_city: "Beijing",
          target_city: "Xi'an",
          days: 4,
          people_number: 3,
          people_composition: "family",
          budget: 8000,
          dates: "2026-05-01",
          transportation: "train",
          accommodations: "hotel",
          diet: "vegetarian",
          attractions: "history",
          rhythm: "relaxed",
          nature_language_en: "Plan a 4-day family trip from Beijing to Xi'an.",
          nature_language: "请规划从北京到西安的四天家庭旅行。",
        },
      ],
      { id: "te", version: "1.0.0" },
    );
    const c = ds.cases[0];
    expect(c?.id).toBe("e-7");
    expect(c?.task).toBe("Plan a 4-day family trip from Beijing to Xi'an."); // English query, not nature_language
    const rubric = rubricOf(c?.graders ?? []);
    for (const dimension of ["accuracy", "compliance", "temporality", "spatiality", "economy", "utility"]) {
      expect(rubric).toContain(dimension);
    }
    expect(rubric).toContain("vegetarian");
    expect(rubric).toContain("8000");
  });
});
