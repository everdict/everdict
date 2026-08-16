// Benchmark OFFICIAL SCORERS, shipped as data beside the cases.
//
// An adapter used to carry only half of a benchmark: where the cases come from and how their fields map. The other
// half — how the benchmark decides pass or fail — lived in `scripts/live/benchmark-grading-battery.mjs`, a live
// experiment that needs a running control plane and that nobody importing this package can consume. So anyone taking
// a benchmark from the catalog got the questions and had to re-derive the scoring, which is exactly where a
// re-derivation drifts from the paper and the number stops being comparable.
//
// These are the benchmarks' own evaluators, ported to the code-judge contract (`docs/judges.md`): argv carries the
// serialized `GradeContext` path, the LAST line on stdout is a `Score[]`, metric `judge` (the runner rewrites the
// prefix to `judge:<judge-id>`). Ported to NODE deliberately — node is in the default job-runner image everywhere,
// while python needs a runtime that bakes `python3`, and an official scorer that only runs on some lanes is a
// portability claim the catalog cannot make.
//
// A judge here is `official` in the strict sense of `BenchmarkScoringSemantics`: it reproduces the benchmark's own
// decision. A benchmark whose evaluator needs its own database or plan schema (TravelPlanner, TREK, OSWorld) gets no
// entry here — its approximation stays declared as `proxy` on the adapter, which is the honest reading.

export interface BenchmarkJudge {
  // Registerable judge id — the metric surfaces as `judge:<id>`, so it is part of the comparison's identity.
  id: string;
  // The code-judge runtime. Node only, for the portability reason above; the field exists because the contract does.
  language: "node";
  description: string;
  // Where the criterion comes from, so a reader can check the port against the source rather than trusting it.
  officialEvaluator: string;
  // Inline source, frozen into the registered judge version.
  code: string;
}

// The last assistant message of the trace is the agent's answer — everything a scorer here reads. Shared preamble so
// the two ports differ only where the benchmarks differ.
const READ_FINAL_MESSAGE = `
import { readFileSync } from "node:fs";
const ctx = JSON.parse(readFileSync(process.argv[2] ?? process.argv[1], "utf8"));
const trace = Array.isArray(ctx.trace) ? ctx.trace : [];
const assistant = trace.filter((e) => e && e.kind === "message" && e.role === "assistant");
const finalMessage = assistant.length ? String(assistant[assistant.length - 1].text ?? "") : "";
const expected = String((ctx.case && ctx.case.expected) ?? "");
`.trim();

// GAIA — the official \`question_scorer\` (gaia-benchmark scoring util), ported branch for branch.
//
// Two details the earlier live-script version got wrong, and the reason a port belongs under test: the official
// \`normalize_str\` strips ALL whitespace (not "collapse to single spaces") and does NOT remove articles — the
// article-stripping in that draft is SQuAD's normalization, not GAIA's, and it makes "the answer" match "answer",
// which GAIA counts as wrong. The number branch is chosen by the GROUND TRUTH's type, not the model's.
const GAIA_CODE = `
${READ_FINAL_MESSAGE}
// GAIA's prompt template asks the agent to end with "FINAL ANSWER: <answer>"; the official scorer is handed that
// extracted string. Without the marker the whole final message IS the answer (the paper's own fallback).
const marked = finalMessage.match(/FINAL ANSWER\\s*:\\s*([\\s\\S]*)$/i);
const answer = (marked ? marked[1] : finalMessage).trim();
const PUNCT = "!\\"#$%&'()*+,-./:;<=>?@[\\\\]^_\`{|}~";
const isFloat = (s) => { const t = String(s).trim(); return t !== "" && Number.isFinite(Number(t)); };
// normalize_number_str: strip $ % , then float; unparseable → Infinity, which can never equal a finite truth.
const normNumber = (s) => { const t = String(s).replace(/[$%,]/g, ""); return isFloat(t) ? Number(t) : Number.POSITIVE_INFINITY; };
// normalize_str: remove ALL whitespace, lowercase, and (by default) every punctuation character.
const normStr = (s, removePunct = true) => {
  const noSpace = String(s).replace(/\\s/g, "").toLowerCase();
  return removePunct ? [...noSpace].filter((ch) => !PUNCT.includes(ch)).join("") : noSpace;
};
const splitString = (s) => String(s).split(/[,;]/);
let pass;
let mode;
if (isFloat(expected)) {
  mode = "number";
  pass = normNumber(answer) === Number(expected);
} else if (expected.includes(",") || expected.includes(";")) {
  mode = "list";
  const gt = splitString(expected);
  const ma = splitString(answer);
  pass =
    gt.length === ma.length &&
    gt.every((g, i) => (isFloat(g.trim()) ? normNumber(ma[i]) === Number(g.trim()) : normStr(ma[i], false) === normStr(g, false)));
} else {
  mode = "string";
  pass = normStr(answer) === normStr(expected);
}
console.log(
  JSON.stringify([
    {
      graderId: "gaia",
      metric: "judge",
      value: pass ? 1 : 0,
      pass,
      detail: "GAIA question_scorer (" + mode + "): answer=" + JSON.stringify(answer) + " vs expected=" + JSON.stringify(expected),
    },
  ]),
);
`.trim();

