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
  taskTemplate?: string; // 있으면 task = {field} 보간 결과(여러 필드 합성 — 예: 질문+근거 문서 URL). 없으면 taskField 그대로.
  startUrlField?: string; // 있으면 browser env(startUrl); 없으면 startUrl 없는 browser env
  promptEnv?: boolean; // true 면 환경 없는 prompt env(QA — gsm8k/GAIA). repo/browser 보다 우선순위 낮음(git/repoPath 가 이김).
  answerField?: string; // 있으면 answer-match{expect} grader 자동 추가
  answerMode?: "contains" | "exact"; // answer-match 모드(기본 contains). GAIA 류 정답대조는 exact.
  gitField?: string; // 있으면 repo env(source.git) — clone 기반 코딩 벤치마크
  refField?: string; // repo env ref(없으면 HEAD)
  repoPath?: string; // 있으면 repo env(source.path = 이미지-내 repo, 예: SWE-bench "/testbed") — clone 안 함
  osUseEnv?: boolean; // true 면 os-use(데스크탑/컴퓨터-유즈) env — OSWorld 류. repo/git 이 있으면 그게 이김.
  osUseSetup?: string[]; // os-use env.setup(공유; 예: Xvfb 기동 + 앱). 데이터 주도(JSON 배열).
  display?: string; // os-use display(기본 ":99")
  screenshotPath?: string; // os-use 스냅샷 경로(VLM judge 가 읽음)
  imageField?: string; // 있으면 EvalCase.image(per-case 컴퓨트 이미지) — 예: SWE-bench 공식 prebuilt(deps+repo)
  image?: string; // 모든 케이스 공통 컴퓨트 이미지(imageField 가 행별로 이김) — 예: OSWorld 데스크탑 이미지
  placement?: string; // 모든 케이스 placement.target(예: "docker") — 컨트롤플레인 라우팅
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

// {field} 보간 — 행에서 값 치환(없으면 빈 문자열). taskTemplate/graderTemplates 가 공유.
export function interpolateFields(tpl: string, row: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => str(row[k]));
}

// 외부 행 → EvalCase (env/task/graders/tags). 매핑 규칙으로 변환.
export function rowToCase(row: Record<string, unknown>, i: number, meta: DatasetMeta, m: CaseMapping): EvalCase {
  const git = m.gitField ? str(row[m.gitField]) : "";
  let env: EnvSpec;
  if (m.repoPath) {
    env = { kind: "repo", source: { path: m.repoPath } }; // 이미지-내 repo(예: /testbed) — clone 안 함
  } else if (git) {
    const ref = m.refField ? str(row[m.refField]) : "";
    env = { kind: "repo", source: { git, ref: ref || "HEAD" } };
  } else if (m.osUseEnv) {
    env = {
      kind: "os-use", // 데스크탑 컴퓨터-유즈(OSWorld) — 에이전트가 GUI 를 실 OS 입력으로 조작, 스냅샷을 VLM 이 채점
      ...(m.display ? { display: m.display } : {}),
      ...(m.osUseSetup ? { setup: m.osUseSetup } : {}),
      ...(m.screenshotPath ? { screenshotPath: m.screenshotPath } : {}),
    };
  } else if (m.promptEnv) {
    env = { kind: "prompt" }; // 환경 없는 QA(gsm8k/GAIA)
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
  const image = m.imageField ? str(row[m.imageField]) || (m.image ?? "") : (m.image ?? ""); // 행별 imageField > 공통 image
  return {
    id: str(row[m.idField]) || `${meta.id}-${i}`,
    env,
    task: m.taskTemplate ? interpolateFields(m.taskTemplate, row) : str(row[m.taskField]),
    graders,
    ...(image ? { image } : {}),
    ...(m.placement ? { placement: { target: m.placement } } : {}),
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
