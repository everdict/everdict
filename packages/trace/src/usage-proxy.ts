import http from "node:http";
import https from "node:https";

// LLM usage proxy (sidecar) — sits in front of a BYO endpoint (LiteLLM/OpenAI etc.), passes traffic through, and
// collects the response's token usage per run. Even a black-box harness (aider etc., trace:none) can be measured for
// tokens with no code change (the harness just points OPENAI_API_BASE at this proxy). Cost ($) isn't collected for now
// — tokens only (a decision). Metered-model $ can later be added from the upstream's x-litellm-response-cost header.

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number; // the metered model's actual cost (gateway header). 0 for subscription models.
  calls: number; // the number of LLM calls attributed to this run
}

// Read this call's cost ($) from the LiteLLM response headers. Handles per-version header-name differences (absent or 0 → 0).
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

// Extract usage from an OpenAI-compatible response body. Streaming / non-JSON / no usage → null.
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
  upstreamBaseUrl: string; // BYO upstream (e.g. http://litellm.internal:4000). Forwards the /v1/... path as-is.
  runHeader?: string; // the header that attributes a request to a run (default x-everdict-run). No header → defaultRunId.
  defaultRunId?: string; // the run to attribute to when the header is absent (default "default"). For a per-run proxy instance.
  tally?: UsageTally;
}

export interface UsageProxy {
  server: http.Server;
  tally: UsageTally;
}

export interface StartedUsageProxy {
  url: string; // http://127.0.0.1:<port> — plug into the harness's OPENAI_API_BASE
  tally: UsageTally;
  close(): Promise<void>;
}

// A sidecar brought up immediately on an ephemeral 127.0.0.1 port. CommandHarness points its child's (aider etc.) OPENAI_API_BASE at url.
export async function startUsageProxy(opts: UsageProxyOptions): Promise<StartedUsageProxy> {
  const { server, tally } = createUsageProxy(opts);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, tally, close: () => new Promise((r) => server.close(() => r())) };
}

// A new headers object with the given keys (case-insensitive) removed. (avoids delete — biome noDelete)
function omitHeaders(src: http.IncomingHttpHeaders, drop: string[]): http.OutgoingHttpHeaders {
  const dropSet = new Set(drop.map((d) => d.toLowerCase()));
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined && !dropSet.has(k.toLowerCase())) out[k] = v;
  return out;
}

// A sidecar that passes traffic through (reverse-proxy) while collecting the response usage. Request/response are buffered then forwarded as-is (no body mutation).
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

      // Request headers: set host to the upstream, strip the attribution header, reset the body length (avoid chunked).
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
            if (u) tally.record(runId, { ...u, usd: costFromHeaders(upRes.headers) }); // tokens (body) + cost (header)
            // Response headers: since we resend the whole buffer, let Node reset length/encoding.
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