// GSM8K — exact match on the final number. The official harness reads the answer after the dataset's own \`####\`
// marker (the adapter's rowTransform already reduces \`expected\` to that number), so the only judgement left is
// pulling the agent's final number out of prose. Extraction is deliberately lenient in ONE direction: a marked
// "FINAL ANSWER:" wins, otherwise the last number in the message — a stricter rule would score formatting, and a
// looser one (any number anywhere) would credit a wrong answer that happens to quote the right figure mid-reasoning.
const GSM8K_CODE = `
${READ_FINAL_MESSAGE}
const marked = finalMessage.match(/FINAL ANSWER\\s*[:=]?\\s*(-?[\\d.,]+)/i);
let extracted = null;
if (marked) extracted = marked[1];
else {
  const numbers = finalMessage.replace(/,/g, "").match(/-?\\d+(?:\\.\\d+)?/g);
  extracted = numbers ? numbers[numbers.length - 1] : null;
}
const asNumber = (s) => { const t = String(s).replace(/[$%,]/g, "").trim(); return t !== "" && Number.isFinite(Number(t)) ? Number(t) : null; };
const got = extracted === null ? null : asNumber(extracted);
const want = asNumber(expected);
const pass = got !== null && want !== null && Math.abs(got - want) < 1e-6;
console.log(
  JSON.stringify([
    {
      graderId: "gsm8k",
      metric: "judge",
      value: pass ? 1 : 0,
      pass,
      detail: "GSM8K exact match: extracted=" + JSON.stringify(extracted) + " vs expected=" + JSON.stringify(expected),
    },
  ]),
);
`.trim();

export const GAIA_QUESTION_SCORER: BenchmarkJudge = {
  id: "gaia-question-scorer",
  language: "node",
  description:
    "GAIA's official question_scorer: number normalization ($ % , stripped) when the ground truth is numeric, " +
    "element-wise comparison when it is a comma/semicolon list, else whitespace-stripped lowercase punctuation-free " +
    "string equality. Reads the agent's FINAL ANSWER line (or the whole final message when unmarked).",
  officialEvaluator: "gaia-benchmark question_scorer (scorer.py)",
  code: GAIA_CODE,
};

export const GSM8K_EXACT_MATCH: BenchmarkJudge = {
  id: "gsm8k-exact-match",
  language: "node",
  description:
    "GSM8K exact final-number match: takes the agent's FINAL ANSWER line (else the last number in its final " +
    "message) and compares it numerically to the dataset's post-#### answer.",
  officialEvaluator: "openai/grade-school-math exact-match on the #### answer",
  code: GSM8K_CODE,
};

// Every official scorer this package ships, by the catalog id it scores.
export const BENCHMARK_JUDGES: Record<string, BenchmarkJudge> = {
  gaia: GAIA_QUESTION_SCORER,
  gsm8k: GSM8K_EXACT_MATCH,
};
