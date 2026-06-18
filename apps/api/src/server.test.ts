import type { Dispatcher } from "@assay/backends";
import { inMemoryBudget } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import { InMemoryRunStore, InMemoryTenantKeyStore, issueKey, keyStoreAuth } from "@assay/db";
import { InMemoryHarnessRegistry } from "@assay/registry";
import { describe, expect, it } from "vitest";
import { RunService } from "./run-service.js";
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
const HARNESS = {
  kind: "service",
  id: "bu",
  version: "1.0.0",
  services: [{ name: "agent-server", image: "img", port: 8080, needs: [], perRun: [], replicas: 1 }],
  dependencies: [],
  frontDoor: { service: "agent-server", submit: "POST /runs" },
  traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
};

let n = 0;
function server(
  opts: { budget?: ReturnType<typeof inMemoryBudget>; requireAuth?: boolean; internalToken?: string } = {},
) {
  const keyStore = new InMemoryTenantKeyStore();
  const svc = new RunService({
    dispatcher: okDispatcher,
    store: new InMemoryRunStore(),
    newId: () => `run-${n++}`,
    budget: opts.budget,
  });
  const app = buildServer({
    service: svc,
    registry: new InMemoryHarnessRegistry(),
    auth: keyStoreAuth(keyStore),
    keyStore,
    internalToken: opts.internalToken,
    requireAuth: opts.requireAuth,
  });
  return { app, keyStore };
}

describe("API server — runs (dev tenant header)", () => {
  it("POST /runs → 202, GET /runs/:id (같은 tenant) → succeeded", async () => {
    const { app } = server();
    const h = { "x-assay-tenant": "acme" };
    const post = await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY });
    expect(post.statusCode).toBe(202);
    const rec = post.json();
    await new Promise((r) => setTimeout(r, 0));
    const get = await app.inject({ method: "GET", url: `/runs/${rec.id}`, headers: h });
    expect(get.json().status).toBe("succeeded");
    await app.close();
  });

  it("다른 tenant 는 남의 run 을 못 본다 (404)", async () => {
    const { app } = server();
    const post = await app.inject({
      method: "POST",
      url: "/runs",
      headers: { "x-assay-tenant": "acme" },
      payload: BODY,
    });
    const rec = post.json();
    const get = await app.inject({ method: "GET", url: `/runs/${rec.id}`, headers: { "x-assay-tenant": "beta" } });
    expect(get.statusCode).toBe(404);
    await app.close();
  });

  it("예산 초과 → 402", async () => {
    const { app } = server({ budget: inMemoryBudget({ limitFor: () => ({ runs: 1 }) }) });
    const h = { "x-assay-tenant": "free" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    const over = await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY });
    expect(over.statusCode).toBe(402);
    await app.close();
  });
});

describe("API server — API key auth", () => {
  it("requireAuth: Bearer 없으면 401, 발급 키로는 통과 + tenant 파생", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    expect((await app.inject({ method: "GET", url: "/harnesses" })).statusCode).toBe(401); // no Bearer
    const key = await issueKey(keyStore, "acme");
    const ok = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: `Bearer ${key}` } });
    expect(ok.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: "Bearer ak_bad" } })).statusCode,
    ).toBe(401);
    await app.close();
  });
});

describe("API server — harnesses (tenant-owned)", () => {
  it("POST /harnesses 등록 → GET 으로 보이고, 다른 tenant 에겐 안 보인다", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect(
      (await app.inject({ method: "POST", url: "/harnesses", headers: { authorization: acme }, payload: HARNESS }))
        .statusCode,
    ).toBe(201);

    const acmeList = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: acme } });
    expect(acmeList.json().map((h: { id: string }) => h.id)).toContain("bu");
    const betaList = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: beta } });
    expect(betaList.json()).toEqual([]); // 격리
    await app.close();
  });

  it("불변성: 같은 버전 다른 스펙 재등록 → 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    await app.inject({ method: "POST", url: "/harnesses", headers: { authorization: acme }, payload: HARNESS });
    const mutated = { ...HARNESS, dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    const res = await app.inject({
      method: "POST",
      url: "/harnesses",
      headers: { authorization: acme },
      payload: mutated,
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("API server — internal key issuance", () => {
  it("x-internal-token 가드: 토큰 맞으면 키 발급, 틀리면 403", async () => {
    const { app } = server({ internalToken: "s3cret" });
    const bad = await app.inject({
      method: "POST",
      url: "/internal/tenant-keys",
      headers: { "x-internal-token": "no" },
      payload: { tenant: "acme" },
    });
    expect(bad.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/internal/tenant-keys",
      headers: { "x-internal-token": "s3cret" },
      payload: { tenant: "acme" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().apiKey.startsWith("ak_")).toBe(true);
    await app.close();
  });

  it("internalToken 미설정이면 fail-closed (404)", async () => {
    const { app } = server();
    const res = await app.inject({
      method: "POST",
      url: "/internal/tenant-keys",
      headers: { "x-internal-token": "x" },
      payload: { tenant: "a" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("healthz", async () => {
    const { app } = server();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
    await app.close();
  });
});
