import { UpstreamError } from "@assay/core";
import { parseCsv } from "./mapping.js";

// 벤치마크 소스 커넥터: 벤치마크가 "사는 곳"에서 참조만으로 행을 인출한다(로컬 파일에 의존하지 않음).
// 신규 벤치마크는 대부분 HuggingFace Hub 에 올라오므로 HF datasets-server REST(/rows)를 1차 소스로 지원.
// 네트워크 호출은 주입 가능한 FetchLike 로 추상화 → 매핑/페이징 로직은 결정적으로 테스트, 실인출은 글로벌 fetch.

export interface HfRowsParams {
  dataset: string; // 예: "openai/gsm8k"
  config?: string; // 기본 "default"
  split?: string; // 기본 "train"
  limit?: number; // 총 인출 상한 (기본 100)
  token?: string; // gated 데이터셋용 (Authorization: Bearer) — 테넌트 SecretStore 에서 주입
}

// 테스트 주입용 최소 fetch 시그니처(글로벌 fetch 호환). 본문은 text()로 받아 JSON.parse(견고/단순).
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HF_ROWS = "https://datasets-server.huggingface.co/rows";
const HF_PAGE = 100; // datasets-server 의 한 번 호출 최대 length.
const HF_TIMEOUT_MS = 8000; // HF 응답 대기 상한 — 접속 불가 시 무한 대기 대신 깔끔히 실패.

// HF 호출 공통: 타임아웃 + 실패를 우리 UpstreamError(502)로 remap. 원시 fetch 에러("fetch failed"/AbortError)나
// non-2xx 를 그대로 노출하지 않고, 위저드가 "자연스럽게" 보여줄 사람 친화 메시지로 바꾼다(접속 불가 케이스 대응).
async function hfGet(
  f: FetchLike,
  url: string,
  headers: Record<string, string>,
  label: string,
  timeoutMs = HF_TIMEOUT_MS,
): Promise<string> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // 네트워크 실패/타임아웃/abort — HF 에 도달 불가.
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { source: "huggingface", reason: "unreachable" },
      "HuggingFace 에 접속할 수 없습니다. 네트워크를 확인하거나 잠시 후 다시 시도하세요.",
    );
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    // 401/403 은 gated 접근 문제일 가능성이 커서 행동 가능한 안내로(약관 동의 + 토큰 권한 두 가지 확인점).
    const denied =
      res.status === 401 || res.status === 403
        ? `HuggingFace 접근이 거부되었습니다 (${res.status}). gated 데이터셋이면 ① HF 계정으로 해당 데이터셋의 약관 동의(access 요청)를 했는지 ② 토큰에 이 저장소 읽기 권한이 있는지 확인하세요.`
        : `HuggingFace 응답 오류 (${res.status}).`;
    throw new UpstreamError("UPSTREAM_ERROR", { source: "huggingface", status: res.status }, denied);
  }
  return body;
}

function hfParse<T>(body: string, label: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { source: "huggingface" },
      `HuggingFace 응답을 해석할 수 없습니다 (${label}).`,
    );
  }
}

interface HfRowsResponse {
  rows?: Array<{ row: Record<string, unknown> }>;
  num_rows_total?: number;
}

// HF datasets-server /rows 로 행을 인출(필요 시 100개씩 페이징). gated 면 token 으로 인증.
export async function fetchHfRows(p: HfRowsParams, fetchImpl?: FetchLike): Promise<Array<Record<string, unknown>>> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfRows: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const config = p.config ?? "default";
  const split = p.split ?? "train";
  const limit = Math.max(1, p.limit ?? HF_PAGE);
  const headers: Record<string, string> = {};
  if (p.token) headers.Authorization = `Bearer ${p.token}`;

  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; rows.length < limit; offset += HF_PAGE) {
    const length = Math.min(HF_PAGE, limit - rows.length);
    const url =
      `${HF_ROWS}?dataset=${encodeURIComponent(p.dataset)}` +
      `&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}` +
      `&offset=${offset}&length=${length}`;
    const body = await hfGet(f, url, headers, "rows");
    const json = hfParse<HfRowsResponse>(body, "rows");
    const page = (json.rows ?? []).map((r) => r.row);
    rows.push(...page);
    const total = json.num_rows_total ?? rows.length;
    if (page.length === 0 || rows.length >= total) break;
  }
  return rows.slice(0, limit);
}

const HF_HUB = "https://huggingface.co/api/datasets";
const HF_SPLITS = "https://datasets-server.huggingface.co/splits";

// HF Hub 데이터셋 검색 결과 1건(선택용 최소 메타). gated 면 인출에 HF_TOKEN 필요.
export interface HfDatasetHit {
  id: string;
  likes: number;
  gated: boolean;
}

