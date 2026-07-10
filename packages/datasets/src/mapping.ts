import { type Dataset, DatasetSchema, type EnvSpec, type EvalCase, type GraderSpec } from "@everdict/contracts";

// Dataset ingest (mapping layer): external benchmark formats (WebVoyager jsonl / arbitrary jsonl / csv) → tenant-owned Everdict
// `Dataset` (EvalCase[]). In a multi-tenant SaaS, for a user to easily add their dataset to the workspace, a mapping layer that converts
// their format into EvalCase is needed (the registry only accepts the Everdict Dataset schema). The result is register(tenant).

// External row (record) → EvalCase mapping rules. Data-driven (no functions → JSON-serializable, "a new benchmark by config").
// env: with gitField, a repo env (coding benchmark SWE-bench); otherwise a browser env (with/without startUrl).
// Scoring: answerField→answer-match (contains|exact via answerMode), testCmdField→tests-pass (per-row cmd), extraGraders always.
export interface CaseMapping {
  idField: string;
  taskField: string;
  taskTemplate?: string; // If present, task = the {field}-interpolated result (composing multiple fields — e.g. question + evidence document URL). Otherwise taskField as-is.
  startUrlField?: string; // If present, a browser env (startUrl); otherwise a browser env with no startUrl
  promptEnv?: boolean; // If true, an environment-less prompt env (QA — gsm8k/GAIA). Lower priority than repo/browser (git/repoPath wins).
  answerField?: string; // If present, auto-adds an answer-match{expect} grader
  answerMode?: "contains" | "exact"; // answer-match mode (default contains). GAIA-style answer matching is exact.
  gitField?: string; // If present, a repo env (source.git) — clone-based coding benchmark
  refField?: string; // repo env ref (HEAD if absent)
  repoPath?: string; // If present, a repo env (source.path = in-image repo, e.g. SWE-bench "/testbed") — no clone
  osUseEnv?: boolean; // If true, an os-use (desktop/computer-use) env — OSWorld-style. If repo/git exists, that wins.
  osUseSetup?: string[]; // os-use env.setup (shared; e.g. start Xvfb + app). Data-driven (JSON array).
  display?: string; // os-use display (default ":99")
  screenshotPath?: string; // os-use snapshot path (read by the VLM judge)
  imageField?: string; // If present, EvalCase.image (per-case compute image) — e.g. SWE-bench's official prebuilt (deps+repo)
  image?: string; // compute image common to all cases (imageField wins per-row) — e.g. an OSWorld desktop image
  placement?: string; // placement.target for all cases (registered runtime id) — control-plane routing. image cases route by docker capability, so usually unnecessary.
  testCmdField?: string; // If present, tests-pass{cmd} (per-row test command)
  tagFields?: string[]; // fields to use as tags
  extraGraders?: GraderSpec[]; // always added (e.g. steps, judge{rubric})
}
export interface DatasetMeta {
  id: string;
  version: string;
  description?: string;
  tags?: string[];
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

// {field} interpolation — substitute values from the row (empty string if absent). Shared by taskTemplate/graderTemplates.
export function interpolateFields(tpl: string, row: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => str(row[k]));
}

// External row → EvalCase (env/task/graders/tags). Converts via the mapping rules.
export function rowToCase(row: Record<string, unknown>, i: number, meta: DatasetMeta, m: CaseMapping): EvalCase {
  const git = m.gitField ? str(row[m.gitField]) : "";
  let env: EnvSpec;
  if (m.repoPath) {
    env = { kind: "repo", source: { path: m.repoPath } }; // in-image repo (e.g. /testbed) — no clone
  } else if (git) {
    const ref = m.refField ? str(row[m.refField]) : "";
    env = { kind: "repo", source: { git, ref: ref || "HEAD" } };
  } else if (m.osUseEnv) {
    env = {
      kind: "os-use", // desktop computer-use (OSWorld) — the agent manipulates the GUI with real OS input, a VLM scores the snapshot
      ...(m.display ? { display: m.display } : {}),
      ...(m.osUseSetup ? { setup: m.osUseSetup } : {}),
      ...(m.screenshotPath ? { screenshotPath: m.screenshotPath } : {}),
    };
  } else if (m.promptEnv) {
    env = { kind: "prompt" }; // environment-less QA (gsm8k/GAIA)
  } else {
    const url = m.startUrlField ? str(row[m.startUrlField]) : "";
    env = url ? { kind: "browser", startUrl: url } : { kind: "browser" };
  }
  const graders: GraderSpec[] = [];
  // The reference answer is case DATA (EvalCase.expected — judges get it as EXPECTED OUTPUT evidence) as well as
  // the answer-match grader's expect config (kept for behavior parity; the config wins when both exist).
  const expected = m.answerField ? str(row[m.answerField]) : "";
  if (m.answerField && expected) {
    const config: Record<string, unknown> = { expect: expected };
    if (m.answerMode === "exact") config.mode = "exact";
    graders.push({ id: "answer-match", config });
  }
  if (m.testCmdField && str(row[m.testCmdField])) {
    graders.push({ id: "tests-pass", config: { cmd: str(row[m.testCmdField]) } });
  }
  for (const g of m.extraGraders ?? []) graders.push(g);
  const tags = (m.tagFields ?? []).map((f) => str(row[f])).filter(Boolean);
  const image = m.imageField ? str(row[m.imageField]) || (m.image ?? "") : (m.image ?? ""); // per-row imageField > common image
  return {
    id: str(row[m.idField]) || `${meta.id}-${i}`,
    env,
    task: m.taskTemplate ? interpolateFields(m.taskTemplate, row) : str(row[m.taskField]),
    ...(expected ? { expected } : {}),
    graders,
    ...(image ? { image } : {}),
    ...(m.placement ? { placement: { target: m.placement } } : {}),
    timeoutSec: 600,
    tags,
  };
}

// Row array → a validated Dataset (DatasetSchema.parse applies defaults/validation).
export function rowsToDataset(rows: Array<Record<string, unknown>>, meta: DatasetMeta, m: CaseMapping): Dataset {
  return DatasetSchema.parse({
    id: meta.id,
    version: meta.version,
    description: meta.description,
    cases: rows.map((r, i) => rowToCase(r, i, meta, m)),
    tags: meta.tags ?? [],
  });
}

// Arbitrary JSONL (one record per line) → Dataset.
export function importJsonl(text: string, meta: DatasetMeta, m: CaseMapping): Dataset {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return rowsToDataset(rows, meta, m);
}

// Arbitrary CSV (header row + data rows) → Dataset.
export function importCsv(text: string, meta: DatasetMeta, m: CaseMapping): Dataset {
  return rowsToDataset(parseCsv(text), meta, m);
}

// WebVoyager (github.com/MinorJerry/WebVoyager) preset: web→startUrl, ques→task, answer→answer-match, +steps.
export const WEBVOYAGER_MAPPING: CaseMapping = {
  idField: "id",
  taskField: "ques",
  startUrlField: "web",
  answerField: "answer",
  tagFields: ["web_name"],
  extraGraders: [{ id: "steps" }],
};
export function importWebVoyager(jsonl: string, meta: DatasetMeta): Dataset {
  return importJsonl(jsonl, meta, WEBVOYAGER_MAPPING);
}

// --- Minimal CSV parser (commas/newlines inside quotes, "" escaping, CRLF handling). No runtime dependency. ---
function csvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuote = false;
      } else field += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out.filter((r) => !(r.length === 1 && r[0] === ""));
}
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows = csvRows(text);
  const header = rows[0] ?? [];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
