import { type Authenticator, apiKeyAuthenticator, compositeAuthenticator } from "@assay/auth";
import type { Dispatcher } from "@assay/backends";
import { inMemoryBudget } from "@assay/backends";
import type { CaseResult } from "@assay/core";
import { InMemoryRunStore, InMemoryTenantKeyStore, issueKey } from "@assay/db";
import { InMemoryDatasetRegistry, InMemoryHarnessRegistry } from "@assay/registry";
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
const DATASET = {
  id: "smoke",
  version: "1.0.0",
  cases: [{ id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [{ id: "steps" }] }],
};

// 토큰 무관하게 고정 역할 Principal 을 주는 스텁(authZ 테스트용).
const roleAuth = (roles: string[], workspace = "acme"): Authenticator => ({
  async authenticate() {
    return { subject: "u", workspace, roles, via: "oidc" };
  },
});

let n = 0;
function server(
  opts: {
    budget?: ReturnType<typeof inMemoryBudget>;
    requireAuth?: boolean;
    internalToken?: string;
    authenticator?: Authenticator;
    authorizationServers?: string[];
  } = {},
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
    datasetRegistry: new InMemoryDatasetRegistry(),
    authenticator: opts.authenticator ?? compositeAuthenticator([apiKeyAuthenticator({ keyStore })]),
    keyStore,
    internalToken: opts.internalToken,
    requireAuth: opts.requireAuth,
    ...(opts.authorizationServers ? { authorizationServers: opts.authorizationServers } : {}),
  });
  return { app, keyStore };
}

describe("API — dev fallback (no auth required)", () => {
  it("x-assay-tenant 헤더로 동작; 다른 tenant 는 남의 run 못 봄", async () => {
    const { app } = server();
    const post = await app.inject({
      method: "POST",
      url: "/runs",
      headers: { "x-assay-tenant": "acme" },
      payload: BODY,
    });
    expect(post.statusCode).toBe(202);
    const rec = post.json();
    const beta = await app.inject({ method: "GET", url: `/runs/${rec.id}`, headers: { "x-assay-tenant": "beta" } });
    expect(beta.statusCode).toBe(404);
    await app.close();
  });

  it("예산 초과 → 402", async () => {
    const { app } = server({ budget: inMemoryBudget({ limitFor: () => ({ runs: 1 }) }) });
    const h = { "x-assay-tenant": "free" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(402);
    await app.close();
  });
});

describe("API — authentication (control-plane owned)", () => {
  it("requireAuth: Bearer 없으면 401, API 키로 통과 + /me", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    expect((await app.inject({ method: "GET", url: "/harnesses" })).statusCode).toBe(401);
    const key = await issueKey(keyStore, "acme");
    const h = { authorization: `Bearer ${key}` };
    expect((await app.inject({ method: "GET", url: "/harnesses", headers: h })).statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", headers: h });
    expect(me.json()).toMatchObject({ workspace: "acme", via: "api-key" });
    await app.close();
  });
});

describe("API — authorization (roles)", () => {
  it("viewer 는 읽기만 (submit/register 403)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "GET", url: "/runs", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: HARNESS })).statusCode).toBe(
      403,
    );
    await app.close();
  });
  it("member 는 submit 가능하나 harness 등록은 403", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "POST", url: "/runs", headers: h, payload: BODY })).statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: HARNESS })).statusCode).toBe(
      403,
    );
    await app.close();
  });
  it("admin 은 harness 등록 가능", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["admin"]) });
    const h = { authorization: "Bearer x" };
    expect((await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: HARNESS })).statusCode).toBe(
      201,
    );
    await app.close();
  });
});

describe("API — harness ownership (workspace-scoped)", () => {
  it("등록 → 본인은 보이고 타 워크스페이스는 못 봄; 불변성 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect(
      (await app.inject({ method: "POST", url: "/harnesses", headers: { authorization: acme }, payload: HARNESS }))
        .statusCode,
    ).toBe(201);
    const aList = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: acme } });
    expect(aList.json().map((x: { id: string }) => x.id)).toContain("bu");
    const bList = await app.inject({ method: "GET", url: "/harnesses", headers: { authorization: beta } });
    expect(bList.json()).toEqual([]);
    const mutated = { ...HARNESS, dependencies: [{ store: "redis", role: "x", isolateBy: "key-prefix" }] };
    const dup = await app.inject({
      method: "POST",
      url: "/harnesses",
      headers: { authorization: acme },
      payload: mutated,
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });
});

describe("API — internal key issuance", () => {
  it("토큰 맞으면 키 발급, 틀리면 403, 미설정이면 404", async () => {
    const { app } = server({ internalToken: "s3cret" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/tenant-keys",
          headers: { "x-internal-token": "no" },
          payload: { workspace: "acme" },
        })
      ).statusCode,
    ).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/internal/tenant-keys",
      headers: { "x-internal-token": "s3cret" },
      payload: { workspace: "acme" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().apiKey.startsWith("ak_")).toBe(true);
    const off = server();
    expect(
      (
        await off.app.inject({
          method: "POST",
          url: "/internal/tenant-keys",
          headers: { "x-internal-token": "x" },
          payload: { workspace: "a" },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
    await off.app.close();
  });

  it("healthz", async () => {
    const { app } = server();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ ok: true });
    await app.close();
  });
});

