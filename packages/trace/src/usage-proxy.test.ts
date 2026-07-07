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
  it("extracts usage, and falls back to prompt+completion when total is absent", () => {
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
  it("no usage / non-JSON → null", () => {
    expect(extractUsage(JSON.stringify({ choices: [] }))).toBeNull();
    expect(extractUsage("data: [DONE]")).toBeNull();
    expect(extractUsage("")).toBeNull();
  });
});

describe("costFromHeaders", () => {
  it("reads $ from the LiteLLM cost header (per-version names), 0 when absent", () => {
    expect(costFromHeaders({ "x-litellm-response-cost": "0.0031" })).toBeCloseTo(0.0031);
    expect(costFromHeaders({ "x-litellm-response-cost-original": "0.5" })).toBe(0.5); // this version's header name
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
    // Fake upstream: returns chat/completions with usage, and records the attribution header it received.
    upstream = http.createServer((req, res) => {
      seenRunHeader = req.headers["x-everdict-run"] as string | undefined;
      const body = JSON.stringify({
        id: "x",
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      // Return the cost header too, like a metered model (verify the proxy collects $ as well).
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

  it("passes the response through unchanged and accumulates tokens+cost per run", async () => {
    const r = await callThrough("r1");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { choices: { message: { content: string } }[] };
    expect(j.choices[0]?.message.content).toBe("hi"); // no body mutation
    await callThrough("r1");
    await callThrough("r2");

    const r1 = tally.get("r1");
    expect(r1).toMatchObject({ promptTokens: 20, completionTokens: 10, totalTokens: 30, calls: 2 });
    expect(r1.usd).toBeCloseTo(0.004); // 0.002 × 2 (cost header accumulated)
    const r2 = tally.get("r2");
    expect(r2).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15, calls: 1 });
    expect(r2.usd).toBeCloseTo(0.002);
  });

  it("the attribution header does not leak to the upstream (the proxy strips it)", async () => {
    await callThrough("rX");
    expect(seenRunHeader).toBeUndefined();
  });

  it("attributes to the default run when the header is absent", async () => {
    const before = tally.get("default").calls;
    await callThrough();
    expect(tally.get("default").calls).toBe(before + 1);
  });
});
