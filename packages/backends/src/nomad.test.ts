import { RESULT_SENTINEL } from "@assay/agent";
import { type AgentJob, BadRequestError, type CaseResult } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
import { NomadBackend, type NomadHttp, buildNomadJob, fetchHttp } from "./nomad.js";
import { staticSecrets } from "./secrets.js";
import { perTenantTrustZones, staticTrustZones } from "./trust-zone.js";

const JOB: AgentJob = {
  harness: { id: "claude-code", version: "latest" },
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [{ id: "steps" }],
    timeoutSec: 60,
    tags: [],
  },
};

const RESULT: CaseResult = {
  caseId: "c1",
  harness: "claude-code@latest",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "abc" },
  scores: [{ graderId: "steps", metric: "tool_calls", value: 0 }],
};

describe("buildNomadJob", () => {
  it("이미지·격리 런타임·시크릿·잡 페이로드를 task spec 에 담는다", () => {
    const spec = buildNomadJob(JOB, {
      addr: "http://nomad:4646",
      image: "reg/assay-agent:1",
      secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      runtime: "runsc",
    });
    const task = spec.Job.TaskGroups[0]?.Tasks[0];
    expect(task?.Config.image).toBe("reg/assay-agent:1");
    expect(task?.Config.runtime).toBe("runsc");
    expect(task?.Env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    const decoded = JSON.parse(Buffer.from(task?.Env.ASSAY_AGENT_JOB ?? "", "base64").toString("utf8"));
    expect(decoded.evalCase.id).toBe("c1");
    expect(decoded.harness.id).toBe("claude-code");
  });
});

describe("fetchHttp (Nomad API 인증)", () => {
  it("apiToken 이 있으면 X-Nomad-Token 헤더를 싣는다", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })));
    const http = fetchHttp("http://nomad:4646", "secret-acl-token", fetchImpl as typeof fetch);
    await http.request("GET", "/v1/jobs");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://nomad:4646/v1/jobs");
    expect((init.headers as Record<string, string>)["x-nomad-token"]).toBe("secret-acl-token");
  });

  it("apiToken 이 없으면 X-Nomad-Token 을 싣지 않는다", async () => {
    const fetchImpl = vi.fn((_u: string, _i?: RequestInit) => Promise.resolve(new Response("{}", { status: 200 })));
    const http = fetchHttp("http://nomad:4646", undefined, fetchImpl as typeof fetch);
    await http.request("GET", "/v1/jobs");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.["x-nomad-token"]).toBeUndefined();
  });
});

describe("NomadBackend.dispatch", () => {
  it("잡 제출 → alloc 완료 폴링 → stdout sentinel 에서 CaseResult 파싱", async () => {
    const calls: string[] = [];
    const http: NomadHttp = {
      async request(method, path) {
        calls.push(`${method} ${path}`);
        if (path === "/v1/jobs") return { status: 200, text: "{}" };
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "alloc1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/"))
          return { status: 200, text: `prelude line\n${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({ addr: "http://nomad:4646", image: "img", http, pollIntervalMs: 1 });

    const result = await backend.dispatch(JOB);

    expect(result.caseId).toBe("c1");
    expect(result.harness).toBe("claude-code@latest");
    expect(calls.some((c) => c === "POST /v1/jobs")).toBe(true);
    expect(calls.some((c) => c.includes("/allocations"))).toBe(true);
    expect(calls.some((c) => c.includes("/logs/alloc1"))).toBe(true);
  });

  it("trustZones: 테넌트 존을 잡마다 적용한다 (네임스페이스 + 강격리 런타임)", async () => {
    let posted: {
      Job?: { Namespace?: string; TaskGroups?: Array<{ Tasks: Array<{ Config: { runtime?: string } }> }> };
    } = {};
    const http: NomadHttp = {
      async request(method, path, body) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          posted = body as typeof posted;
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "a1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 200, text: `${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      trustZones: perTenantTrustZones(),
    });

    await backend.dispatch({ ...JOB, tenant: "acme" });

    expect(posted.Job?.Namespace).toBe("assay-acme");
    expect(posted.Job?.TaskGroups?.[0]?.Tasks[0]?.Config.runtime).toBe("runsc");
  });

  it("trustZones: untrusted 테넌트에 runc 를 강제하면 디스패치를 거부한다", async () => {
    const http: NomadHttp = {
      async request() {
        return { status: 200, text: "{}" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      trustZones: staticTrustZones({}, { id: "weak", isolationRuntime: "runc", network: "open", trusted: false }),
    });
    await expect(backend.dispatch({ ...JOB, tenant: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });

  it("secrets: 잡마다 그 테넌트의 키만 alloc env 에 주입한다 (누출 없음)", async () => {
    const posted: Array<Record<string, string>> = [];
    const http: NomadHttp = {
      async request(method, path, body) {
        if (method === "POST" && path.startsWith("/v1/jobs")) {
          const env = (body as { Job: { TaskGroups: Array<{ Tasks: Array<{ Env: Record<string, string> }> }> } }).Job
            .TaskGroups[0]?.Tasks[0]?.Env;
          posted.push(env ?? {});
          return { status: 200, text: "{}" };
        }
        if (path.includes("/allocations"))
          return { status: 200, text: JSON.stringify([{ ID: "a1", ClientStatus: "complete" }]) };
        if (path.includes("/logs/")) return { status: 200, text: `${RESULT_SENTINEL}${JSON.stringify(RESULT)}\n` };
        return { status: 404, text: "" };
      },
    };
    const backend = new NomadBackend({
      addr: "http://nomad:4646",
      image: "img",
      http,
      pollIntervalMs: 1,
      secrets: staticSecrets({ acme: { ANTHROPIC_API_KEY: "sk-acme" }, globex: { ANTHROPIC_API_KEY: "sk-globex" } }),
    });

    await backend.dispatch({ ...JOB, tenant: "acme" });
    await backend.dispatch({ ...JOB, tenant: "globex" });

    expect(posted[0]?.ANTHROPIC_API_KEY).toBe("sk-acme");
    expect(posted[1]?.ANTHROPIC_API_KEY).toBe("sk-globex"); // globex 의 잡에 acme 키가 새지 않음
  });
});
