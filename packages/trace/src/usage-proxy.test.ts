import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costFromHeaders, createUsageProxy, extractUsage, inMemoryUsageTally } from "./usage-proxy.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
}
const close = (s: http.Server): Promise<void> => new Promise((r) => s.close(() => r()));

describe("extractUsage", () => {
  it("usage 를 추출하고, total 없으면 prompt+completion 으로 보정", () => {
    expect(
      extractUsage(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })),
    ).toEqual({
      prompt: 10,
      completion: 5,
      total: 15,
    });
    expect(extractUsage(JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } }))).toEqual({
      prompt: 7,
      completion: 3,
      total: 10,
    });
  });
  it("usage 없음 / 비JSON → null", () => {
    expect(extractUsage(JSON.stringify({ choices: [] }))).toBeNull();
    expect(extractUsage("data: [DONE]")).toBeNull();
    expect(extractUsage("")).toBeNull();
  });
});

describe("costFromHeaders", () => {
  it("LiteLLM 비용 헤더(버전별 이름)에서 $ 를 읽고, 없으면 0", () => {
    expect(costFromHeaders({ "x-litellm-response-cost": "0.0031" })).toBeCloseTo(0.0031);
    expect(costFromHeaders({ "x-litellm-response-cost-original": "0.5" })).toBe(0.5); // 이 버전 헤더명
    expect(costFromHeaders({ "content-type": "application/json" })).toBe(0);
    expect(costFromHeaders({ "x-litellm-response-cost": "nope" })).toBe(0);
  });
});

describe("createUsageProxy", () => {
  let upstream: http.Server;
  let proxy: http.Server;
  let proxyPort = 0;
  let seenRunHeader: string | undefined;
  const tally = inMemoryUsageTally();

  beforeAll(async () => {
    // 가짜 업스트림: usage 가 든 chat/completions 를 돌려주고, 받은 귀속 헤더를 기록.
    upstream = http.createServer((req, res) => {
      seenRunHeader = req.headers["x-everdict-run"] as string | undefined;
      const body = JSON.stringify({
        id: "x",
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      // 계량 모델처럼 비용 헤더를 함께 반환(프록시가 $도 회수하는지 검증).
      res.writeHead(200, { "content-type": "application/json", "x-litellm-response-cost-original": "0.002" });
      res.end(body);
    });
    const upPort = await listen(upstream);
    const p = createUsageProxy({ upstreamBaseUrl: `http://127.0.0.1:${upPort}`, tally });
    proxy = p.server;
    proxyPort = await listen(proxy);
  });
  afterAll(async () => {
    await close(proxy);
    await close(upstream);
  });

  const callThrough = (runId?: string) =>
    fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(runId ? { "x-everdict-run": runId } : {}) },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "u" }] }),
    });

  it("응답을 그대로 통과시키고(passthrough) run 별 토큰+비용을 누적", async () => {
    const r = await callThrough("r1");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]?.message.content).toBe("hi"); // 본문 변형 없음
    await callThrough("r1");
    await callThrough("r2");

    const r1 = tally.get("r1");
    expect(r1).toMatchObject({ promptTokens: 20, completionTokens: 10, totalTokens: 30, calls: 2 });
    expect(r1.usd).toBeCloseTo(0.004); // 0.002 × 2 (비용 헤더 누적)
    const r2 = tally.get("r2");
    expect(r2).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15, calls: 1 });
    expect(r2.usd).toBeCloseTo(0.002);
  });

  it("귀속 헤더는 업스트림으로 새지 않는다(프록시가 제거)", async () => {
    await callThrough("rX");
    expect(seenRunHeader).toBeUndefined();
  });

  it("헤더 없으면 default run 에 귀속", async () => {
    const before = tally.get("default").calls;
    await callThrough();
    expect(tally.get("default").calls).toBe(before + 1);
  });
});
