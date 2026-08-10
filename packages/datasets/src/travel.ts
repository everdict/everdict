import type { GraderSpec } from "@everdict/contracts";
import type { BenchmarkAdapter } from "./catalog.js";

// Travel-planning benchmark adapters. Kept out of catalog.ts (like terminal-bench.ts) because each one needs a
// per-row rubric builder; catalog.ts spreads TRAVEL_BENCHMARKS into BENCHMARK_CATALOG. The BenchmarkAdapter import is
// type-only, so the catalog↔travel edge is erased at runtime (no import cycle).
//
// ⚠️ SCORING IS AN APPROXIMATION — READ THIS BEFORE QUOTING A NUMBER.
// Every benchmark here officially scores with a repo-local constraint checker over its own sandbox database
// (TravelPlanner's evaluation/eval.py, TREK's scoring.py, TravelBench's scripts/eval.sh, TravelEval's core/metrics/*).
// Those evaluators need the benchmark's database and its exact structured-plan schema, so they cannot run
// harness-agnostically inside Everdict. Each adapter therefore scores the SAME constraints with a judge whose rubric is
// seeded from the row's own constraint fields — the same adaptation the osworld entry makes for its per-task Python
// evaluator. A judge score here is an Everdict-internal signal for regression tracking; it is NOT the official metric
// and must never be reported as a leaderboard number. To reproduce an official score, run the benchmark's own
// evaluator over the plans (a command grader inside a case image that bundles the benchmark's database).