describe("API — MCP OAuth (login like Linear)", () => {
  it("미인증 POST /mcp → 401 + WWW-Authenticate(resource_metadata)", async () => {
    const { app } = server();
    const res = await app.inject({ method: "POST", url: "/mcp", payload: { jsonrpc: "2.0", id: 1, method: "ping" } });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain('resource_metadata="');
    expect(res.headers["www-authenticate"]).toContain("/.well-known/oauth-protected-resource");
    await app.close();
  });

  it("protected-resource 메타데이터가 Keycloak 을 인가서버로 가리킨다", async () => {
    const { app } = server({ authorizationServers: ["http://kc/realms/assay"] });
    const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });
    expect(res.statusCode).toBe(200);
    const meta = res.json();
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.authorization_servers).toEqual(["http://kc/realms/assay"]);
    expect(meta.bearer_methods_supported).toContain("header");
    await app.close();
  });

  it("인증됐지만 세션 없는 GET /mcp → 400 (initialize 먼저)", async () => {
    const { app, keyStore } = server();
    const key = await issueKey(keyStore, "acme");
    const res = await app.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("미인증 GET /mcp → 401 챌린지", async () => {
    const { app } = server();
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    await app.close();
  });
});

describe("API — harness validate (dry-run)", () => {
  it("admin: 유효 스펙 → ok + 기존버전/충돌 표시 (등록하지 않음)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const v1 = await app.inject({ method: "POST", url: "/harnesses/validate", headers: h, payload: HARNESS });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({
      ok: true,
      id: "bu",
      version: "1.0.0",
      existingVersions: [],
      versionExists: false,
    });
    await app.inject({ method: "POST", url: "/harnesses", headers: h, payload: HARNESS }); // 실제 등록
    const v2 = await app.inject({ method: "POST", url: "/harnesses/validate", headers: h, payload: HARNESS });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    const list = await app.inject({ method: "GET", url: "/harnesses", headers: h });
    expect(list.json().find((x: { id: string }) => x.id === "bu").versions).toEqual(["1.0.0"]); // validate 가 중복등록 안 함
    await app.close();
  });

  it("스키마 오류 → ok:false + errors (200)", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const res = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: h,
      payload: { kind: "service", id: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().errors.length).toBeGreaterThan(0);
    await app.close();
  });

  it("member 는 검증 불가 (403)", async () => {
    const { app } = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    const res = await app.inject({
      method: "POST",
      url: "/harnesses/validate",
      headers: { authorization: "Bearer x" },
      payload: HARNESS,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("API — datasets (workspace-owned, member+ write)", () => {
  it("viewer 는 읽기만 (write 403); member 는 등록 가능", async () => {
    const viewer = server({ requireAuth: true, authenticator: roleAuth(["viewer"]) });
    const vh = { authorization: "Bearer x" };
    expect((await viewer.app.inject({ method: "GET", url: "/datasets", headers: vh })).statusCode).toBe(200);
    expect(
      (await viewer.app.inject({ method: "POST", url: "/datasets", headers: vh, payload: DATASET })).statusCode,
    ).toBe(403);
    await viewer.app.close();

    const member = server({ requireAuth: true, authenticator: roleAuth(["member"]) });
    expect(
      (await member.app.inject({ method: "POST", url: "/datasets", headers: vh, payload: DATASET })).statusCode,
    ).toBe(201);
    await member.app.close();
  });

  it("등록 → 본인은 보이고 타 워크스페이스는 못 봄(get 404); 불변성 409", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const acme = `Bearer ${await issueKey(keyStore, "acme")}`;
    const beta = `Bearer ${await issueKey(keyStore, "beta")}`;
    expect(
      (await app.inject({ method: "POST", url: "/datasets", headers: { authorization: acme }, payload: DATASET }))
        .statusCode,
    ).toBe(201);
    const aList = await app.inject({ method: "GET", url: "/datasets", headers: { authorization: acme } });
    expect(aList.json().map((x: { id: string }) => x.id)).toContain("smoke");
    expect((await app.inject({ method: "GET", url: "/datasets", headers: { authorization: beta } })).json()).toEqual(
      [],
    );

    const aGet = await app.inject({
      method: "GET",
      url: "/datasets/smoke/versions/latest",
      headers: { authorization: acme },
    });
    expect(aGet.statusCode).toBe(200);
    expect(aGet.json()).toMatchObject({ id: "smoke", version: "1.0.0" });
    const bGet = await app.inject({
      method: "GET",
      url: "/datasets/smoke/versions/latest",
      headers: { authorization: beta },
    });
    expect(bGet.statusCode).toBe(404);

    const mutated = { ...DATASET, description: "changed" };
    const dup = await app.inject({
      method: "POST",
      url: "/datasets",
      headers: { authorization: acme },
      payload: mutated,
    });
    expect(dup.statusCode).toBe(409);
    await app.close();
  });

  it("validate dry-run: 유효 → ok + versionExists 표시, 등록 안 함", async () => {
    const { app, keyStore } = server({ requireAuth: true });
    const h = { authorization: `Bearer ${await issueKey(keyStore, "acme")}` };
    const v1 = await app.inject({ method: "POST", url: "/datasets/validate", headers: h, payload: DATASET });
    expect(v1.json()).toMatchObject({ ok: true, id: "smoke", version: "1.0.0", versionExists: false, cases: 1 });
    await app.inject({ method: "POST", url: "/datasets", headers: h, payload: DATASET }); // 실제 등록
    const v2 = await app.inject({ method: "POST", url: "/datasets/validate", headers: h, payload: DATASET });
    expect(v2.json()).toMatchObject({ ok: true, versionExists: true, existingVersions: ["1.0.0"] });
    await app.close();
  });
});
