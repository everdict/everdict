import type { Dispatcher } from "@assay/backends";
import { inMemoryBudget } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import { describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
import { InMemoryRunStore } from "./run-store.js";
import { buildServer } from "./server.js";

const result: CaseResult = {
  caseId: "c1",
  harness: "scripted@0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [],
};
const okDispatcher: Dispatcher = {
  async dispatch() {
    return result;
  },
};

const BODY = {
  harness: { id: "scripted", version: "0" },
  case: { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
};

let n = 0;
function server(opts: { budget?: ReturnType<typeof inMemoryBudget> } = {}) {
  const svc = new RunService({
    dispatcher: okDispatcher,
    store: new InMemoryRunStore(),
    newId: () => `run-${n++}`,
    budget: opts.budget,
  });
  return buildServer({ service: svc });
}

describe("API server", () => {
  it("POST /runs → 202 + runId, 그 뒤 GET /runs/:id 로 결과 폴링", async () => {
    const app = server();
    const post = await app.inject({
      method: "POST",
      url: "/runs",
      headers: { "x-assay-tenant": "acme" },
      payload: BODY,
    });
    expect(post.statusCode).toBe(202);
    const rec = post.json();
    expect(rec.status).toBe("queued");
    expect(rec.tenant).toBe("acme");

    await new Promise((r) => setTimeout(r, 0));
    const get = await app.inject({ method: "GET", url: `/runs/${rec.id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe("succeeded");
    await app.close();
  });

  it("GET /runs/:missing → 404", async () => {
    const app = server();
    const res = await app.inject({ method: "GET", url: "/runs/nope" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("잘못된 본문 → 400", async () => {
    const app = server();
    const res = await app.inject({ method: "POST", url: "/runs", payload: { harness: { id: "x" } } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("예산 초과 → 402 BUDGET_EXCEEDED", async () => {
    const app = server({ budget: inMemoryBudget({ limitFor: () => ({ runs: 1 }) }) });
    const h = { "x-assay-tenant": "free" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    const over = await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY });
    expect(over.statusCode).toBe(402);
    expect(over.json().code).toBe("BUDGET_EXCEEDED");
    await app.close();
  });

  it("healthz", async () => {
    const app = server();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
    await app.close();
  });
});