function text(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

// Benchmark flag columns arrive as CSV/JSON scalars with no shared convention ("True"/"true"/1/true). Treat the
// documented falsy spellings as false so an infeasible task is never silently graded as a solvable one.
function isFlagSet(v: unknown): boolean {
  const s = text(v).trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "none" && s !== "nan";
}

// Shared preamble: the judge reads a plan, not a short answer, so it needs the "reject on any violation" instruction
// up front — a travel plan that satisfies most constraints is a failing plan under every one of these benchmarks.
const STRICT =
  "You are grading a travel plan. PASS only if EVERY constraint below holds. A plan that satisfies most constraints " +
  "but violates one is a FAIL. Judge only what the plan actually states; do not assume unstated details are correct.";

// TravelPlanner (ICML 2024) — the official evaluator reports delivery rate, commonsense/hard constraint micro+macro
// pass rates and final pass rate against a sandbox DB. The row carries the hard constraints, so the rubric restates
// them verbatim. local_constraint is a PYTHON-REPR string ({'house rule': None, ...}), not JSON — it is embedded as
// text for the judge to read, never parsed.
function travelPlannerRubric(row: Record<string, unknown>): string {
  return [
    STRICT,
    `Trip: ${text(row.org)} → ${text(row.dest)}, ${text(row.days)} days, ${text(row.people_number)} traveler(s).`,
    `Hard constraints — total budget ${text(row.budget)}; ${text(row.local_constraint)}.`,
    "Commonsense constraints — every flight/hotel/restaurant/attraction must be a real named option consistent with " +
      "the reference information; no repeated restaurants or attractions; the route must return to the origin; " +
      "transportation must not mix self-driving with flights; every day must have accommodation and all three meals.",
  ].join("\n");
}

// Flex-TravelPlanner (arXiv 2506.04649) — TravelPlanner rows plus `new_constraints`, introduced after an initial plan
// exists. The paper's headline failure is models breaking the budget to honor a soft preference, so the rubric makes
// that precedence explicit rather than leaving the judge to infer it.
function flexTravelPlannerRubric(row: Record<string, unknown>): string {
  return [
    STRICT,
    `Trip: ${text(row.org)} → ${text(row.dest)}, ${text(row.days)} days, ${text(row.people_number)} traveler(s).`,
    `Original hard constraints — total budget ${text(row.budget)}; ${text(row.local_constraint)}.`,
    `Newly added constraint(s) to incorporate — ${text(row.new_constraints)}.`,
    "The revised plan must satisfy the new constraint(s) AND still satisfy every original hard constraint. A hard " +
      "constraint (budget above all) OUTRANKS any stated preference: sacrificing the budget to honor a preference is a FAIL.",
  ].join("\n");
}

// TREK (arXiv 2607.26977) — 800 tasks, 267 of them provably infeasible with a typed route/entity/budget cause. On an
// infeasible task the ONLY correct behavior is a reasoned refusal, so the rubric inverts entirely on `impossible`;
// grading those against "did it produce a plan" would reward exactly the failure the benchmark exists to catch.
// `implicit_keywords` is the persona whose unstated needs the paper reports as the universal bottleneck.
function trekRubric(row: Record<string, unknown>): string {
  const persona = text(row.implicit_keywords);
  if (isFlagSet(row.impossible)) {
    return [
      "You are grading an agent's response to a travel request that is PROVABLY INFEASIBLE.",
      "PASS only if the agent declines to produce a plan AND names a concrete reason the request cannot be satisfied " +
        "(an impossible route, a non-existent entity, or a budget that cannot cover the requirement).",
      "Producing a confident itinerary anyway is a FAIL, however plausible it looks. So is a vague refusal that gives no cause.",
      `Requested: ${text(row.query)}`,
    ].join("\n");
  }
  return [
    STRICT,
    `Stated hard constraints — ${text(row.hard_constraints)}.`,
    persona
      ? `Traveler profile — ${persona}. The plan must also serve this profile's UNSTATED practical needs (accessibility, pacing, meal timing, child/pet suitability, and similar), not merely the stated constraints.`
      : "The plan must also serve the traveler's unstated practical needs, not merely the stated constraints.",
    "Every named place, route and price must be internally consistent; opening hours and travel times must be feasible.",
  ].join("\n");
}

// TravelBench (ACL 2026, arXiv 2512.22673) — three subtasks, and the Unsolvable one is scored on recognizing a
// capability boundary. missing_tool / missing_info / no_actionable mark those rows, so the rubric flips for them.
// Queries are Chinese-language over China geography; the judge must not penalize a Chinese-language answer.
function travelBenchRubric(row: Record<string, unknown>): string {
  const unsolvable = isFlagSet(row.no_actionable) || isFlagSet(row.missing_tool) || isFlagSet(row.missing_info);
  if (unsolvable) {
    return [
      "You are grading an agent's response to a travel request that CANNOT be fulfilled — the information or the tool " +
        "needed to answer it is unavailable.",
      "PASS only if the agent recognizes this and says so, rather than inventing an answer. Asking the user for the " +
        "specific missing information also passes. Fabricating a confident answer is a FAIL.",
      "The request is written in Chinese; a Chinese-language response is expected and must not be penalized.",
      `Request: ${text(row.query)}`,
    ].join("\n");
  }
  return [
    STRICT,
    `Request: ${text(row.query)}`,
    text(row.context) ? `Conversation context — ${text(row.context)}.` : "",
    "The response must directly serve the request with concrete, internally consistent travel details. Where the " +
      "request leaves a needed preference unstated, asking the user for it is correct behavior, not a failure.",
    "The request is written in Chinese; a Chinese-language response is expected and must not be penalized.",
  ]
    .filter(Boolean)
    .join("\n");
}

// TravelEval (arXiv 2606.01046) — six official dimensions (accuracy, compliance, temporality, spatiality, economy,
// utility). The rubric names all six so the judge covers the same ground the official metrics do; the structured
// constraint columns are restated verbatim.
function travelEvalRubric(row: Record<string, unknown>): string {
  return [
    STRICT,
    `Trip: ${text(row.start_city)} → ${text(row.target_city)}, ${text(row.days)} days, ${text(row.people_number)} traveler(s) (${text(row.people_composition)}).`,
    `Constraints — budget ${text(row.budget)}; dates ${text(row.dates)}; transportation ${text(row.transportation)}; ` +
      `accommodation ${text(row.accommodations)}; diet ${text(row.diet)}; attractions ${text(row.attractions)}; pace ${text(row.rhythm)}.`,
    "Judge all six official dimensions: accuracy (real, correctly described places), compliance (every constraint " +
      "above), temporality (opening hours and a feasible daily schedule), spatiality (routes and travel times that " +
      "work geographically), economy (total cost within budget), utility (a genuinely worthwhile itinerary).",
  ].join("\n");
}

// The five travel benchmarks whose data is actually obtainable, with row field names verified against the released
// files. Three further benchmarks from the same survey are deliberately ABSENT because nothing has been released to
// ingest: GroupTravelBench (arXiv 2605.25200, "work in process", no repo), TRIP-Bench (arXiv 2602.01675, release only
// promised) and BookingArena (arXiv 2602.12544, in-paper benchmark over 20 live booking sites, no task file). Adding
// them would mean inventing a source and field names.
export const TRAVEL_BENCHMARKS = {
  // Sole-planning mode: the row ships `reference_information`, so the task carries it and no tool sandbox is needed.
  // Split choice is deliberate — `test` withholds budget/constraints/gold (scoreable only via the authors' email
  // leaderboard) and `train` is 45 rows, so `validation` (180) is the only split you can self-evaluate. Each config
  // has one identically-named split. Rows carry no id column, so case ids fall back to positional (as gsm8k does).
  travelplanner: {
    id: "travelplanner",
    description:
      "TravelPlanner — real-world travel planning under hard + commonsense constraints (osunlp/TravelPlanner, ICML 2024 spotlight; data CC-BY-4.0, code MIT). Sole-planning mode over the validation split. Judge-scored approximation: the official six metrics need the authors' sandbox DB (Google Drive) and structured plan schema.",
    category: "qa",
    defaultVersion: "validation",
    source: { kind: "huggingface", dataset: "osunlp/TravelPlanner", config: "validation", split: "validation" },
    mapping: {
      idField: "id",
      taskField: "query",
      taskTemplate: "{query}\n\nReference information:\n{reference_information}",
      promptEnv: true,
      tagFields: ["level"],
    },
    graderBuilder: (row: Record<string, unknown>): GraderSpec[] => [
      { id: "judge", config: { rubric: travelPlannerRubric(row) } },
    ],
  },
  // Data lives only in the GitHub repo as a JSON ARRAY (implement/agents/evaluation/database/val_dataset_*.json) —
  // convert to jsonl (one record per line) before import. 120 TravelPlanner validation queries + `new_constraints`.
  "flex-travelplanner": {
    id: "flex-travelplanner",
    description:
      "Flex-TravelPlanner — revising an existing plan as constraints arrive across turns, and prioritizing competing constraints (github.com/juhyunohh/FlexTravelBench, arXiv 2506.04649; NO LICENSE declared, derived from TravelPlanner). Source data is a JSON array — convert to jsonl. Judge-scored approximation.",
    category: "qa",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "idx",
      taskField: "query",
      taskTemplate:
        "{query}\n\nReference information:\n{reference_information}\n\nAdditional constraint(s) to incorporate:\n{new_constraints}",
      promptEnv: true,
      tagFields: ["level"],
    },
    graderBuilder: (row: Record<string, unknown>): GraderSpec[] => [
      { id: "judge", config: { rubric: flexTravelPlannerRubric(row) } },
    ],
  },
  // trek_queries.csv (800 rows) → convert to jsonl before import. No HuggingFace mirror exists. Rows carry no id
  // column, so case ids fall back to positional.
  trek: {
    id: "trek",
    description:
      "TREK — 800 complex trip-planning tasks (533 feasible / 267 provably infeasible) over a 212,530-record KB across 375 cities and 13 personas (arXiv 2607.26977; code MIT, data CC-BY-4.0). Data ships as CSV in the GitHub repo — convert trek_queries.csv to jsonl. Judge-scored approximation; infeasible rows are graded as refusal tasks. The official rule-based evaluator (scoring.py) is deterministic — run it for a citable score.",
    category: "tool",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "id",
      taskField: "query",
      promptEnv: true,
      tagFields: ["level", "implicit_keywords"],
    },
    graderBuilder: (row: Record<string, unknown>): GraderSpec[] => [
      { id: "judge", config: { rubric: trekRubric(row) } },
    ],
  },
  // datas/{single_turn,multi_turn,unsolve}.jsonl are already jsonl — import directly. Multi-turn rows add
  // `user_profile`; Everdict runs one turn, so multi-turn cases measure whether the agent ELICITS the missing
  // preference rather than guessing it.
  travelbench: {
    id: "travelbench",
    description:
      "TravelBench — real user travel queries in three subtasks: single-turn, multi-turn (elicit implicit preferences) and unsolvable (recognize capability boundaries) (github.com/small-xiangcheng/TravelBench, ACL 2026 Main, arXiv 2512.22673; code MIT, data CC-BY-NC-4.0 — noncommercial). Chinese-language, China geography. Judge-scored approximation.",
    category: "tool",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "trace_id",
      taskField: "query",
      promptEnv: true,
      tagFields: ["primary_intent", "intent"],
    },
    graderBuilder: (row: Record<string, unknown>): GraderSpec[] => [
      { id: "judge", config: { rubric: travelBenchRubric(row) } },
    ],
  },
  // environment/data/queries/*.json wrap the records in a `queries` array (progressive.json uses `query_groups`) —
  // extract and convert to jsonl before import. taskField is the English query; `nature_language` is the Chinese one.
  traveleval: {
    id: "traveleval",
    description:
      "TravelEval — itinerary quality across six dimensions: accuracy, compliance, temporality, spatiality, economy, utility (github.com/onlycwy11/TravelEval, arXiv 2606.01046; NO LICENSE declared — no usage rights granted by default). Source JSON wraps records in a `queries` array — extract to jsonl. Judge-scored approximation; the official pipeline additionally requires a Gaode/AMAP API key.",
    category: "qa",
    defaultVersion: "1.0.0",
    source: { kind: "jsonl" },
    mapping: {
      idField: "uid",
      taskField: "nature_language_en",
      promptEnv: true,
      tagFields: ["tag"],
    },
    graderBuilder: (row: Record<string, unknown>): GraderSpec[] => [
      { id: "judge", config: { rubric: travelEvalRubric(row) } },
    ],
  },
} satisfies Record<string, BenchmarkAdapter>;
