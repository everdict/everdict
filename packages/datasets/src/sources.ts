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
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const HF_ROWS = "https://datasets-server.huggingface.co/rows";
const HF_PAGE = 100; // datasets-server 의 한 번 호출 최대 length.

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
    const res = await f(url, { headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`HF datasets-server ${res.status} for ${p.dataset}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body) as HfRowsResponse;
    const page = (json.rows ?? []).map((r) => r.row);
    rows.push(...page);
    const total = json.num_rows_total ?? rows.length;
    if (page.length === 0 || rows.length >= total) break;
  }
  return rows.slice(0, limit);
}
