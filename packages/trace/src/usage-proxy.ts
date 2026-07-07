import http from "node:http";
import https from "node:https";

// LLM 사용량 프록시(사이드카) — BYO 엔드포인트(LiteLLM/OpenAI 등) 앞에 두고, 통과시키며 응답의 토큰 usage 를
// run 단위로 회수한다. 블랙박스 하니스(aider 등 trace:none)도 코드 수정 없이 토큰을 계측할 수 있다(하니스는
// OPENAI_API_BASE 만 이 프록시로 향하면 됨). 비용($)은 지금은 안 모음 — 토큰만(결정). 추후 계량 모델의 $는
// 업스트림이 주는 x-litellm-response-cost 헤더로 확장 가능.

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number; // 계량 모델의 실제 비용(게이트웨이 헤더). 구독 모델은 0.
  calls: number; // 이 run 으로 귀속된 LLM 호출 수
}

// LiteLLM 응답 헤더에서 이 호출의 비용($)을 읽는다. 버전별 헤더명 차이 대응(없거나 0 이면 0).
const COST_HEADERS = ["x-litellm-response-cost", "x-litellm-response-cost-original"] as const;
export function costFromHeaders(headers: Record<string, string | string[] | undefined>): number {
  for (const name of COST_HEADERS) {
    const v = headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    if (s !== undefined) {
      const n = Number(s);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

// OpenAI-호환 응답 body 에서 usage 추출. 스트리밍/비JSON/usage 없음 → null.
export function extractUsage(body: string): { prompt: number; completion: number; total: number } | null {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const u = (j as { usage?: unknown }).usage;
  if (typeof u !== "object" || u === null) return null;
  const rec = u as Record<string, unknown>;
  const prompt = Number(rec.prompt_tokens ?? 0);
  const completion = Number(rec.completion_tokens ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  const totalRaw = Number(rec.total_tokens ?? Number.NaN);
  const total = Number.isFinite(totalRaw) ? totalRaw : prompt + completion;
  return { prompt, completion, total };
}

export interface UsageTally {
  record(runId: string, u: { prompt: number; completion: number; total: number; usd?: number }): void;
  get(runId: string): RunUsage;
  snapshot(): Record<string, RunUsage>;
}

export function inMemoryUsageTally(): UsageTally {
  const m = new Map<string, RunUsage>();
  const get = (runId: string): RunUsage => {
    let u = m.get(runId);
    if (!u) {
      u = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usd: 0, calls: 0 };
      m.set(runId, u);
    }
    return u;
  };
  return {
    record(runId, c) {
      const u = get(runId);
      u.promptTokens += c.prompt;
      u.completionTokens += c.completion;
      u.totalTokens += c.total;
      u.usd += c.usd ?? 0;
      u.calls += 1;
    },
    get(runId) {
      return { ...get(runId) };
    },
    snapshot() {
      return Object.fromEntries([...m.entries()].map(([k, v]) => [k, { ...v }]));
    },
  };
}

export interface UsageProxyOptions {
  upstreamBaseUrl: string; // BYO 업스트림(예: http://litellm.internal:4000). /v1/... 경로 그대로 전달.
  runHeader?: string; // 요청을 run 에 귀속시키는 헤더(기본 x-everdict-run). 헤더 없으면 defaultRunId.
  defaultRunId?: string; // 헤더 없을 때 귀속할 run(기본 "default"). per-run 프록시 인스턴스용.
  tally?: UsageTally;
}

export interface UsageProxy {
  server: http.Server;
  tally: UsageTally;
}

export interface StartedUsageProxy {
  url: string; // http://127.0.0.1:<port> — 하니스의 OPENAI_API_BASE 로 꽂는다
  tally: UsageTally;
  close(): Promise<void>;
}

// 127.0.0.1 임시 포트로 즉시 띄운 사이드카. CommandHarness 가 자식(aider 등)의 OPENAI_API_BASE 를 url 로 돌린다.
export async function startUsageProxy(opts: UsageProxyOptions): Promise<StartedUsageProxy> {
  const { server, tally } = createUsageProxy(opts);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, tally, close: () => new Promise((r) => server.close(() => r())) };
}

// 주어진 키(대소문자 무시)를 뺀 새 헤더 객체. (delete 회피 — biome noDelete)
function omitHeaders(src: http.IncomingHttpHeaders, drop: string[]): http.OutgoingHttpHeaders {
  const dropSet = new Set(drop.map((d) => d.toLowerCase()));
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !dropSet.has(k.toLowerCase())) out[k] = v;
  return out;
}

// 통과(reverse-proxy)하면서 응답 usage 를 회수하는 사이드카. 응답/요청은 버퍼링 후 그대로 전달(본문 변형 없음).
export function createUsageProxy(opts: UsageProxyOptions): UsageProxy {
  const tally = opts.tally ?? inMemoryUsageTally();
  const runHeader = (opts.runHeader ?? "x-everdict-run").toLowerCase();
  const defaultRunId = opts.defaultRunId ?? "default";
  const upstream = new URL(opts.upstreamBaseUrl);
  const client = upstream.protocol === "https:" ? https : http;
  const basePath = upstream.pathname.replace(/\/$/, "");

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const hdr = req.headers[runHeader];
      const runId = (Array.isArray(hdr) ? hdr[0] : hdr) ?? defaultRunId;

      // 요청 헤더: host 를 업스트림으로, 귀속 헤더 제거, 본문 길이 재설정(청크드 회피).
      const reqHeaders: http.OutgoingHttpHeaders = {
        ...omitHeaders(req.headers, [runHeader, "transfer-encoding", "host"]),
        host: upstream.host,
        "content-length": String(body.length),
      };

      const upReq = client.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
          method: req.method,
          path: `${basePath}${req.url ?? ""}`,
          headers: reqHeaders,
        },
        (upRes) => {
          const rc: Buffer[] = [];
          upRes.on("data", (d) => rc.push(d as Buffer));
          upRes.on("end", () => {
            const rb = Buffer.concat(rc);
            const u = extractUsage(rb.toString("utf8"));
            if (u) tally.record(runId, { ...u, usd: costFromHeaders(upRes.headers) }); // 토큰(body) + 비용(헤더)
            // 응답 헤더: 버퍼 전체를 다시 보내므로 길이/인코딩은 Node 가 다시 설정하게 둔다.
            const respHeaders = omitHeaders(upRes.headers, ["transfer-encoding", "content-length"]);
            res.writeHead(upRes.statusCode ?? 502, respHeaders);
            res.end(rb);
          });
        },
      );
      upReq.on("error", (e) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `usage-proxy upstream error: ${e.message}` } }));
      });
      upReq.end(body);
    });
  });
  return { server, tally };
}
