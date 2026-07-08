import { describe, expect, it } from "vitest";
import { EverdictClient, EverdictError } from "./client.js";
import type { SdkFetch, SdkResponse } from "./types.js";

function res(status: number, body: unknown): SdkResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

// A fake transport: return the queued responses in call order, recording each request.
function fakeFetch(responses: SdkResponse[]): { fetch: SdkFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch: SdkFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const r = responses[i++];
    if (!r) throw new Error(`unexpected call #${i}: ${init?.method} ${url}`);
    return r;
  };
  return { fetch, calls };
}

const client = (fetch: SdkFetch) =>
  new EverdictClient({
    baseUrl: "http://cp.test/",
    apiKey: "ak_test",
    workspace: "acme",
    fetch,
    sleep: async () => {},
  });

describe("EverdictClient.evaluate", () => {
  it("submits string refs then polls to a verdict (auth + workspace headers set)", async () => {
    const { fetch, calls } = fakeFetch([
      res(202, { id: "sc1", status: "queued" }),
      res(200, { id: "sc1", status: "running" }),
      res(200, { id: "sc1", status: "succeeded", summary: [{ metric: "tests_pass", count: 2, mean: 1, passRate: 1 }] }),
    ]);
    const verdict = await client(fetch).evaluate({ harness: "h@1", dataset: "d@2", poll: { intervalMs: 1 } });

    // one submit + two polls (no registration for string refs)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST http://cp.test/scorecards",
      "GET http://cp.test/scorecards/sc1",
      "GET http://cp.test/scorecards/sc1",
    ]);
    expect(calls[0]?.body).toEqual({ dataset: { id: "d", version: "2" }, harness: { id: "h", version: "1" } });
    expect(calls[0]?.headers.authorization).toBe("Bearer ak_test");
    expect(calls[0]?.headers["x-everdict-workspace"]).toBe("acme");
    expect(verdict).toMatchObject({ scorecardId: "sc1", status: "succeeded", passRate: 1 });
  });

  it("registers an inline dataset before submitting", async () => {
    const { fetch, calls } = fakeFetch([
      res(201, { workspace: "acme", id: "d", version: "1.0.0" }), // POST /datasets
      res(202, { id: "sc2", status: "queued" }),
      res(200, { id: "sc2", status: "succeeded" }),
    ]);
    await client(fetch).evaluate({
      harness: "scripted@0",
      dataset: { id: "d", version: "1.0.0", cases: [] },
      poll: { intervalMs: 1 },
    });
    expect(calls[0]).toMatchObject({ method: "POST", url: "http://cp.test/datasets" });
    expect(calls[1]).toMatchObject({ method: "POST", url: "http://cp.test/scorecards" });
    expect(calls[1]?.body).toMatchObject({
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
  });

  it("threads trials into the submit body and reads pass@k from the trial summary", async () => {
    const { fetch, calls } = fakeFetch([
      res(202, { id: "sc3", status: "queued" }),
      res(200, {
        id: "sc3",
        status: "succeeded",
        summary: [{ metric: "tool_calls", count: 3, mean: 2 }],
        trialSummary: {
          cases: 1,
          minTrials: 5,
          maxTrials: 5,
          passAt1: 0.6,
          k: 5,
          passAtK: 1,
          flakyCases: 1,
          flakeRate: 1,
        },
      }),
    ]);
    const verdict = await client(fetch).evaluate({
      harness: "h@1",
      dataset: "d@1",
      trials: 5,
      poll: { intervalMs: 1 },
    });
    expect(calls[0]?.body).toMatchObject({ trials: 5 });
    // trial-aware: passRate = passAt1 even though a non-pass-deciding metric exists in summary
    expect(verdict).toMatchObject({ passRate: 0.6, passAt1: 0.6, passAtK: 1, flakeRate: 1 });
  });

  it("maps a control-plane error body to EverdictError with the status", async () => {
    const { fetch } = fakeFetch([res(400, { code: "BAD_REQUEST", message: "no runtime" })]);
    await expect(client(fetch).evaluate({ harness: "h@1", dataset: "d@1" })).rejects.toMatchObject({
      name: "EverdictError",
      status: 400,
      code: "BAD_REQUEST",
      message: "no runtime",
    });
  });
});

describe("EverdictClient.poll", () => {
  it("throws a TIMEOUT EverdictError when the batch never finishes in time", async () => {
    const { fetch } = fakeFetch([res(200, { id: "x", status: "running" })]);
    await expect(client(fetch).poll("x", { intervalMs: 1, timeoutMs: 0 })).rejects.toBeInstanceOf(EverdictError);
  });

  it("returns as soon as the record is terminal", async () => {
    const { fetch, calls } = fakeFetch([
      res(200, { id: "x", status: "failed", error: { code: "E", message: "boom" } }),
    ]);
    const rec = await client(fetch).poll("x", { intervalMs: 1 });
    expect(rec.status).toBe("failed");
    expect(calls).toHaveLength(1);
  });
});

describe("EverdictClient constructor", () => {
  it("requires baseUrl and apiKey", () => {
    expect(() => new EverdictClient({ baseUrl: "", apiKey: "k", fetch: async () => res(200, {}) })).toThrow();
    expect(() => new EverdictClient({ baseUrl: "http://x", apiKey: "", fetch: async () => res(200, {}) })).toThrow();
  });
});

describe("EverdictClient.evaluate progress", () => {
  it("fires onProgress on every poll with the latest record", async () => {
    const { fetch } = fakeFetch([
      res(202, { id: "sc1", status: "queued" }),
      res(200, { id: "sc1", status: "running" }),
      res(200, { id: "sc1", status: "succeeded" }),
    ]);
    const seen: string[] = [];
    await client(fetch).evaluate({
      harness: "h@1",
      dataset: "d@1",
      poll: { intervalMs: 1 },
      onProgress: (r) => seen.push(r.status),
    });
    expect(seen).toEqual(["running", "succeeded"]);
  });
});

describe("EverdictClient.diff", () => {
  it("builds the diff query (baseline/candidate/z) and returns the trial-aware diff", async () => {
    const { fetch, calls } = fakeFetch([
      res(200, {
        baseline: "h@1",
        candidate: "h@2",
        metrics: [],
        regressions: [],
        improvements: [],
        trials: {
          zThreshold: 1.96,
          cases: [],
          regressions: [{ caseId: "c1", z: -3.1, significant: true }],
          improvements: [],
        },
      }),
    ]);
    const diff = await client(fetch).diff("sc-a", "sc-b", { z: 2.58 });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("http://cp.test/scorecards/diff?baseline=sc-a&candidate=sc-b&z=2.58");
    expect(diff.trials?.regressions[0]?.caseId).toBe("c1");
  });
});

describe("EverdictClient.leaderboard", () => {
  it("builds the leaderboard query from the options", async () => {
    const { fetch, calls } = fakeFetch([res(200, { dataset: "d", metric: "judge", window: "best", rows: [] })]);
    const lb = await client(fetch).leaderboard({ dataset: "swe", metric: "tests_pass", window: "best", harness: "h" });
    expect(calls[0]?.url).toBe(
      "http://cp.test/scorecards/leaderboard?dataset=swe&metric=tests_pass&harness=h&window=best",
    );
    expect(lb.window).toBe("best");
  });
});
