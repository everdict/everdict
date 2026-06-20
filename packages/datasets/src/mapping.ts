import { type Dataset, DatasetSchema, type EnvSpec, type EvalCase, type GraderSpec } from "@assay/core";

// 데이터셋 인제스트(매핑 레이어): 외부 벤치마크 포맷(WebVoyager jsonl / 임의 jsonl / csv) → 테넌트-소유 Assay
// `Dataset`(EvalCase[]). 멀티테넌트 SaaS 에서 유저가 자기 데이터셋을 쉽게 워크스페이스에 추가하려면, 자기 포맷을
// EvalCase 로 변환하는 매핑 레이어가 필요하다(레지스트리는 Assay Dataset 스키마만 받으므로). 결과는 register(tenant).

// 외부 행(레코드) → EvalCase 매핑 규칙. 데이터 주도(함수 없음 → JSON 직렬화 가능, "설정으로 새 벤치마크").
// env: gitField 있으면 repo env(코딩 벤치마크 SWE-bench), 아니면 browser env(startUrl 유무).
// 채점: answerField→answer-match(answerMode 로 contains|exact), testCmdField→tests-pass(행별 cmd), extraGraders 항상.
export interface CaseMapping {
  idField: string;
  taskField: string;
  startUrlField?: string; // 있으면 browser env(startUrl); 없으면 startUrl 없는 browser env
  answerField?: string; // 있으면 answer-match{expect} grader 자동 추가
  answerMode?: "contains" | "exact"; // answer-match 모드(기본 contains). GAIA 류 정답대조는 exact.
  gitField?: string; // 있으면 repo env(source.git) — SWE-bench 류 코딩 벤치마크
  refField?: string; // repo env ref(없으면 HEAD)
  testCmdField?: string; // 있으면 tests-pass{cmd} (행별 테스트 명령)
  tagFields?: string[]; // 태그로 쓸 필드들
  extraGraders?: GraderSpec[]; // 항상 추가(예: steps, judge{rubric})
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

// 외부 행 → EvalCase (env/task/graders/tags). 매핑 규칙으로 변환.
export function rowToCase(row: Record<string, unknown>, i: number, meta: DatasetMeta, m: CaseMapping): EvalCase {
  const git = m.gitField ? str(row[m.gitField]) : "";
  let env: EnvSpec;
  if (git) {
    const ref = m.refField ? str(row[m.refField]) : "";
    env = { kind: "repo", source: { git, ref: ref || "HEAD" } };
  } else {
    const url = m.startUrlField ? str(row[m.startUrlField]) : "";
    env = url ? { kind: "browser", startUrl: url } : { kind: "browser" };
  }
  const graders: GraderSpec[] = [];
  if (m.answerField && str(row[m.answerField])) {
    const config: Record<string, unknown> = { expect: str(row[m.answerField]) };
    if (m.answerMode === "exact") config.mode = "exact";
    graders.push({ id: "answer-match", config });
  }
  if (m.testCmdField && str(row[m.testCmdField])) {
    graders.push({ id: "tests-pass", config: { cmd: str(row[m.testCmdField]) } });
  }
  for (const g of m.extraGraders ?? []) graders.push(g);
  const tags = (m.tagFields ?? []).map((f) => str(row[f])).filter(Boolean);
  return {
    id: str(row[m.idField]) || `${meta.id}-${i}`,
    env,
    task: str(row[m.taskField]),
    graders,
    timeoutSec: 600,
    tags,
  };
}

// 행 배열 → 검증된 Dataset (DatasetSchema.parse 가 기본값/검증 적용).
export function rowsToDataset(rows: Array<Record<string, unknown>>, meta: DatasetMeta, m: CaseMapping): Dataset {
  return DatasetSchema.parse({
    id: meta.id,
    version: meta.version,
    description: meta.description,
    cases: rows.map((r, i) => rowToCase(r, i, meta, m)),
    tags: meta.tags ?? [],
  });
}

// 임의 JSONL(한 줄 1레코드) → Dataset.
export function importJsonl(text: string, meta: DatasetMeta, m: CaseMapping): Dataset {
  const rows = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return rowsToDataset(rows, meta, m);
}

// 임의 CSV(헤더행 + 데이터행) → Dataset.
export function importCsv(text: string, meta: DatasetMeta, m: CaseMapping): Dataset {
  return rowsToDataset(parseCsv(text), meta, m);
}

// WebVoyager(github.com/MinorJerry/WebVoyager) 프리셋: web→startUrl, ques→task, answer→answer-match, +steps.
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

// --- 최소 CSV 파서(따옴표 안의 쉼표/개행, "" 이스케이프, CRLF 처리). 런타임 의존성 없음. ---
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