// HF Hub 데이터셋 검색 — 사용자가 정확한 id 를 몰라도 검색어로 후보를 고른다(raw 입력 회피). 공개 검색은 토큰 불필요.
export async function searchHfDatasets(
  query: string,
  opts: { limit?: number; token?: string; fetchImpl?: FetchLike } = {},
): Promise<HfDatasetHit[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("searchHfDatasets: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const url = `${HF_HUB}?search=${encodeURIComponent(query)}&limit=${limit}&sort=downloads&direction=-1&full=false`;
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = await hfGet(f, url, headers, "search");
  const arr = hfParse<Array<{ id?: unknown; likes?: unknown; gated?: unknown; private?: unknown }>>(body, "search");
  return arr
    .filter((d) => d.private !== true && typeof d.id === "string")
    .map((d) => ({
      id: String(d.id),
      likes: typeof d.likes === "number" ? d.likes : 0,
      // HF 의 gated 는 false | "auto" | "manual".
      gated: Boolean(d.gated) && d.gated !== "false",
    }));
}

// HF datasets-server 의 config/split 조합 — 사용자가 split 을 직접 타이핑하지 않고 드롭다운에서 고른다.
export interface HfSplit {
  config: string;
  split: string;
}

export async function fetchHfSplits(
  dataset: string,
  opts: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<HfSplit[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfSplits: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = await hfGet(f, `${HF_SPLITS}?dataset=${encodeURIComponent(dataset)}`, headers, "splits");
  const json = hfParse<{ splits?: Array<{ config?: unknown; split?: unknown }> }>(body, "splits");
  return (json.splits ?? [])
    .filter((s) => typeof s.config === "string" && typeof s.split === "string")
    .map((s) => ({ config: String(s.config), split: String(s.split) }));
}

// --- 파일 직접 인출 폴백 — datasets-server(뷰어)가 서빙하지 않는 데이터셋(officeqa 류: 뷰어 없는 gated repo) ---
// 뷰어가 없으면 /rows 가 404 라 유효한 토큰으로도 인출 불가. repo 의 데이터 파일(csv/jsonl/json)을
// Hub resolve API 로 직접 받아 파싱한다(gated 는 동일 HF_TOKEN 인증).

const DATA_FILE_RE = /\.(csv|jsonl|json)$/i;

// repo 의 데이터 파일 목록 — 파일 폴백 드롭다운용. 파일 목록(siblings)은 공개 메타데이터(gated 여도 조회 가능).
export async function fetchHfDataFiles(
  dataset: string,
  opts: { token?: string; fetchImpl?: FetchLike } = {},
): Promise<string[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfDataFiles: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const body = await hfGet(f, `${HF_HUB}/${dataset}?full=true`, headers, "files");
  const json = hfParse<{ siblings?: Array<{ rfilename?: unknown }> }>(body, "files");
  const depth = (p: string) => p.split("/").length;
  return (
    (json.siblings ?? [])
      .map((s) => (typeof s.rfilename === "string" ? s.rfilename : ""))
      .filter((p) => DATA_FILE_RE.test(p))
      // 루트 파일 우선 — 벤치마크 CSV 가 대형 코퍼스 하위 파일들(예: officeqa 의 파싱 json 1천여 개)에 묻히지 않게.
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
  );
}

export interface HfFileRowsParams {
  dataset: string;
  file: string; // repo 내 경로(예: "officeqa_pro.csv")
  limit?: number; // 미지정 = 파일 전체(파일은 어차피 통으로 받는다)
  token?: string;
}

// 데이터 파일 → 행. 확장자로 파싱(csv/jsonl/json 배열). 파일은 뷰어 페이징이 없어 통으로 받아 slice.
export async function fetchHfFileRows(
  p: HfFileRowsParams,
  fetchImpl?: FetchLike,
): Promise<Array<Record<string, unknown>>> {
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!f) throw new Error("fetchHfFileRows: no fetch implementation (pass fetchImpl or run on Node 18+)");
  const headers: Record<string, string> = {};
  if (p.token) headers.Authorization = `Bearer ${p.token}`;
  const url = `https://huggingface.co/datasets/${p.dataset}/resolve/main/${encodeURI(p.file)}`;
  const body = await hfGet(f, url, headers, "file", 30_000); // 파일은 뷰어 API 보다 클 수 있어 여유 타임아웃
  let rows: Array<Record<string, unknown>>;
  if (/\.csv$/i.test(p.file)) {
    rows = parseCsv(body);
  } else if (/\.jsonl$/i.test(p.file)) {
    rows = body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => hfParse<Record<string, unknown>>(l, "file"));
  } else {
    const parsed = hfParse<unknown>(body, "file");
    if (!Array.isArray(parsed))
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { source: "huggingface", file: p.file },
        "JSON 데이터 파일은 배열(행 목록)이어야 합니다.",
      );
    rows = parsed as Array<Record<string, unknown>>;
  }
  return p.limit !== undefined ? rows.slice(0, Math.max(1, p.limit)) : rows;
}
